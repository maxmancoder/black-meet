// assets/js/emoji-sfx.js — procedural "ear-candy" sound for every call emoji.
// No audio files (CDNs are blocked in Iran and the app ships zero external assets):
// each emoji maps to a small recipe that is synthesised with the Web Audio API.
(function () {
  'use strict';

  let ctx = null;
  let master = null;
  let wet = null;
  let failed = false;

  function ensure() {
    if (failed) return null;
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { failed = true; return null; }
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.22;
      master.connect(ctx.destination);
      // cheap stereo-ish "room" so the chimes feel warm instead of dry
      wet = ctx.createGain();
      wet.gain.value = 0.16;
      const delay = ctx.createDelay(0.4);
      delay.delayTime.value = 0.085;
      const fb = ctx.createGain();
      fb.gain.value = 0.22;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2600;
      wet.connect(delay);
      delay.connect(lp);
      lp.connect(fb);
      fb.connect(delay);
      lp.connect(master);
    } catch (e) {
      failed = true;
      return null;
    }
    return ctx;
  }

  // one synth note
  function note(o) {
    if (!ctx) return;
    const t0 = ctx.currentTime + (o.at || 0);
    const dur = o.dur || 0.18;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = o.cut || 5200;
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t0);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t0 + dur * (o.glide || 1));
    if (o.detune) osc.detune.value = o.detune;
    const vol = (o.vol == null ? 1 : o.vol);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + (o.atk || 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(filt);
    filt.connect(g);
    g.connect(master);
    if (o.send !== false) g.connect(wet);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // filtered noise burst (claps / whooshes)
  function noise(o) {
    if (!ctx) return;
    const t0 = ctx.currentTime + (o.at || 0);
    const dur = o.dur || 0.12;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = o.type || 'bandpass';
    bp.frequency.value = o.f || 2400;
    bp.Q.value = o.q || 1.1;
    const g = ctx.createGain();
    g.gain.value = (o.vol == null ? 0.5 : o.vol);
    src.connect(bp);
    bp.connect(g);
    g.connect(master);
    if (o.send !== false) g.connect(wet);
    src.start(t0);
  }

  // scale helper: 0 = C
  function n(semi) { return 261.63 * Math.pow(2, semi / 12); }

  // C major pentatonic-ish base for pleasant, never-sour results
  const P = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

  const RECIPES = {
    // thumbs-up: bright confident ding
    '👍': () => { note({ f: n(P[7]), dur: 0.16, type: 'triangle', vol: 0.9 }); note({ f: n(P[10]), at: 0.09, dur: 0.22, type: 'sine', vol: 0.7 }); },
    // heart: soft warm two-tone
    '❤️': () => { note({ f: n(P[3]), dur: 0.26, type: 'sine', vol: 0.85 }); note({ f: n(P[7]), at: 0.12, dur: 0.3, type: 'sine', vol: 0.6 }); note({ f: n(P[10]), at: 0.22, dur: 0.34, type: 'triangle', vol: 0.35 }); },
    // clap: three crisp claps
    '👏': () => { for (let i = 0; i < 3; i++) noise({ at: i * 0.085, dur: 0.09, f: 2600, q: 0.8, vol: 0.55 - i * 0.08 }); note({ f: 1400 + i * 120, at: i * 0.085, dur: 0.06, type: 'square', vol: 0.12, cut: 3000 }); },
    // laugh: bouncy rising triplet
    '😂': () => { [0, 4, 7, 12].forEach((s, i) => note({ f: n(s + 7), at: i * 0.055, dur: 0.11, type: 'triangle', vol: 0.55, glide: 1, f2: n(s + 9 + 7) })); },
    // party: sparkly arpeggio
    '🎉': () => { [0, 4, 7, 12, 16].forEach((s, i) => note({ f: n(s + 4), at: i * 0.06, dur: 0.2, type: 'triangle', vol: 0.6 })); noise({ at: 0.3, dur: 0.4, f: 5200, q: 0.5, vol: 0.16 }); },
    // wow: quick glide up + shimmer
    '😮': () => { note({ f: 420, f2: 1250, dur: 0.22, type: 'sawtooth', vol: 0.35, cut: 3200 }); note({ f: n(P[10]), at: 0.18, dur: 0.26, type: 'sine', vol: 0.5 }); },
    // fire: warm roar + crackle
    '🔥': () => { noise({ dur: 0.45, f: 700, q: 0.4, type: 'lowpass', vol: 0.4 }); note({ f: 110, f2: 70, dur: 0.4, type: 'sawtooth', vol: 0.22, cut: 700 }); for (let i = 0; i < 4; i++) noise({ at: 0.12 + i * 0.07, dur: 0.05, f: 3600, q: 1.4, vol: 0.16 }); },
    // check: clean double blip
    '✅': () => { note({ f: n(P[7]), dur: 0.09, type: 'square', vol: 0.35, cut: 3600 }); note({ f: n(P[12]), at: 0.1, dur: 0.16, type: 'square', vol: 0.35, cut: 3600 }); },
    // thanks: gentle low bow
    '🙏': () => { note({ f: n(P[2]), dur: 0.3, type: 'sine', vol: 0.8 }); note({ f: n(P[7]), at: 0.14, dur: 0.36, type: 'sine', vol: 0.45 }); },
    // idea: rising light bulb ping
    '💡': () => { note({ f: n(P[5]), dur: 0.1, type: 'sine', vol: 0.4 }); note({ f: n(P[9]), at: 0.09, dur: 0.14, type: 'sine', vol: 0.4 }); note({ f: n(P[14]), at: 0.18, dur: 0.32, type: 'triangle', vol: 0.55 }); },
    // cool: cool descending dip
    '😎': () => { note({ f: n(P[9]), dur: 0.16, type: 'triangle', vol: 0.5 }); note({ f: n(P[7]), at: 0.1, dur: 0.16, type: 'triangle', vol: 0.45 }); note({ f: n(P[5]), at: 0.2, dur: 0.3, type: 'sine', vol: 0.55 }); },
    // star: shimmer sparkle
    '🌟': () => { note({ f: n(P[14]), dur: 0.14, type: 'sine', vol: 0.45 }); note({ f: n(P[16]), at: 0.07, dur: 0.14, type: 'sine', vol: 0.4 }); note({ f: n(P[21]), at: 0.14, dur: 0.38, type: 'triangle', vol: 0.5 }); noise({ at: 0.14, dur: 0.28, f: 6800, q: 0.6, vol: 0.1 }); },
  };

  // sensible default for any emoji the app adds later
  function fallback(em) {
    let h = 0;
    for (let i = 0; i < em.length; i++) h = (h * 31 + em.charCodeAt(i)) & 0xffff;
    const s = P[h % P.length];
    note({ f: n(s + 7), dur: 0.18, type: 'triangle', vol: 0.5 });
    note({ f: n(s + 12), at: 0.08, dur: 0.24, type: 'sine', vol: 0.35 });
  }

  let lastAt = 0;
  window.bmEmojiSfx = function (em) {
    const c = ensure();
    if (!c) return;
    const now = performance.now();
    // burst protection: a wall of emojis must not turn into a wall of noise
    if (now - lastAt < 90) return;
    lastAt = now;
    try {
      const r = RECIPES[em];
      if (r) r(); else fallback(em);
    } catch (e) { /* audio is decorative — never break the call over it */ }
  };

  // unlock on the first user gesture (autoplay policy)
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => {
    window.addEventListener(ev, function unlock() {
      ensure();
    }, { once: true, passive: true });
  });
})();
