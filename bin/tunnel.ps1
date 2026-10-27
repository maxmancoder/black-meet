# tunnel.ps1 - public website tunnel watchdog with automatic fallback.
# Order: Cloudflare (default) -> SSH (localhost.run) -> SSH (serveo.net) -> local only.
# The loop runs forever: a dead/failing tunnel is killed and the next method is
# tried; after serveo fails we wait and go back to Cloudflare. While no tunnel is
# up, tunnel_url.txt is empty and the app falls back to http://localhost:3000.
#
# tunnel_url.txt always holds the CURRENT public URL (only after it passed a
# health check through the tunnel):
#   cloudflare -> https://<sub>.trycloudflare.com/black-meet/
#   ssh        -> https://<sub>.lhr.life/black-meet/
#   ssh/serveo -> https://<sub>.serveousercontent.com/black-meet/
#
# The first healthy URL is copied to the clipboard. The browser is opened by
# start.bat (single source), not here.

$mutex = New-Object System.Threading.Mutex($false, 'Global\BMTunnelChain')
# a force-killed predecessor abandons the mutex -> WaitOne throws; we still own it
try { if (-not $mutex.WaitOne(0)) { exit } } catch [System.Threading.AbandonedMutexException] {}

$root     = Split-Path -Parent $PSScriptRoot
$urlFile  = Join-Path $root 'tunnel_url.txt'
$tmpDir   = Join-Path $env:TEMP 'bm-tunnel'
$ssh      = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
$cfExe    = $null
foreach ($cand in @((Join-Path $root 'bin\cloudflared.exe'), (Join-Path $root 'bin\cloudflare.exe'))) {
    if (Test-Path $cand) { $cfExe = $cand; break }
}
$chainLog = Join-Path $tmpDir 'bmt-chain.log'
$appPort  = 3000
try { New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null } catch {}

function Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    try { Add-Content -LiteralPath $chainLog -Value $line -Encoding utf8 } catch {}
}

function Get-UrlFile { try { return (Get-Content $urlFile -Raw -ErrorAction Stop).Trim() } catch { return '' } }
function Set-UrlFile([string]$u) { try { Set-Content -LiteralPath $urlFile -Value $u -Encoding ascii } catch {} }
function Clear-UrlFile { Set-UrlFile '' }

function Test-Http([string]$u) {
    if (-not $u) { return $false }
    $base = $u.TrimEnd('/')
    # stored URLs already end with /black-meet/ -> append /login; tolerate bare-host URLs too
    foreach ($tail in @('/login', '/black-meet/login')) {
        try {
            $r = Invoke-WebRequest -Uri ($base + $tail) -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
            if ($r.StatusCode -eq 200) { return $true }
        } catch {}
    }
    return $false
}

function Get-NewestHost([string]$logPath, [string]$re) {
    try {
        $txt = Get-Content $logPath -Raw -ErrorAction SilentlyContinue
        if (-not $txt) { return $null }
        $m = [regex]::Matches($txt, $re)
        if ($m.Count -gt 0) { return $m[$m.Count - 1].Groups[1].Value }
    } catch {}
    return $null
}

# publish a URL only once it actually serves the site through the tunnel
function Publish-Healthy([string]$u) {
    if (-not $u) { return $false }
    $deadline = (Get-Date).AddSeconds(35)
    while ((Get-Date) -lt $deadline) {
        if (Test-Http $u) {
            Set-UrlFile $u
            try { Set-Clipboard -Value $u } catch {}
            Log ("URL " + $u + " (copied to clipboard)")
            return $true
        }
        Start-Sleep -Seconds 3
    }
    return $false
}

# ---- method 1: Cloudflare quick tunnel (default) ----
function Start-CfTunnel {
    if (-not $cfExe) { Log 'CF : cloudflared.exe missing in bin\ - skipping'; return $false }
    Log 'CF : starting cloudflared quick tunnel'
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $log = Join-Path $tmpDir ("cf-" + $stamp + ".log")
    $p = Start-Process -FilePath $cfExe -PassThru -WindowStyle Hidden `
            -ArgumentList 'tunnel','--url',('http://127.0.0.1:' + $appPort),'--no-autoupdate','--loglevel','info',('--logfile=' + $log) `
            -RedirectStandardOutput ($log + '.out') -RedirectStandardError ($log + '.err')
    if ($null -eq $p) { Log 'CF : failed to launch cloudflared'; return $false }

    $deadline = (Get-Date).AddSeconds(60)
    $host2 = $null
    while ((Get-Date) -lt $deadline -and -not $p.HasExited) {
        Start-Sleep -Seconds 3
        $host2 = Get-NewestHost $log 'https://([a-z0-9-]+\.trycloudflare\.com)'
        if ($host2) { break }
    }
    if (-not $host2) {
        Log 'CF : no public URL within 60s - edge unreachable'
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
        Clear-UrlFile
        Start-Sleep -Seconds 2
        return $false
    }
    if (-not (Publish-Healthy ("https://" + $host2 + "/black-meet/")) -and -not $p.HasExited) {
        Log 'CF : tunnel URL never became healthy - retrying briefly'
        # quick tunnel sometimes needs a moment; give it one more pass
        if (-not (Publish-Healthy ("https://" + $host2 + "/black-meet/"))) {
            try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
            Clear-UrlFile
            Start-Sleep -Seconds 2
            return $false
        }
    }

    $fails = 0
    while (-not $p.HasExited -and $fails -lt 2) {
        Start-Sleep -Seconds 10
        if (Test-Http (Get-UrlFile)) { $fails = 0 } else { $fails++ }
    }
    try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    Clear-UrlFile
    Log 'CF : failed - switching to SSH'
    Start-Sleep -Seconds 2
    return $false
}

