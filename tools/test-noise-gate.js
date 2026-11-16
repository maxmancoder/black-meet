// Standalone check of the microphone noise gate that call.js ships.
// No dependency and no browser: the shipped gate core is extracted from
// assets/js/call.js and run over synthetic room noise and speech, then the
// attenuation of the room and the transparency of the voice are asserted.
//   node tools/test-noise-gate.js
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ck(name, ok, extra) {
  if (ok) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
function db(x) { return 20 * Math.log10(Math.max(x, 1e-12)); }
function rms(a) {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length);
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const src = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'call.js'), 'utf8');
// call.js builds the module as GATE_CORE_SRC + <worklet wrapper>; rebuild it the same way.
const m = src.match(/const GATE_CORE_SRC = `([\s\S]*?)`;\n  const GATE_WORKLET_SRC = GATE_CORE_SRC \+ `([\s\S]*?)`;/);
ck('worklet source found in call.js', !!m);
if (!m) process.exit(1);
const coreSrc = m[1];
const worklet = m[1] + m[2];
ck('worklet registers bm-noise-gate', /registerProcessor\('bm-noise-gate'/.test(worklet));
ck('worklet has no broken interpolation', worklet.indexOf('${') === -1);

// presets must match NS_LEVELS in call.js exactly
const srcLevels = src.match(/const NS_LEVELS = \{([\s\S]*?)\n  \};/);
ck('NS_LEVELS found in call.js', !!srcLevels);
const nsText = srcLevels ? srcLevels[1] : '';
const LEVELS = {};
for (const key of ['soft', 'strong', 'max']) {
  const lm = nsText.match(new RegExp(key + ':\\s*\\{([^}]*)\\}'));
  if (!lm) continue;
  const o = {};
  lm[1].split(',').forEach((part) => {
    const mm = part.match(/(\w+)\s*:\s*(-?[\d.]+)/);
    if (mm) o[mm[1]] = Number(mm[2]);
  });
  LEVELS[key] = o;
}
ck('three presets parsed from call.js', Object.keys(LEVELS).length === 3, JSON.stringify(Object.keys(LEVELS)));
ck('strong preset has the new shape', !!(LEVELS.strong && LEVELS.strong.minThrDb !== undefined && LEVELS.strong.openDb !== undefined));

const SR = 48000;
const registered = {};
global.sampleRate = SR;
global.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {} }; } };
global.registerProcessor = (name, cls) => { registered[name] = cls; };
eval(worklet);
const Gate = registered['bm-noise-gate'];
ck('processor class registered', typeof Gate === 'function');
ck('processor exposes 5 AudioParams', Gate.parameterDescriptors.length === 5);
const names = Gate.parameterDescriptors.map((d) => d.name).join(',');
ck('param names are threshold,maxThreshold,floor,openK,ratio', names === 'threshold,maxThreshold,floor,openK,ratio', names);

const dbToGain = (d) => Math.pow(10, d / 20);

function params(cfg) {
  return {
    threshold: [dbToGain(cfg.minThrDb)],
    maxThreshold: [dbToGain(cfg.maxThrDb)],
    floor: [dbToGain(cfg.floorDb)],
    openK: [Math.pow(10, cfg.openDb / 20)],
    ratio: [cfg.ratio],
  };
}

function run(level, signal, opts) {
  const g = new Gate();
  const p = params(LEVELS[level]);
  const out = new Float32Array(signal.length);
  const block = 128;
  const trace = [];
  for (let off = 0; off + block <= signal.length; off += block) {
    const inp = [signal.subarray(off, off + block)];
    const o = [new Float32Array(block)];
    g.process([inp], [o], p);
    out.set(o[0], off);
    if (opts && opts.trace && off % SR === 0) {
      trace.push({ t: off / SR, env: db(g.env), gain: db(g.gain) });
    }
  }
  if (opts && opts.trace) opts.trace.value = trace;
  return out;
}
// live retune: change a param mid-stream (what gateTune/retuneMicChain does)
function runRetuned(levelA, levelB, switchAtSec, signal) {
  const g = new Gate();
  const out = new Float32Array(signal.length);
  const block = 128;
  const switchAt = switchAtSec * SR;
  for (let off = 0; off + block <= signal.length; off += block) {
    const p = params(off >= switchAt ? LEVELS[levelB] : LEVELS[levelA]);
    const o = [new Float32Array(block)];
    g.process([[signal.subarray(off, off + block)]], [o], p);
    out.set(o[0], off);
  }
  return out;
}

