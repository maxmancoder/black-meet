# Black Meet — سایت تماس صوتی/تصویری گروهی

یک سیستم تماس گروهی (مشابه Google Meet) با یک پروسه **Node.js** واحد:
Express (سرو صفحات)، Socket.IO (سیگنالینگ + ریل‌تایم) و SQLite (`node:sqlite`).
شامل احراز هویت (شماره/ایمیل + OTP، یا ایمیل + رمز عبور با bcrypt)، مدیریت تماس‌ها،
چت، اشتراک‌گذاری صفحه، ایموجی زنده و کنترل دسترسی مبتنی بر نقش (ادمین/عضو).
هیچ وابستگی به PHP/Apache/MySQL ندارد.

---

## پیش‌نیازها
- **Node.js نسخه ۲۲+** (به‌خاطر `node:sqlite`؛ روی v24 تست شده).
- مرورگر مدرن با پشتیبانی WebRTC + دسترسی میکروفون/دوربین.
- فقط برای تونل عمومی: `bin\cloudflared.exe` (محلی است) و اتصال اینترنت.

---

## اجرا (دوبار کلیک روی `start.bat`)

`start.bat` همه‌چیز را بالا می‌آورد:

| سرویس | فایل | پورت |
|---|---|---|
| اپلیکیشن (صفحات + API + Socket.IO + SQLite) | `server\index.js` | TCP 3000 |
| TURN relay (رسانه بین شبکه‌های مختلف) | `turn.js` | UDP 3478 |
| پراکسی TCP همان TURN | `turn-proxy.js` | TCP 3478 |
| تانل عمومی سایت | `bin\tunnel.ps1` | — |

- **تانل وب** با ترتیب فالبک: **Cloudflare quick tunnel ← SSH (localhost.run) ← SSH (serveo.net)**.
  URL عمومی فقط بعد از سلامت‌سنجی واقعی (`GET /black-meet/login`) منتشر می‌شود،
  در کلیپ‌بورد کپی می‌شود و سایت یک‌بار به‌صورت خودکار در کروم باز می‌شود.
- همیشه در `tunnel_url.txt` (در ریشه پروژه) نوشته می‌شود؛ اگر تانلی نبود، آدرس
  `http://localhost:3000/black-meet/` باز می‌شود.
- **توقف:** کلیدی در پنجره `start.bat` بزنید (همه پروسه‌های BM بسته می‌شوند).
- لاگ‌ها در پوشه `logs/`: `node.log`، `turn.log`، `turn-proxy.log`، `dev_otp.log` و `%TEMP%\bm-tunnel\bmt-chain.log`.

اجرا بدون تانل (مثلاً توسعه داخلی): `node server\index.js`.

---

## حساب مدیر (فقط بار اول روی دیتابیس خالی)
- ساخت حساب مدیر از روی `config.json` (بخش `admin`) یا متغیرهای محیطی `BM_ADMIN_USER` / `BM_ADMIN_PASS` / `BM_ADMIN_EMAIL` / `BM_ADMIN_PHONE` انجام می‌شود؛ **هیچ رمز یا اطلاعات تماسی در کد یا مخزن نیست.**
- اگر هیچ‌کدام تنظیم نشده باشد، ساخت مدیر انجام نمی‌شود و در لاگ پیام `Admin seed skipped` می‌آید.
- مقادیر واقعی خود را فقط در `config.json` محلی (که در `.gitignore` است) یا env پروداکشن نگه دارید.

ورود legacy (متون ساده قدیمی) هم پذیرفته و به‌صورت خودکار به bcrypt ارتقا می‌یابد.

---

## تنظیمات (`config.json`)
- `secret`: کلید HMAC برای توکن سوکت و نشست‌ها.
- `DEV_MODE: true` → کد OTP در پاسخ API و `logs\dev_otp.log` برمی‌گردد (فقط توسعه؛ در پروداکشن `false`).
- `socket_port`، `base_url`، `turn` (کاربر/رمز relay).
- `config.json` در `.gitignore` است؛ مقدار فعلی‌اش را هرگز push نکنید.

---