# ---- method 2: SSH localhost.run ----
function Start-SshTunnel {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $log = Join-Path $tmpDir ("ssh-" + $stamp + ".log")
    foreach ($f in @($log, $log + '.err')) { if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue } }
    Log 'SSH: starting localhost.run tunnel'
    $p = Start-Process -FilePath $ssh -PassThru -WindowStyle Hidden `
            -ArgumentList '-o','StrictHostKeyChecking=no','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3','-R',('80:localhost:' + $appPort),'nokey@localhost.run' `
            -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')
    if ($null -eq $p) { Log 'SSH: failed to launch ssh'; return $false }

    $deadline = (Get-Date).AddSeconds(45)
    $published = $false
    while ((Get-Date) -lt $deadline -and -not $p.HasExited -and -not $published) {
        Start-Sleep -Seconds 3
        $h = Get-NewestHost $log '([a-z0-9]+\.lhr\.life) tunneled'
        if ($h) { $published = Publish-Healthy ("https://" + $h + "/black-meet/") }
    }
    if (-not $published) {
        Log 'SSH: no healthy URL within 45s'
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
        Clear-UrlFile
        Start-Sleep -Seconds 2
        return $false
    }

    $fails = 0
    while (-not $p.HasExited -and $fails -lt 2) {
        Start-Sleep -Seconds 10
        # localhost.run rotates the subdomain on reconnect while ssh stays up -> always re-parse
        $h2 = Get-NewestHost $log '([a-z0-9]+\.lhr\.life) tunneled'
        if ($h2) {
            $newUrl = "https://" + $h2 + "/black-meet/"
            if ((Get-UrlFile) -ne $newUrl) {
                if (Test-Http $newUrl) { Set-UrlFile $newUrl; try { Set-Clipboard -Value $newUrl } catch {}; Log ("SSH: URL " + $newUrl) }
            }
        }
        if (Test-Http (Get-UrlFile)) { $fails = 0 } else { $fails++ }
    }
    try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    Clear-UrlFile
    Log 'SSH: failed - switching to serveo'
    Start-Sleep -Seconds 2
    return $false
}

# ---- method 3: serveo.net (plain-https via ssh) ----
function Start-ServeoTunnel {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $log = Join-Path $tmpDir ("serveo-" + $stamp + ".log")
    foreach ($f in @($log, $log + '.err')) { if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue } }
    Log 'SERVEO: starting serveo.net tunnel (ssh fallback)'
    $p = Start-Process -FilePath $ssh -PassThru -WindowStyle Hidden `
            -ArgumentList '-N','-o','StrictHostKeyChecking=no','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3','-o','ExitOnForwardFailure=yes','-R',('80:localhost:' + $appPort),'serveo.net' `
            -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')
    if ($null -eq $p) { Log 'SERVEO: failed to launch ssh'; return $false }

    $deadline = (Get-Date).AddSeconds(40)
    $url2 = $null
    while ((Get-Date) -lt $deadline -and -not $p.HasExited -and -not $url2) {
        Start-Sleep -Seconds 3
        $u = Get-NewestHost $log 'Forwarding HTTP traffic from (https://[A-Za-z0-9.-]+\.serveousercontent\.com)'
        if ($u) { if (Publish-Healthy ($u + '/black-meet/')) { $url2 = $u } }
    }
    if (-not $url2) {
        Log 'SERVEO: no healthy URL within 40s'
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
        Clear-UrlFile
        Start-Sleep -Seconds 2
        return $false
    }

    $fails = 0
    while (-not $p.HasExited -and $fails -lt 2) {
        Start-Sleep -Seconds 10
        if (Test-Http (Get-UrlFile)) { $fails = 0 } else { $fails++ }
    }
    try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    Clear-UrlFile
    Log 'SERVEO: failed - no public tunnel right now (local only)'
    return $false
}

# ---- startup cleanup: make sure we own the website tunnel ----
# kill OTHER tunnel.ps1 / keep-tunnel-chain instances (exactly one chain alive),
# any leftover ssh watchers, and any leftover cloudflared quick tunnels.
try {
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { ($_.CommandLine -match 'tunnel\.ps1' -or $_.CommandLine -match 'keep-tunnel-chain\.ps1') -and $_.ProcessId -ne $PID } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
} catch {}
try {
    Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'localhost\.run' -or $_.CommandLine -match 'serveo\.net' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
} catch {}
try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'cloudflared?\.exe' -and $_.CommandLine -match '\-\-url' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
} catch {}

Clear-UrlFile
Log '=== chain started: cloudflare -> localhost.run -> serveo -> (local) ==='

# ---- main chain ----
while ($true) {
    # QUIC edge dials flake on some networks -> give Cloudflare one immediate retry
    # before wasting a minute on the SSH methods (which need DNS for localhost.run).
    if (-not (Start-CfTunnel)) { Start-CfTunnel }
    Start-SshTunnel
    Start-ServeoTunnel
    Log 'all public methods failed - local only for 30s'
    Start-Sleep -Seconds 30
}
