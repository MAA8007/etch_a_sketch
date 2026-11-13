/* Shared by both modes: share links, reply threads, guessing, saving, photo import. */
(function () {
  "use strict";

  // Index 0 is an empty cell. Never reorder: share links store these indices.
  const PAL = [null,
    "#2b2b33", "#ff4d6d", "#ff8fab", "#ffb38a", "#ffd166", "#06d6a0", "#4cc9f0", "#4361ee", "#9b5de5", "#8d5a3b", "#adb5bd", "#ffffff",
    "#4a2c22", "#c88b65", "#f1cfae", "#f4845f", "#9d0208", "#2d6a4f", "#95d5b2", "#1d3557", "#cdb4db", "#6c757d", "#dee2e6", "#caf0f8"];
  const NAMES = ["", "Ink", "Red", "Pink", "Peach", "Yellow", "Mint", "Sky", "Blue", "Purple", "Brown", "Grey", "White",
    "Espresso", "Tan", "Sand", "Orange", "Wine", "Forest", "Sage", "Navy", "Lilac", "Slate", "Silver", "Ice"];
  const PIXEL_BG = "#fffdfb";
  const TOY = { W: 800, H: 600, M: 3, page: "#f7efe6", red: "#d81e1e", gold: "#f0c45a", screen: "#c9cac3", line: "#2e2f33", knob: "#f1f1f1" };
  const MAX_THREAD = 8, MAX_LINK = 7000;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const $ = id => document.getElementById(id);
  const later = () => new Promise(r => setTimeout(r, 0));
  const hexRgb = h => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };

  /* ---------- Link format ----------
     Byte 0 is the version. 1 and 2 are the old single-drawing links (toy and pixel), still readable.
     3 is a thread: a list of drawings, oldest first, each with its kind, note and optional answer. */
  function pushVarint(out, n) { while (n > 127) { out.push((n & 127) | 128); n >>>= 7; } out.push(n); }
  function readVarint(buf, st) {
    let n = 0, s = 0, b;
    do { if (st.i >= buf.length || s > 28) throw new Error("bad link"); b = buf[st.i++]; n |= (b & 127) << s; s += 7; } while (b & 128);
    return n >>> 0;
  }
  const zig = n => (n << 1) ^ (n >> 31), unzig = n => (n >>> 1) ^ -(n & 1);
  function pushText(out, s) { const b = new TextEncoder().encode(s || ""); pushVarint(out, b.length); b.forEach(x => out.push(x)); }
  function readText(buf, st) {
    const n = readVarint(buf, st);
    if (st.i + n > buf.length) throw new Error("bad link");
    const s = new TextDecoder().decode(buf.slice(st.i, st.i + n)); st.i += n; return s;
  }
  const toB64 = bytes => { let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const fromB64 = str => { const s = atob(str.replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, c => c.charCodeAt(0)); };
  async function pipe(bytes, Stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new Stream("deflate-raw"))).arrayBuffer()); }

  function readToyPts(buf, st) {
    const n = Math.min(readVarint(buf, st), 200000), pts = [];
    let x = 0, y = 0;
    for (let k = 0; k < n; k++) {
      x += unzig(readVarint(buf, st)); y += unzig(readVarint(buf, st));
      pts.push([clamp(x, TOY.M, TOY.W - TOY.M), clamp(y, TOY.M, TOY.H - TOY.M)]);
    }
    if (pts.length < 2) throw new Error("bad link");
    return pts;
  }
  function readPixelSeq(buf, st, n) {
    const count = Math.min(readVarint(buf, st), n * n * 4), seq = [];
    let i = 0;
    for (let k = 0; k < count; k++) {
      i += unzig(readVarint(buf, st));
      if (st.i >= buf.length) throw new Error("bad link");
      const c = buf[st.i++];
      if (i >= 0 && i < n * n && c > 0 && c < PAL.length) seq.push([i, c]);
    }
    if (!seq.length) throw new Error("bad link");
    return seq;
  }
  function writeEntry(out, e) {
    out.push(e.kind === "toy" ? 1 : 2, e.answer ? 1 : 0);
    pushText(out, e.note);
    if (e.answer) pushText(out, e.answer);
    if (e.kind === "toy") {
      pushVarint(out, e.pts.length);
      let px = 0, py = 0;
      for (const [x, y] of e.pts) { pushVarint(out, zig(x - px)); pushVarint(out, zig(y - py)); px = x; py = y; }
    } else {
      out.push(e.n); pushVarint(out, e.photoK || 0); pushVarint(out, e.seq.length);
      let prev = 0;
      for (const [i, c] of e.seq) { pushVarint(out, zig(i - prev)); out.push(c); prev = i; }
    }
  }
  function readEntry(buf, st) {
    if (st.i + 2 > buf.length) throw new Error("bad link");
    const kind = buf[st.i++], flags = buf[st.i++];
    const note = readText(buf, st).slice(0, 140);
    const answer = flags & 1 ? readText(buf, st).slice(0, 60) : "";
    if (kind === 1) return { kind: "toy", note, answer, pts: readToyPts(buf, st) };
    if (kind === 2) {
      const n = clamp(buf[st.i++] || 0, 4, 64), photoK = readVarint(buf, st), seq = readPixelSeq(buf, st, n);
      return { kind: "pixel", note, answer, n, photoK: Math.min(photoK, seq.length), seq };
    }
    throw new Error("bad link");
  }
  async function encodeThread(entries) {
    const out = [3];
    pushVarint(out, entries.length);
    entries.forEach(e => writeEntry(out, e));
    const raw = new Uint8Array(out);
    if (window.CompressionStream) { try { return "z" + toB64(await pipe(raw, CompressionStream)); } catch (e) { /* fall through */ } }
    return "r" + toB64(raw);
  }
  async function decodeCode(code) {
    let bytes = fromB64(code.slice(1));
    if (code[0] === "z") bytes = await pipe(bytes, DecompressionStream);
    const st = { i: 1 };
    if (bytes[0] === 1) { const note = readText(bytes, st).slice(0, 140); return [{ kind: "toy", note, answer: "", pts: readToyPts(bytes, st) }]; }
    if (bytes[0] === 2) {
      const n = clamp(bytes[1], 4, 64); st.i = 2;
      const note = readText(bytes, st).slice(0, 140);
      return [{ kind: "pixel", note, answer: "", n, photoK: 0, seq: readPixelSeq(bytes, st, n) }];
    }
    if (bytes[0] === 3) {
      const count = readVarint(bytes, st);
      if (count < 1 || count > 20) throw new Error("bad link");
      const entries = [];
      for (let k = 0; k < count; k++) entries.push(readEntry(bytes, st));
      return entries;
    }
    throw new Error("bad link");
  }

  /* ---------- Replay timelines and drawing ---------- */
  function hash32(i) {
    i = Math.imul(i ^ (i >>> 16), 0x45d9f3b); i = Math.imul(i ^ (i >>> 16), 0x45d9f3b);
    return (i ^ (i >>> 16)) >>> 0;
  }
  // Pixel replay: photo cells ripple out from the middle, then hand-drawn cells appear in the order they were drawn.
  function pixelTimeline(e) {
    const n = e.n, K = e.photoK || 0, c = (n - 1) / 2, far = Math.hypot(c, c) || 1;
    const key = i => Math.hypot(i % n - c, ((i / n) | 0) - c) / far + hash32(i + 1) / 4294967296 * 0.35;
    const photo = e.seq.slice(0, K).map(p => [p, key(p[0])]).sort((a, b) => a[1] - b[1]).map(p => p[0]);
    const hand = e.seq.slice(K), H = hand.length;
    const photoDur = K ? clamp(K * 1.5, 1500, 3500) : 0;
    const handDur = H ? clamp(H * 22, K ? 500 : 1800, 9000) : 0;
    const items = photo.concat(hand), times = new Float64Array(items.length);
    for (let k = 0; k < K; k++) times[k] = k / K * photoDur;
    for (let j = 0; j < H; j++) times[K + j] = photoDur + j / H * handDur;
    return { items, times, total: photoDur + handDur };
  }
  function drawPixels(ctx, S, n, items, times, ms, opts) {
    const edge = i => Math.round(i * S / n), pop = 160;
    ctx.fillStyle = PIXEL_BG; ctx.fillRect(0, 0, S, S);
    for (let k = 0; k < items.length; k++) {
      const t = times ? times[k] : -Infinity;
      if (t > ms) break;
      const [i, c] = items[k], x = i % n, y = (i / n) | 0;
      let x0 = edge(x), y0 = edge(y), w = edge(x + 1) - x0, h = edge(y + 1) - y0;
      const s = Math.min(1, (ms - t) / pop);
      if (s < 1) { const q = Math.max(s, 0); x0 += w * (1 - q) / 2; y0 += h * (1 - q) / 2; w *= q; h *= q; }
      ctx.fillStyle = PAL[c]; ctx.fillRect(x0, y0, w, h);
    }
    if (opts && opts.grid && n <= 64) {
      ctx.fillStyle = "rgba(43,43,51,.07)";
      for (let i = 1; i < n; i++) { const p = edge(i); ctx.fillRect(p, 0, 1, S); ctx.fillRect(0, p, S, 1); }
    }
  }
  function toyTimeline(pts) {
    const lens = [0];
    for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = lens[lens.length - 1] || 1;
    return { lens, total, dur: clamp(total / 380, 2.5, 14) * 1000 };
  }
  // Strokes the path up to length L, in the toy's 800×600 units. The caller sets transform, width and colour.
  function strokeToy(ctx, pts, lens, L) {
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    let i = 1;
    for (; i < pts.length && lens[i] <= L; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (i < pts.length && L > lens[i - 1]) {
      const f = (L - lens[i - 1]) / ((lens[i] - lens[i - 1]) || 1);
      ctx.lineTo(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f);
    }
    ctx.stroke();
  }
  const timeline = e => e._tl || (e._tl = e.kind === "pixel" ? pixelTimeline(e) : toyTimeline(e.pts));
  const duration = e => e.kind === "pixel" ? timeline(e).total + 160 : timeline(e).dur;

  // Draws an entry at a moment in its replay. Toy entries show only the grey screen.
  function renderEntry(cv, e, ms) {
    const ctx = cv.getContext("2d"), W = cv.width, H = cv.height, tl = timeline(e);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (e.kind === "pixel") { drawPixels(ctx, W, e.n, tl.items, tl.times, ms, null); return; }
    ctx.fillStyle = TOY.screen; ctx.fillRect(0, 0, W, H);
    const k = W / TOY.W;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.lineCap = ctx.lineJoin = "round"; ctx.strokeStyle = TOY.line;
    ctx.lineWidth = Math.max(2.4, 1.4 * Math.min(window.devicePixelRatio || 1, 2) / k);
    strokeToy(ctx, e.pts, tl.lens, clamp(ms / tl.dur, 0, 1) * tl.total);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // The whole toy, drawn flat at 400×360, for pictures and GIFs.
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function drawToyFrame(ctx, e, L) {
    ctx.fillStyle = TOY.page; ctx.fillRect(0, 0, 400, 360);
    ctx.fillStyle = TOY.red; roundRect(ctx, 0, 0, 400, 360, 36); ctx.fill();
    ctx.fillStyle = TOY.gold; ctx.font = '24px "Pacifico", cursive'; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("Etch A Sketch", 200, 23);
    ctx.fillStyle = TOY.screen; roundRect(ctx, 40, 46, 320, 240, 8); ctx.fill();
    ctx.fillStyle = TOY.knob;
    [52, 348].forEach(x => { ctx.beginPath(); ctx.arc(x, 322, 22, 0, Math.PI * 2); ctx.fill(); });
    if (L > 0) {
      ctx.save(); roundRect(ctx, 40, 46, 320, 240, 8); ctx.clip();
      ctx.translate(40, 46); ctx.scale(0.4, 0.4);
      ctx.lineCap = ctx.lineJoin = "round"; ctx.strokeStyle = TOY.line; ctx.lineWidth = 5;
      strokeToy(ctx, e.pts, timeline(e).lens, L);
      ctx.restore();
    }
  }
  const fontsReady = () => (document.fonts && document.fonts.load ? document.fonts.load('24px "Pacifico"').catch(() => {}) : Promise.resolve());

  /* ---------- GIF encoder (GIF89a, LZW) ---------- */
  function lzw(minCode, idx) {
    const out = [], clear = 1 << minCode, eoi = clear + 1;
    let size = minCode + 1, next = eoi + 1, dict = new Map(), cur = 0, bits = 0;
    const emit = c => { cur |= c << bits; bits += size; while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; } };
    emit(clear);
    let prefix = idx[0];
    for (let i = 1; i < idx.length; i++) {
      const k = idx[i], key = (prefix << 8) | k, v = dict.get(key);
      if (v !== undefined) { prefix = v; continue; }
      emit(prefix);
      if (next === 4096) { emit(clear); dict = new Map(); size = minCode + 1; next = eoi + 1; }
      else { if (next >= (1 << size)) size++; dict.set(key, next++); }
      prefix = k;
    }
    emit(prefix); emit(eoi);
    if (bits > 0) out.push(cur & 255);
    return out;
  }
  function gifWriter(w, h, pal, T) {
    let bits = 1; while ((1 << bits) < pal.length) bits++;
    const minCode = Math.max(2, bits), out = [];
    const str = s => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };
    const u16 = v => out.push(v & 255, (v >> 8) & 255);
    str("GIF89a"); u16(w); u16(h); out.push(0x80 | 0x70 | (bits - 1), 0, 0);
    for (let i = 0; i < (1 << bits); i++) { const c = pal[i] || [0, 0, 0]; out.push(c[0], c[1], c[2]); }
    out.push(0x21, 0xff, 11); str("NETSCAPE2.0"); out.push(3, 1, 0, 0, 0);
    return {
      frame(idx, delay, transparent) {
        out.push(0x21, 0xf9, 4, 4 | (transparent ? 1 : 0)); u16(delay); out.push(transparent ? T : 0, 0);
        out.push(0x2c); u16(0); u16(0); u16(w); u16(h); out.push(0, minCode);
        const data = lzw(minCode, idx);
        for (let i = 0; i < data.length; i += 255) {
          const n = Math.min(255, data.length - i); out.push(n);
          for (let j = 0; j < n; j++) out.push(data[i + j]);
        }
        out.push(0);
      },
      end() { out.push(0x3b); return new Uint8Array(out); },
    };
  }
  // Frames after the first only carry changed pixels; everything else is transparent.
  function diff(cur, prev, T) { const d = new Uint8Array(cur.length); for (let i = 0; i < cur.length; i++) d[i] = cur[i] === prev[i] ? T : cur[i]; return d; }

  async function pixelGif(e) {
    const n = e.n, f = Math.max(3, Math.round(320 / n)), W = n * f, tl = timeline(e);
    const pal = [PIXEL_BG].concat(PAL.slice(1)).map(hexRgb), T = pal.length; pal.push([0, 0, 0]);
    const g = gifWriter(W, W, pal, T), cur = new Uint8Array(W * W), prev = new Uint8Array(W * W);
    g.frame(cur, 60, false);
    const nf = clamp(Math.round(tl.total / 90), 10, 45);
    let k = 0;
    for (let j = 1; j <= nf; j++) {
      const until = tl.total * j / nf;
      while (k < tl.items.length && tl.times[k] <= until) {
        const [i, c] = tl.items[k++], x0 = (i % n) * f, y0 = ((i / n) | 0) * f;
        for (let y = y0; y < y0 + f; y++) cur.fill(c, y * W + x0, y * W + x0 + f);
      }
      g.frame(diff(cur, prev, T), j === nf ? 400 : Math.max(2, Math.round(tl.total / nf / 10)), true);
      prev.set(cur);
      if (j % 6 === 0) await later();
    }
    return g.end();
  }
  async function toyGif(e) {
    await fontsReady();
    const W = 400, H = 360, tl = timeline(e);
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    const pal = [TOY.page, TOY.red, TOY.gold, TOY.screen, TOY.line, TOY.knob].map(hexRgb), T = pal.length; pal.push([0, 0, 0]);
    const cur = new Uint8Array(W * H), prev = new Uint8Array(W * H);
    const quant = (x0, y0, w, h) => {
      const d = ctx.getImageData(x0, y0, w, h).data;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4; let best = 0, bd = Infinity;
        for (let c = 0; c < T; c++) {
          const q = pal[c], dd = (d[p] - q[0]) ** 2 + (d[p + 1] - q[1]) ** 2 + (d[p + 2] - q[2]) ** 2;
          if (dd < bd) { bd = dd; best = c; }
        }
        cur[(y0 + y) * W + x0 + x] = best;
      }
    };
    const g = gifWriter(W, H, pal, T);
    drawToyFrame(ctx, e, 0); quant(0, 0, W, H);
    g.frame(cur, 60, false); prev.set(cur);
    const nf = clamp(Math.round(tl.dur / 90), 12, 45);
    for (let j = 1; j <= nf; j++) {
      drawToyFrame(ctx, e, tl.total * j / nf); quant(40, 46, 320, 240);
      g.frame(diff(cur, prev, T), j === nf ? 400 : Math.max(2, Math.round(tl.dur / nf / 10)), true);
      prev.set(cur);
      if (j % 6 === 0) await later();
    }
    return g.end();
  }
  async function makePng(e) {
    const cv = document.createElement("canvas"), ctx = cv.getContext("2d");
    if (e.kind === "pixel") {
      const f = Math.max(8, Math.round(1024 / e.n)); cv.width = cv.height = e.n * f;
      drawPixels(ctx, cv.width, e.n, timeline(e).items, null, Infinity, null);
    } else {
      await fontsReady(); cv.width = 800; cv.height = 720; ctx.scale(2, 2); drawToyFrame(ctx, e, Infinity);
    }
    return new Promise(res => cv.toBlob(res, "image/png"));
  }
  // Phones get the share sheet (so it can go straight to Photos); computers download the file.
  async function deliver(blob, name) {
    const file = new File([blob], name, { type: blob.type });
    if (matchMedia("(hover: none)").matches && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (err) { if (err && err.name === "AbortError") return; }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* ---------- Photo to pixels ---------- */
  function lab([r, g, b]) {
    const f = c => (c /= 255) <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    const R = f(r), G = f(g), B = f(b);
    const h = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const x = h((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047), y = h(R * 0.2126 + G * 0.7152 + B * 0.0722), z = h((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  // Crops to a square (a little above centre on portrait photos, where faces usually are),
  // shrinks it in steps, and maps every pixel to the nearest palette colour. White becomes empty.
  function photoToCells(img, n) {
    const w = img.width, h = img.height, s = Math.min(w, h);
    const sx = (w - s) / 2, sy = h > w ? (h - s) * 0.3 : (h - s) / 2;
    let src = img, sxx = sx, syy = sy, size = s;
    while (size / 2 > n * 4) {
      const half = document.createElement("canvas"), hs = Math.round(size / 2);
      half.width = half.height = hs;
      const hctx = half.getContext("2d"); hctx.imageSmoothingQuality = "high";
      hctx.drawImage(src, sxx, syy, size, size, 0, 0, hs, hs);
      src = half; sxx = syy = 0; size = hs;
    }
    const mid = document.createElement("canvas"); mid.width = mid.height = n * 4;
    const mctx = mid.getContext("2d"); mctx.imageSmoothingQuality = "high";
    mctx.filter = "saturate(1.35) contrast(1.1)";
    mctx.drawImage(src, sxx, syy, size, size, 0, 0, n * 4, n * 4);
    const small = document.createElement("canvas"); small.width = small.height = n;
    const sctx = small.getContext("2d", { willReadFrequently: true }); sctx.imageSmoothingQuality = "high";
    sctx.drawImage(mid, 0, 0, n, n);
    const d = sctx.getImageData(0, 0, n, n).data;
    // Auto levels: stretch brightness so the darkest 2% become black and the brightest 2% white.
    // Dim or hazy photos otherwise collapse into one or two dark colours.
    const lum = [];
    for (let i = 0; i < n * n; i++) if (d[i * 4 + 3] >= 128) lum.push(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
    lum.sort((a, b) => a - b);
    const lo = lum[Math.floor(lum.length * 0.02)] || 0, hi = lum[Math.floor(lum.length * 0.98)] || 255;
    if (hi - lo > 8) for (let i = 0; i < n * n * 4; i++) if (i % 4 !== 3) d[i] = clamp((d[i] - lo) * 255 / (hi - lo), 0, 255);
    const labs = PAL.map(c => c && lab(hexRgb(c)));
    const out = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) {
      if (d[i * 4 + 3] < 128) continue;
      const L = lab([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
      let best = 1, bd = Infinity;
      for (let c = 1; c < labs.length; c++) {
        const p = labs[c], dd = (L[0] - p[0]) ** 2 + (L[1] - p[1]) ** 2 + (L[2] - p[2]) ** 2;
        if (dd < bd) { bd = dd; best = c; }
      }
      out[i] = best === 12 ? 0 : best;
    }
    return out;
  }

  /* ---------- Guess checking ---------- */
  function norm(s) {
    return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ").split(" ")
      .filter(w => w && !["a", "an", "the", "its", "it", "is", "this", "thats", "that"].includes(w))
      .map(w => w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)
      .join(" ");
  }
  function lev(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let diag = row[0]; row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const t = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = t;
      }
    }
    return row[b.length];
  }
  // Answers can list alternatives: "cat, kitty".
  function checkGuess(guess, answer) {
    const g = norm(guess);
    if (!g) return "empty";
    let close = false;
    for (const a of answer.split(/,|\/|\bor\b/).map(norm).filter(Boolean)) {
      if (g === a || (" " + g + " ").includes(" " + a + " ")) return "yes";
      const tol = a.length >= 8 ? 2 : a.length >= 4 ? 1 : 0, d = lev(g, a);
      if (d <= tol) return "yes";
      if (d <= tol + Math.max(1, Math.floor(a.length / 4)) || (g.length >= 3 && (" " + a + " ").includes(" " + g + " "))) close = true;
    }
    return close ? "close" : "no";
  }
  const shownAnswer = a => a.split(",")[0].trim();

  /* ---------- Links you made yourself (so previewing your own link doesn't start a thread) ---------- */
  function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return (h >>> 0).toString(36); }
  function rememberSent(code) {
    try { const a = JSON.parse(localStorage.getItem("etch.sent") || "[]"); a.push(fnv(code)); localStorage.setItem("etch.sent", JSON.stringify(a.slice(-30))); } catch (e) { /* storage blocked */ }
  }
  function isMine(code) {
    try { return JSON.parse(localStorage.getItem("etch.sent") || "[]").includes(fnv(code)); } catch (e) { return false; }
  }

  /* ---------- Small UI helpers ---------- */
  let toastTimer;
  function toast(msg) {
    const t = $("toast"); if (!t) return;
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
  }
  const HEART_PATH = "M1 1h2v1H1zM5 1h2v1H5zM0 2h8v2H0zM1 4h6v1H1zM2 5h4v1H2zM3 6h2v1H3z";
  function hearts() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const cols = ["#ff4d6d", "#ff8fab", "#ffb38a", "#9b5de5", "#ff4d6d"];
    for (let k = 0; k < 18; k++) {
      const h = document.createElement("div"), size = 16 + Math.random() * 22;
      h.className = "floaty";
      h.innerHTML = '<svg viewBox="0 0 8 8" shape-rendering="crispEdges"><path fill="' + cols[k % cols.length] + '" d="' + HEART_PATH + '"/></svg>';
      h.style.left = (Math.random() * 96) + "vw"; h.style.width = h.style.height = size + "px";
      h.style.setProperty("--drift", (Math.random() * 80 - 40) + "px");
      h.style.animationDuration = (3 + Math.random() * 2.5) + "s";
      h.style.animationDelay = (Math.random() * 1.2) + "s";
      document.body.appendChild(h);
      setTimeout(() => h.remove(), 7000);
    }
  }
  const sizeCanvas = (cv, w, h) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + "px"; cv.style.height = h + "px";
  };

  const UI = `
  <div class="overlay" id="intro" hidden>
    <div class="card">
      <span class="pixel-heart"><svg viewBox="0 0 8 8" shape-rendering="crispEdges"><path fill="#ff4d6d" d="${HEART_PATH}"/><path fill="#fff" opacity=".6" d="M1 2h1v1H1z"/></svg></span>
      <h2 id="introTitle">For you</h2>
      <p id="introText"></p>
      <p class="note" id="introNote" hidden></p>
      <div class="row"><button class="btn primary" id="watchBtn">Open it</button></div>
    </div>
  </div>
  <div class="overlay" id="shareBox" hidden>
    <div class="card">
      <h2 id="shareTitle">Send it</h2>
      <p id="shareLead"></p>
      <textarea id="noteInput" rows="2" maxlength="140" placeholder="Add a note (optional)"></textarea>
      <label class="check"><input type="checkbox" id="guessToggle"> Make them guess what it is</label>
      <input id="answerInput" maxlength="60" placeholder="The answer, e.g. a cat" autocomplete="off" hidden>
      <div id="linkArea" hidden><input id="linkOut" readonly></div>
      <div class="row">
        <button class="btn" id="cancelShare">Close</button>
        <button class="btn primary" id="makeLink">Create link</button>
        <button class="btn primary" id="copyLink" hidden>Copy link</button>
        <button class="btn" id="nativeShare" hidden>Share…</button>
      </div>
      <p class="small" id="shareMsg"></p>
    </div>
  </div>
  <div class="overlay" id="viewer" hidden>
    <div class="card">
      <p class="viewer-label" id="viewerLabel"></p>
      <canvas class="viewer-canvas" id="viewerCanvas"></canvas>
      <p class="viewer-note" id="viewerNote"></p>
      <div class="row">
        <button class="btn" id="viewerClose">Close</button>
        <button class="btn" id="viewerReplay">Replay</button>
        <button class="btn primary" id="viewerSave">Save</button>
      </div>
    </div>
  </div>
  <div class="overlay" id="saveBox" hidden>
    <div class="card">
      <h2>Save it</h2>
      <canvas class="save-preview" id="savePreview"></canvas>
      <div class="row">
        <button class="btn" id="savePng" disabled>Save picture</button>
        <button class="btn primary" id="saveGif" disabled>Making GIF…</button>
      </div>
      <p class="small">The GIF plays the drawing from start to finish.</p>
      <div class="row"><button class="linkish" id="saveClose">Close</button></div>
    </div>
  </div>
  <div class="overlay" id="newsBox" hidden>
    <div class="card news">
      <h2>What's new</h2>
      <ul>
        <li><b>Draw one back</b>Reply to any drawing you get, in either mode. Replies keep the earlier drawings, so you build up a little thread.</li>
        <li><b>Photo</b>Turn a picture into pixel art in Pixels mode, then draw on top of it.</li>
        <li><b>Save</b>Keep any drawing as a picture, or as a GIF that plays it.</li>
        <li><b>Guess</b>When you send a drawing, you can make them guess what it is before your note shows up.</li>
      </ul>
      <div class="row"><button class="btn primary" id="newsOk">Got it</button></div>
    </div>
  </div>
  <div class="dock" id="dock" hidden>
    <button class="dock-x" id="dockX" aria-label="Close">×</button>
    <div id="dockGuess">
      <p class="dock-title">What is it?</p>
      <form class="guess-row" id="guessForm"><input id="guessIn" maxlength="60" placeholder="Your guess" autocomplete="off" enterkeyhint="go"><button class="btn primary">Guess</button></form>
      <p class="dock-msg" id="guessMsg"></p>
      <button class="linkish" id="giveUp" hidden>Give up</button>
    </div>
    <div id="dockDone" hidden>
      <p class="dock-result" id="dockResult"></p>
      <p class="dock-note" id="dockNote"></p>
      <div class="row"><button class="btn" id="dockSave">Save</button><button class="btn primary" id="dockReply">Draw one back</button></div>
    </div>
  </div>`;

  /* ---------- Page wiring ---------- */
  let cfg = null, thread = null, guess = null, dockEntry = null, own = false;

  function init(c) {
    cfg = c;
    document.body.insertAdjacentHTML("beforeend", UI);
    wireShare(); wireSave(); wireViewer(); wireDock();
    document.querySelectorAll(".overlay").forEach(o => o.addEventListener("click", e => {
      if (e.target === o && o.id !== "intro") { o.hidden = true; if (o.id === "saveBox") saveToken++; }
    }));
    const saveBtn = $("saveBtn");
    if (saveBtn) saveBtn.addEventListener("click", () => {
      if (cfg.isBusy()) return;
      const e = cfg.getEntry();
      e ? openSave(e) : toast("Draw something first.");
    });

    // "What's new": opens once on a normal visit; a link that opens a drawing only gets the badge.
    const NEWS = "2026-11";
    let seen = false;
    try { seen = localStorage.getItem("etch.news") === NEWS; } catch (e) { /* storage blocked */ }
    const modes = document.querySelector(".modes");
    if (modes) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "modes-new" + (seen ? "" : " unseen"); b.textContent = "New"; b.title = "What's new";
      b.addEventListener("click", () => { $("newsBox").hidden = false; });
      modes.appendChild(b);
    }
    const markSeen = () => {
      try { localStorage.setItem("etch.news", NEWS); } catch (e) { /* storage blocked */ }
      const b = document.querySelector(".modes-new"); if (b) b.classList.remove("unseen");
    };
    $("newsOk").addEventListener("click", () => { $("newsBox").hidden = true; markSeen(); });
    $("newsBox").addEventListener("click", e => { if (e.target === $("newsBox")) markSeen(); });

    const m = location.hash.match(/^#d=([zr][A-Za-z0-9_-]+)$/);
    if (!m && !seen) setTimeout(() => { if (!document.querySelector(".overlay:not([hidden])")) $("newsBox").hidden = false; }, 500);
    if (m) {
      decodeCode(m[1]).then(entries => {
        const latest = entries[entries.length - 1];
        if (latest.kind !== cfg.kind) { location.replace((latest.kind === "toy" ? "toy.html" : "./") + location.hash); return; }
        showIntro(entries, m[1]);
      }).catch(() => { toast("That link looks broken."); restoreThread(); });
    } else restoreThread();
  }

  function showIntro(entries, code) {
    const e = entries[entries.length - 1];
    own = isMine(code);
    let lead = own ? "This is your own link. Here's what they'll see." : entries.length > 1 ? "They drew one back." : "Someone made you a little drawing.";
    if (e.answer) lead += e.note ? " Guess what it is to unlock the note." : " Can you guess what it is?";
    $("introTitle").textContent = own ? "Preview" : "For you";
    $("introText").textContent = lead;
    $("introNote").textContent = e.note ? "“" + e.note + "”" : "";
    $("introNote").hidden = !e.note || !!e.answer;
    $("intro").hidden = false;
    $("watchBtn").onclick = () => {
      $("intro").hidden = true;
      if (cfg.onOpen) cfg.onOpen();
      history.replaceState(null, "", location.pathname + location.search);
      if (own) restoreThread(); else setThread(entries, code);
      play(e);
    };
  }

  function play(e) {
    guess = e.answer ? { e, tries: 0, wrong: 0, solved: false } : null;
    if (guess) openGuess();
    cfg.play(e, () => {
      if (guess && !guess.solved) { $("giveUp").hidden = false; return; }
      if (!guess) { hearts(); openDone(e, ""); }
    });
  }

  /* Thread strip */
  function setThread(entries, code) {
    thread = entries;
    try { sessionStorage.setItem("etch.thread", code); } catch (e) { /* storage blocked */ }
    renderThread();
  }
  function clearThread() {
    thread = null;
    try { sessionStorage.removeItem("etch.thread"); } catch (e) { /* storage blocked */ }
    renderThread();
  }
  function restoreThread() {
    let code = null;
    try { code = sessionStorage.getItem("etch.thread"); } catch (e) { /* storage blocked */ }
    if (code) decodeCode(code).then(en => setThread(en, code)).catch(clearThread);
  }
  function renderThread() {
    const box = $("thread"); if (!box) return;
    if (!thread) { box.hidden = true; box.innerHTML = ""; return; }
    box.innerHTML = '<div class="thread-head"><span>Drawings so far</span><button type="button" id="threadNew">Start over</button></div><div class="thread-row" id="threadRow"></div>';
    const row = $("threadRow");
    thread.forEach((e, k) => {
      const theirs = (thread.length - 1 - k) % 2 === 0;
      const b = document.createElement("button");
      b.type = "button"; b.className = "thumb" + (theirs ? " theirs" : "");
      const cv = document.createElement("canvas");
      sizeCanvas(cv, e.kind === "pixel" ? 56 : 75, 56);
      renderEntry(cv, e, Infinity);
      const label = document.createElement("span"); label.textContent = theirs ? "Theirs" : "Yours";
      b.append(cv, label);
      b.addEventListener("click", () => openViewer(e, theirs));
      row.appendChild(b);
    });
    $("threadNew").addEventListener("click", () => { clearThread(); toast("Started fresh. Your next link won't include these."); });
    box.hidden = false;
    row.scrollLeft = row.scrollWidth;
  }

  /* Viewer for a drawing in the thread */
  let viewEntry = null, viewRaf = 0;
  function openViewer(e, theirs) {
    viewEntry = e;
    const hide = guess && !guess.solved && guess.e === e;
    const parts = [];
    if (e.answer && !hide) parts.push("Answer: " + shownAnswer(e.answer));
    if (e.note && !hide) parts.push("“" + e.note + "”");
    $("viewerLabel").textContent = theirs ? "Theirs" : "Yours";
    $("viewerNote").textContent = parts.join("  ·  "); $("viewerNote").hidden = !parts.length;
    const w = Math.min(340, window.innerWidth - 88);
    sizeCanvas($("viewerCanvas"), w, e.kind === "pixel" ? w : Math.round(w * 0.75));
    $("viewer").hidden = false;
    runViewer();
  }
  function runViewer() {
    cancelAnimationFrame(viewRaf);
    const e = viewEntry, cv = $("viewerCanvas"), total = duration(e);
    let t0 = null;
    const frame = t => {
      if (t0 == null) t0 = t;
      renderEntry(cv, e, t - t0);
      if (t - t0 < total && !$("viewer").hidden) viewRaf = requestAnimationFrame(frame);
    };
    viewRaf = requestAnimationFrame(frame);
  }
  function wireViewer() {
    $("viewerClose").addEventListener("click", () => { $("viewer").hidden = true; });
    $("viewerReplay").addEventListener("click", runViewer);
    $("viewerSave").addEventListener("click", () => openSave(viewEntry));
  }

  /* Save */
  let saveToken = 0, pngBlob = null, gifBlob = null;
  function openSave(e) {
    const token = ++saveToken;
    pngBlob = gifBlob = null;
    $("viewer").hidden = true;
    $("savePng").disabled = true;
    $("saveGif").disabled = true; $("saveGif").textContent = "Making GIF…";
    const cv = $("savePreview"), w = Math.min(240, window.innerWidth - 110);
    if (e.kind === "pixel") { sizeCanvas(cv, w, w); renderEntry(cv, e, Infinity); }
    else {
      sizeCanvas(cv, w, Math.round(w * 0.9));
      fontsReady().then(() => { const ctx = cv.getContext("2d"); ctx.setTransform(cv.width / 400, 0, 0, cv.width / 400, 0, 0); drawToyFrame(ctx, e, Infinity); });
    }
    $("saveBox").hidden = false;
    makePng(e).then(b => { if (token === saveToken && b) { pngBlob = b; $("savePng").disabled = false; } });
    setTimeout(() => {
      (e.kind === "pixel" ? pixelGif(e) : toyGif(e)).then(bytes => {
        if (token !== saveToken) return;
        gifBlob = new Blob([bytes], { type: "image/gif" });
        $("saveGif").disabled = false; $("saveGif").textContent = "Save GIF";
      }).catch(() => { if (token === saveToken) $("saveGif").textContent = "GIF didn't work"; });
    }, 40);
  }
  function wireSave() {
    $("savePng").addEventListener("click", () => { if (pngBlob) deliver(pngBlob, "etch-a-sketch.png"); });
    $("saveGif").addEventListener("click", () => { if (gifBlob) deliver(gifBlob, "etch-a-sketch.gif"); });
    $("saveClose").addEventListener("click", () => { $("saveBox").hidden = true; saveToken++; });
  }

  /* Dock: guessing, then the note and what to do next */
  function openGuess() {
    $("dock").hidden = false; $("dockGuess").hidden = false; $("dockDone").hidden = true; $("dockX").hidden = true;
    $("guessMsg").textContent = ""; $("giveUp").hidden = true; $("guessIn").value = "";
    if (matchMedia("(hover: hover)").matches) $("guessIn").focus({ preventScroll: true });
  }
  function openDone(e, result) {
    dockEntry = e;
    $("dock").hidden = false; $("dockGuess").hidden = true; $("dockDone").hidden = false; $("dockX").hidden = false;
    $("dockResult").textContent = result; $("dockResult").hidden = !result;
    $("dockNote").textContent = e.note ? "“" + e.note + "”" : ""; $("dockNote").hidden = !e.note;
    $("dockReply").hidden = own;
    $("dockReply").focus({ preventScroll: true });
  }
  function wireDock() {
    $("dockX").addEventListener("click", () => { $("dock").hidden = true; });
    $("guessForm").addEventListener("submit", ev => {
      ev.preventDefault();
      if (!guess || guess.solved) return;
      const r = checkGuess($("guessIn").value, guess.e.answer);
      if (r === "empty") return;
      guess.tries++;
      if (r === "yes") {
        guess.solved = true; hearts();
        const ans = shownAnswer(guess.e.answer);
        openDone(guess.e, guess.tries === 1 ? "First try! It's " + ans + "." : "Yes, it's " + ans + "! Got it in " + guess.tries + ".");
        return;
      }
      guess.wrong++;
      const msgs = ["Nope, try again.", "Not quite.", "Guess again."];
      $("guessMsg").textContent = r === "close" ? "So close!" : msgs[(guess.wrong - 1) % msgs.length];
      const f = $("guessForm"); f.classList.remove("nope"); void f.offsetWidth; f.classList.add("nope");
      $("guessIn").select();
      if (guess.wrong >= 3) $("giveUp").hidden = false;
    });
    $("giveUp").addEventListener("click", () => {
      if (!guess) return;
      guess.solved = true;
      openDone(guess.e, "It was " + shownAnswer(guess.e.answer) + ".");
    });
    $("dockSave").addEventListener("click", () => { if (dockEntry) openSave(dockEntry); });
    $("dockReply").addEventListener("click", () => {
      if (cfg.isBusy()) { toast("Let it finish first."); return; }
      $("dock").hidden = true;
      cfg.clearForReply();
      setTimeout(() => toast("Your turn. Draw it, then press Send."), 700);
    });
  }

  /* Share box */
  function wireShare() {
    const box = $("shareBox"), note = $("noteInput"), tog = $("guessToggle"), ans = $("answerInput");
    const area = $("linkArea"), out = $("linkOut"), make = $("makeLink"), copy = $("copyLink"), nat = $("nativeShare"), msg = $("shareMsg");
    const reset = () => {
      area.hidden = true; copy.hidden = true; nat.hidden = true; make.hidden = false;
      msg.textContent = tog.checked ? "They'll have to guess it before they see your note." : "";
    };
    $("shareBtn").addEventListener("click", () => {
      if (cfg.isBusy()) return;
      if (!cfg.getEntry()) { toast("Draw something first."); return; }
      $("shareTitle").textContent = thread ? "Send your reply" : "Send it";
      $("shareLead").textContent = thread ? "It goes into the thread with the drawings before it."
        : cfg.kind === "pixel" ? "They'll watch it appear, pixel by pixel." : "They'll watch it draw itself, line by line.";
      reset(); box.hidden = false; note.focus();
    });
    [note, ans].forEach(el => el.addEventListener("input", reset));
    tog.addEventListener("change", () => { ans.hidden = !tog.checked; reset(); if (tog.checked) ans.focus(); });
    $("cancelShare").addEventListener("click", () => { box.hidden = true; });
    make.addEventListener("click", async () => {
      const e = cfg.getEntry(); if (!e) return;
      e.note = note.value.trim().slice(0, 140);
      e.answer = tog.checked ? ans.value.trim().slice(0, 60) : "";
      if (tog.checked && !e.answer) { msg.textContent = "Add the answer so their guesses can be checked."; ans.focus(); return; }
      let entries = (thread || []).concat([e]).slice(-MAX_THREAD), code = await encodeThread(entries), dropped = false;
      while (code.length > MAX_LINK && entries.length > 1) { entries = entries.slice(1); code = await encodeThread(entries); dropped = true; }
      rememberSent(code);
      out.value = location.origin + location.pathname + "#d=" + code;
      area.hidden = false; make.hidden = true; copy.hidden = false;
      if (navigator.share) nat.hidden = false;
      msg.textContent = (dropped ? "The oldest drawings were left out to keep the link short. " : "") + "The whole drawing lives in the link, so nothing is uploaded anywhere.";
      out.select();
    });
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(out.value); } catch (err) { out.select(); document.execCommand("copy"); }
      toast("Link copied.");
    });
    nat.addEventListener("click", () => {
      navigator.share({ title: thread ? "I drew you one back" : "I made you something", url: out.value }).catch(() => {});
    });
  }

  window.Etch = { PAL, NAMES, PIXEL_BG, init, toast, hearts, pixelTimeline, drawPixels, photoToCells, checkGuess, encodeThread, decodeCode };
})();