## نحوه استفاده
1. **ورود:** با ایمیل+رمز، یا شماره موبایل+کد OTP (در `DEV_MODE` کد در خود صفحه دیده می‌شود).
2. **ایجاد تماس:** از داشبورد «ایجاد جلسه جدید»؛ لینک عمومی می‌گیرید.
3. **پیوستن:** لینک/کد تماس را در باکس جستجوی داشبورد وارد کنید (بسته به «حالت ایجاد حساب» مدیر، ثبت‌نام یا آزاد است، یا نیاز به تایید مدیر دارد).
4. **اتاق تماس:** میکروفون/دوربین/اشتراک صفحه، چت زنده، لیست اعضا؛ مدیر می‌تواند عضو را حذف/ساکت/مسدود کند.

---

## سطوح دسترسی، سقف تماس روزانه و حالت ایجاد حساب

- **درجه کاربران** (`server/lib/ranks.js`، ستون `users.rank`):
  | درجه | سقف ساخت جلسه در روز | دسترسی |
  |---|---|---|
  | کاربر عادی (`user`) | ۲ | صفحات شخصی + تماس‌ها |
  | ادمین (`admin`) | ۵ | دیدن اعضا و درخواست‌ها |
  | ادمین پریمیوم (`premium`) | ۱۵ | دیدن/ویرایش اعضا + تایید/رد درخواست‌ها |
  | مدیر اصلی (`blackline`) | نامحدود | همه‌چیز؛ درجه و اطلاعاتش فقط توسط خودش قابل تغییر/مشاهده است |

  سقف سمت سرور در `POST /api/meetings/create` اعمال می‌شود (بر اساس تاریخ محلی، نیمه‌شب ریست؛ خطا شامل `سقف تماس امروز`) و در خانه/ایجاد تماس نمایش داده می‌شود.
- **حالت ایجاد حساب** (`server/lib/settings.js`، کلید `signup_mode` در `bm_settings`)، از منوی بالای «مدیریت اعضا»:
  - **ایجاد حساب آزاد** (پیش‌فرض): ثبت‌نام کامل + OTP.
  - **فقط با تایید مدیر:** اطلاعات در `signup_requests` ذخیره می‌شود، حساب تا تایید ساخته نمی‌شود و متقاضی می‌تواند از همان صفحه با دکمه «شروع چت با مدیر» پیام بفرستد.
  - **غیرفعال:** هیچ حساب جدیدی ساخته نمی‌شود.
- **صفحه «مدیریت اعضا»** (`/members`، سایدبار دو بخشی): لیست کاربران با ویرایش/درجه/محدودیت + لیست درخواست‌های ثبت‌نام با چت، «تایید و فعال‌سازی» و «رد».

---

## ساختار پروژه
```
black-meet/
├─ server/
│  ├─ index.js          نقطه ورود Express + Socket.IO (پورت process.env.PORT یا 3000)
│  ├─ app.js            مونت روت‌ها («/black-meet/*») + استاتیک hardened
│  ├─ sockets.js        سیگنالینگ WebRTC + رویدادهای ریل‌تایم
│  ├─ routes/           pages.js (صفحات EJS + /theme.css) و api.js (REST)
│  ├─ lib/              config, db (SQLite), helpers, sessions, otp, pwd, themes, bus,
│  │                    ranks (درجات + سقف روزانه), settings (حالت ثبت‌نام), schema.sql
│  └─ views/            قالب‌های EJS (فارسی RTL)؛ head.ejs پارشال مشترک، admin_members.ejs پنل مدیریت اعضا
├─ shared/socket-events.js   تک‌منبع نام رویدادهای Socket.IO (BMEv)
├─ assets/
│  ├─ css/styles.css    استایل سفارشی + @font-face + پیش‌فرض رنگ‌های --bm-*
│  ├─ css/tailwind.css  خروجی build (کامیت می‌شود)
│  └─ js/               icons.js, live.js (سوکت مشترک), call.js, auth.js, ...
├─ icons/               sprite.svg (آیکون‌های SVG) + favicon.svg + فایل‌های مبدأ SVG
├─ fonts/               Entezar.ttf, Digi Ghaf Bold.ttf, AFSANEH.ttf, material-symbols.woff2
├─ دیزاین بلک میت/       DESIGN.md + ماکاپ‌ها + فایل‌های تم obsidian_flux.css
├─ bin/tunnel.ps1       زنجیره تانل وب (cloudflared محلی در bin/)
├─ tools/gen-icons.js   بازتولید icons/sprite.svg از فونت Material (fontkit + wawoff2)
├─ turn.js  turn-proxy.js   سرور TURN (UDP) و پراکسی TCP
├─ start.bat            اجرای همه خدمات (دوبار کلیک)
├─ logs/                خروجی لاگ‌ها (در .gitignore)
├─ config.json          تنظیمات (در .gitignore)
└─ black_meet.db        دیتابیس SQLite (در .gitignore)
```