function noiseSignal(seconds, amp) {
  const n = Math.round(SR * seconds);
  const a = new Float32Array(n);
  const rnd = mulberry32(12345);
  for (let i = 0; i < n; i++) a[i] = (rnd() * 2 - 1) * amp;
  return a;
}

function speechSignal(seconds, amp) {
  const n = Math.round(SR * seconds);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
    a[i] = amp * env * (0.7 * Math.sin(2 * Math.PI * 180 * t) + 0.3 * Math.sin(2 * Math.PI * 700 * t));
  }
  return a;
}

if (process.argv.includes('--trace')) {
  const noise = noiseSignal(5, 0.02);
  const tr = {};
  run('strong', noise, { trace: tr });
  tr.value.forEach((r) => console.log('t=' + r.t + 's env=' + r.env.toFixed(1) + ' gain=' + r.gain.toFixed(1)));
  process.exit(0);
}

// ---- 1. quiet room noise (~-53 dBFS RMS) must be crushed
{
  const noise = noiseSignal(5, 0.004);
  const out = run('strong', noise);
  const att = db(rms(out.subarray(SR * 2))) - db(rms(noise.subarray(SR * 2)));
  ck('quiet room noise attenuated > 30 dB (strong)', att < -30, 'atten=' + att.toFixed(1) + ' dB');
}

// ---- 2. loud room noise (~-39 dBFS RMS) must be crushed just as hard
{
  const noise = noiseSignal(5, 0.02);
  const out = run('strong', noise);
  const att = db(rms(out.subarray(SR * 2))) - db(rms(noise.subarray(SR * 2)));
  ck('loud room noise attenuated > 30 dB (strong)', att < -30, 'atten=' + att.toFixed(1) + ' dB');
}

// ---- 2b. a very noisy room (fan + street, ~-27 dBFS) is still gated
{
  const noise = noiseSignal(5, 0.09);
  const out = run('strong', noise);
  const att = db(rms(out.subarray(SR * 2))) - db(rms(noise.subarray(SR * 2)));
  ck('very loud room attenuated > 25 dB (strong)', att < -25, 'atten=' + att.toFixed(1) + ' dB');
}

// ---- 3. speech must pass nearly untouched
{
  const speech = speechSignal(3, 0.25);
  const out = run('strong', speech);
  const att = db(rms(out.subarray(SR * 1))) - db(rms(speech.subarray(SR * 1)));
  ck('speech passes within 3 dB', Math.abs(att) < 3, 'delta=' + att.toFixed(1) + ' dB');
}

// ---- 4. speech AFTER a long noise bed (adaptive threshold must not block it)
{
  const bed = noiseSignal(5, 0.006);
  const speech = speechSignal(2, 0.25);
  const mixed = new Float32Array(bed.length + speech.length);
  mixed.set(bed, 0);
  mixed.set(speech, bed.length);
  const out = run('strong', mixed);
  const from = bed.length + 4800;
  const att = db(rms(out.subarray(from))) - db(rms(mixed.subarray(from)));
  ck('speech after a noise bed still passes (<=3 dB)', att > -3 && att < 3, 'delta=' + att.toFixed(1) + ' dB');
}

// ---- 4b. and the noise bed itself, before the speech, stays gated
{
  const bed = noiseSignal(5, 0.006);
  const speech = speechSignal(2, 0.25);
  const mixed = new Float32Array(bed.length + speech.length);
  mixed.set(bed, 0);
  mixed.set(speech, bed.length);
  const out = run('strong', mixed);
  const att = db(rms(out.subarray(SR * 2, SR * 4))) - db(rms(mixed.subarray(SR * 2, SR * 4)));
  ck('noise under the speech bed attenuated > 30 dB', att < -30, 'atten=' + att.toFixed(1) + ' dB');
}