---

## رابط کاربری: آیکون، فونت، تم

- **آیکون‌ها:** سیستم SVG sprite است — فونت/CDNی در کار نیست.
  سرور: `<%- icon('mic', 'cls', fill) %>` (از `pageLocals` در `server/routes/pages.js`)؛
  کلاینت: `bmIcon(name, cls, fill)` / `setBMIcon(el, name, fill)` در `assets/js/icons.js`.
  خروجی همیشه `<svg class="bm-ico"><use href=".../icons/sprite.svg#ic-name"></use></svg>` است.
  بازتولید sprite: `npm i --no-save fontkit wawoff2` سپس `node tools/gen-icons.js`
  (هر `npm install` معمولی این دو پکیج را حذف می‌کند و باید دوباره نصب شوند).
- **فونت‌ها:** متن فارسی `Entezar`، هدلاگ/برند لاتین `Digi Ghaf Bold`،
  `AFSANEH` (نستعلیق) فقط با کلاس `.font-brand` (فعلاً جایی استفاده نمی‌شود).
  فونت‌ها محلی و در `fonts/` هستند؛ CDN گوگل حذف شده (فیلتر).
- **تم:** رنگ‌های Tailwind به متغیر `--bm-*` وصل‌اند. پیش‌فرض‌ها در `:root`
  داخل `assets/css/styles.css` است و فایل‌های `دیزاین بلک میت/<id>.css` روشان می‌شوند.
  روت‌ها: `GET /black-meet/theme.css` (کوکی `bm_theme`) و `GET /black-meet/api/themes`.
  برای افزودن تم: فایل CSS جدید در `دیزاین بلک میت/` بگذارید و `bm_theme=<id>` ست کنید.
- **Tailwind:** بعد از افزودن کلاس جدید: `npm run tailwind:build`.

---

## امنیت
- رمزها با `bcryptjs`؛ نشست‌ها SQLite (`bm_sessions`) با کوکی httpOnly + SameSite=Lax
  و CSRF (توکن ۳۲هگز در نشست) روی همه POSTها.
- توکن سوکت با HMAC و TTL ۲۴ ساعت (`makeSocketToken`/`verifySocketToken`).
- خروجی EJS escape می‌شود؛ آپلود آواتار MIME + سقف ۲ مگابایت (multer).
- فایل‌های حساس (`config.json`, `.env`, `tunnel_url.txt`, `dev_otp.log`, `black_meet.db*`)
  در `.gitignore` هستند؛ قبل از push اگر tracked شده‌اند `git rm --cached` بزنید.

---

## عیب‌یابی
- **تماس برقرار نمی‌شود (میان NAT):** `turn.js` و `turn-proxy.js` باید روی 3478
  اجرا باشند (`start.bat` این کار را می‌کند)؛ فالبک آزاد `openrelay.metered.ca`
  هم در `turnConfig()` هست.
- **تانل عمومی نمی‌آید:** لاگ `%TEMP%\bm-tunnel\bmt-chain.log` را ببینید؛
  در برخی شبکه‌ها SSH (localhost.run/serveo) resolve نمی‌شود و فقط Cloudflare کار می‌کند —
  زنجیره خودش تا سالم شدن CF تلاش می‌کند.
- **صدا/تصویر نمی‌آید:** دسترسی میکروفون/دوربین را بدهید؛ روی URL عمومی **https**
  مرورگر دسترسی می‌دهد (روی http فقط `localhost` استثناست).
- **تغییرات CSS دیده نمی‌شود:** همه URLها با `asset_url()`/`asset()` ساخته شوند
  (‎`?v=mtime` می‌گیرند)؛ مسیرهای hardcode کلاسیک‌ترین باگ است.
- **تست بصری:** `npm i --no-save puppeteer-core` و اسکرین‌شات با کروم سیستم
  (`C:\Program Files\Google\Chrome\Application\chrome.exe`) گرفته می‌شود؛
  این پکیج هم با `npm install` بعدی حذف می‌شود.