// ---- 5. level presets: max must cut noise harder than strong, strong harder than soft
{
  const n2 = noiseSignal(5, 0.01);
  const base = db(rms(n2.subarray(SR * 2)));
  const soft = db(rms(run('soft', n2).subarray(SR * 2))) - base;
  const strong = db(rms(run('strong', n2).subarray(SR * 2))) - base;
  const max = db(rms(run('max', n2).subarray(SR * 2))) - base;
  ck('max cuts noise harder than strong', max < strong - 3, 'strong=' + strong.toFixed(1) + ' max=' + max.toFixed(1));
  ck('strong cuts noise harder than soft', strong < soft - 3, 'soft=' + soft.toFixed(1) + ' strong=' + strong.toFixed(1));
  ck('soft still attenuates > 10 dB', soft < -10, 'soft=' + soft.toFixed(1));
}

// ---- 6. digital silence stays silent
{
  const z = run('strong', new Float32Array(SR * 2));
  ck('digital silence stays silent', rms(z) === 0);
}

// ---- 6b. no NaN / no blown output on a full-scale input
{
  const loud = new Float32Array(SR);
  for (let i = 0; i < SR; i++) loud[i] = i % 2 ? 0.99 : -0.99;
  const out = run('strong', loud);
  let bad = 0;
  for (let i = 0; i < out.length; i++) if (!isFinite(out[i])) bad++;
  ck('full-scale input stays finite', bad === 0);
  ck('full-scale input is not amplified', rms(out) <= rms(loud) * 1.0001);
}

// ---- 7. attack keeps the start of a syllable (no chopped words)
{
  const b = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) b[i] = 0.25 * Math.sin(2 * Math.PI * 200 * i / SR);
  const out = run('strong', b);
  const d = db(rms(out.subarray(0, 1024))) - db(rms(b.subarray(0, 1024)));
  ck('attack keeps the first 21 ms of a syllable (>-6 dB)', d > -6, 'delta=' + d.toFixed(1) + ' dB');
}

// ---- 7b. a syllable that starts AFTER the gate has closed still opens fast
{
  const pre = noiseSignal(3, 0.01);
  const burst = new Float32Array(SR);
  for (let i = 0; i < SR; i++) burst[i] = 0.3 * Math.sin(2 * Math.PI * 300 * i / SR);
  const sig = new Float32Array(pre.length + burst.length);
  sig.set(pre, 0); sig.set(burst, pre.length);
  const out = run('strong', sig);
  const first = out.subarray(pre.length, pre.length + 960); // first 20 ms of the syllable
  const d = db(rms(first)) - db(rms(burst.subarray(0, 960)));
  ck('a syllable after silence is not swallowed (>-9 dB in first 20 ms)', d > -9, 'delta=' + d.toFixed(1) + ' dB');
  const later = out.subarray(pre.length + 4800, pre.length + 14400);
  const d2 = db(rms(later)) - db(rms(burst.subarray(4800, 14400)));
  ck('the rest of that syllable is fully open (>-2 dB)', d2 > -2, 'delta=' + d2.toFixed(1) + ' dB');
}

// ---- 8. live retune (soft -> max) changes the behaviour without a restart
{
  const n2 = noiseSignal(8, 0.01);
  const out = runRetuned('soft', 'max', 4, n2);
  const a = db(rms(out.subarray(SR * 2, SR * 4)));
  const b = db(rms(out.subarray(SR * 5, SR * 7)));
  ck('switching to max mid-call cuts noise harder', b < a - 10, 'soft=' + a.toFixed(1) + ' max=' + b.toFixed(1));
}

console.log('\n' + pass + '/' + (pass + fail) + ' checks passed');
process.exit(fail ? 1 : 0);
