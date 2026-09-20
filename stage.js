/* Pelume home: a white mosaic of square tiles. Red tiles grow out of it along
   the shape of the paperclips, like pieces being placed in a game, while a few
   tiles blink at random. Scrolling drains the red back out, then grows the
   paperclips again. The scroll loops, so there is no end in either direction.

   Progressive enhancement. Without scripting, or with reduced motion, the page
   is the paperclip mark. */

(function () {
  "use strict";

  var shell = document.querySelector("[data-scene]");
  if (!shell) return;

  var reduced =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || !window.requestAnimationFrame) return;

  var scroller = shell.querySelector(".scroll");
  var track = shell.querySelector("[data-track]");
  var stage = shell.querySelector("[data-stage]");
  var img = shell.querySelector("[data-mark] img");
  if (!scroller || !track || !stage || !img) return;

  /* ------------------------------------------------------------ settings */

  var CFG = {
    intro: 5600, // ms for the paperclips to grow the first time
    delay: 600, // ms of empty mosaic before anything grows
    screens: 3, // one pass of the sequence, in stage heights
    loop: true, // keep scrolling round instead of stopping at the end
    passes: 5, // passes held in the scroll track when looping
    markSize: 0.66, // paperclips, as a fraction of the shorter stage side
    across: 56, // tiles across the paperclips: higher is finer
    minTile: 6, // smallest tile, in px
    gap: 0.14, // gap between tiles, as a share of a tile
    line: "#f0f0f0", // colour of the gaps; the tiles themselves are white
    spark: 0.03, // share of tiles that blink now and then
    seeds: 5, // places along the paperclips where growth starts
    source: 1800, // px the SVG is rasterised at, once

    /* Scroll phases, each as [start, end] over 0..1 of one pass. */
    away: [0.04, 0.42], // red drains out of the paperclips
    back: [0.58, 0.96], // paperclips grow again
    glide: 0.15 // seconds the scroll position takes to catch up (0 = no easing)
  };

  var SOFT = 0.1; // how long a tile takes to change colour, in growth
  var DUTY = 0.22; // share of its cycle a blinking tile spends lit
  var WOBBLE = 0.05; // how far the growing edge flickers, in growth

  var phone = window.matchMedia("(max-width: 720px)");

  /* -------------------------------------------------------------- helpers */

  function clamp(x, a, b) {
    return x < a ? a : x > b ? b : x;
  }

  function range(x, a, b) {
    return clamp((x - a) / (b - a), 0, 1);
  }

  function ease(t) {
    return t * t * (3 - 2 * t);
  }

  /* A gentler ease for the opening: slow to start and slow to settle. */
  function soft(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  /* Repeatable random number 0..1 for a tile and a purpose, so the mosaic is
     the same every visit and does not reshuffle when the window is resized. */
  function rnd(i, k) {
    var h = Math.imul(i + 1, 374761393) + Math.imul(k + 1, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  /* --------------------------------------------------------------- state */

  var canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  var ctx = canvas.getContext("2d", { alpha: false });

  var lo = document.createElement("canvas"); // one pixel per tile
  var lctx = lo.getContext("2d");
  var probe = document.createElement("canvas"); // paperclips at tile size
  var pctx = probe.getContext("2d");
  var grout = document.createElement("canvas"); // the gaps between tiles

  var mips = []; // paperclips at 1, 1/2, 1/4 ... scale, for clean downsampling

  var W = 0;
  var H = 0;
  var dpr = 1;
  var Wd = 0;
  var Hd = 0;
  var markPx = 0;

  /* The mosaic. */
  var P = 8; // tile pitch, device px
  var cols = 0;
  var rows = 0;
  var imgData = null;
  var buf = null; // what is drawn: base plus blinking tiles
  var base = null; // tiles without the blinking
  var onMark = null; // 1 where a tile belongs to the paperclips
  var ink = null; // colour a tile takes when the paperclips reach it
  var born = null; // when, in growth 0..1, the paperclips reach a tile
  var wob = null; // phase of the flicker at the growing edge
  var sIdx = null; // tiles that blink
  var sT = null;
  var sP = null;

  var cycle = 1; // px of scrolling in one pass of the sequence
  var passes = 1;
  var target = 0; // passes scrolled, straight from the scroll position
  var progress = 0; // eased towards target, drives everything on screen
  var primed = false;
  var last = 0;
  var lastScroll = 0;
  var settle = false;
  var scrollD = 0; // 0 fully grown, 1 fully drained, from scroll alone
  var scrolled = true;
  var t0 = 0;
  var lastForm = -1;
  var lastDraw = 0;
  var forceBase = true;
  var dead = false;
  var sizeKey = "";

  shell.classList.add("is-scene");

  /* A reload should start at the paperclips, not wherever the browser left it. */
  if (CFG.loop && "scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }

  loadMark(
    function (source) {
      buildMips(source);
      stage.insertBefore(canvas, stage.firstChild);
      shell.classList.add("is-live");
      layout(true);
      if (dead) return;
      bind();
      last = performance.now();
      t0 = last + CFG.delay;
      requestAnimationFrame(loop);
    },
    bail
  );

  /* Could not read the SVG: fall back to the plain page. */
  function bail() {
    dead = true;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    shell.classList.remove("is-scene", "is-live");
    stage.style.height = "";
    track.style.height = "";
  }

  /* ---------------------------------------------------------- the paperclips */

  /* The SVG is fetched as text so its size can be set to CFG.source before it
     is drawn, which keeps it sharp at any stage size. Over file:// the fetch is
     blocked, so the <img> is used as it is. */
  function loadMark(done, fail) {
    var direct = function () {
      if (img.complete && img.naturalWidth) done(img);
      else {
        img.addEventListener("load", function () {
          done(img);
        });
        img.addEventListener("error", fail);
      }
    };

    if (!window.fetch || location.protocol === "file:") {
      direct();
      return;
    }

    fetch(img.currentSrc || img.src)
      .then(function (r) {
        return r.text();
      })
      .then(function (svg) {
        svg = svg
          .replace(/<\?xml[^>]*\?>/i, "")
          .replace(/<metadata[\s\S]*?<\/metadata>/i, "")
          .replace(/<svg([^>]*)>/i, function (m, attrs) {
            attrs = attrs.replace(/\s(width|height)="[^"]*"/g, "");
            return (
              "<svg" +
              attrs +
              ' width="' +
              CFG.source +
              '" height="' +
              CFG.source +
              '">'
            );
          });
        var url = URL.createObjectURL(
          new Blob([svg], { type: "image/svg+xml" })
        );
        var image = new Image();
        image.onload = function () {
          done(image);
          URL.revokeObjectURL(url);
        };
        image.onerror = direct;
        image.src = url;
      })
      .catch(direct);
  }

  function buildMips(source) {
    var s = CFG.source;
    var baseImg = document.createElement("canvas");
    baseImg.width = baseImg.height = s;
    baseImg.getContext("2d").drawImage(source, 0, 0, s, s);
    mips = [{ c: baseImg, s: s }];

    while (s > 32) {
      s = s >> 1;
      var c = document.createElement("canvas");
      c.width = c.height = s;
      var x = c.getContext("2d");
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = "high";
      x.drawImage(mips[mips.length - 1].c, 0, 0, s, s);
      mips.push({ c: c, s: s });
    }
  }

  /* --------------------------------------------------------------- layout */

  function layout(force) {
    if (dead) return;

    var container = !phone.matches;
    var h = container ? scroller.clientHeight : 0;
    var key = [
      container,
      h,
      stage.clientWidth,
      window.devicePixelRatio
    ].join("|");
    if (!force && key === sizeKey) return;
    sizeKey = key;

    stage.style.height = container ? h + "px" : "";
    var sh = stage.offsetHeight;

    var next = Math.max(1, Math.round(sh * (CFG.screens - 1)));
    var resized = next !== cycle || !primed;
    cycle = next;
    passes = CFG.loop ? CFG.passes : 1;
    track.style.height = Math.round(sh + cycle * passes) + "px";

    W = stage.clientWidth;
    H = stage.clientHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    Wd = Math.max(1, Math.round(W * dpr));
    Hd = Math.max(1, Math.round(H * dpr));
    canvas.width = Wd;
    canvas.height = Hd;

    markPx = Math.min(W, H) * CFG.markSize * dpr;
    if (!buildMosaic()) return;

    /* The pass length changed, so put the scroll back at the same point in the
       sequence. Looping starts in the middle pass with room either way. */
    if (resized) {
      var mid = CFG.loop ? Math.floor(passes / 2) : 0;
      var at = 0;
      if (primed) at = CFG.loop ? progress - Math.floor(progress) : clamp(progress, 0, 1);
      setScroll((mid + at) * cycle);
      target = progress = mid + at;
    }

    forceBase = true;
    scrolled = true;
  }

  function bind() {
    window.addEventListener("resize", function () {
      layout(false);
    });
    if (phone.addEventListener) {
      phone.addEventListener("change", function () {
        layout(true);
      });
    }
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () {
        layout(false);
      });
      ro.observe(scroller);
      ro.observe(stage);
    }

    var flag = function () {
      scrolled = true;
      settle = true;
      lastScroll = performance.now();
    };
    window.addEventListener("scroll", flag, { passive: true });
    scroller.addEventListener("scroll", flag, { passive: true });
  }

  /* --------------------------------------------------------------- mosaic */

  /* Lay out the tiles, work out which ones make up the paperclips and in what
     order they fill, and pick the ones that will blink. */
  function buildMosaic() {
    var tile = Math.max(CFG.minTile, markPx / dpr / CFG.across);
    P = Math.max(4, Math.round(tile * dpr));
    cols = Math.ceil(Wd / P);
    rows = Math.ceil(Hd / P);
    var n = cols * rows;

    lo.width = cols;
    lo.height = rows;
    imgData = lctx.createImageData(cols, rows);
    buf = new Uint32Array(imgData.data.buffer);
    base = new Uint32Array(n);
    onMark = new Uint8Array(n);
    ink = new Uint32Array(n);
    born = new Float32Array(n);
    wob = new Float32Array(n);

    for (var i = 0; i < n; i++) wob[i] = rnd(i, 4) * 6.2832;

    if (!sampleMark(n)) return false;
    growth(n);
    blinkers(n);
    drawGrout();
    return true;
  }

  /* Draw the paperclips at one pixel per tile and keep the tiles they cover,
     each with its own colour so the shading carries over. */
  function sampleMark(n) {
    probe.width = cols;
    probe.height = rows;
    var s = markPx / P;
    var m = 0;
    while (m + 1 < mips.length && mips[m + 1].s >= s) m++;

    pctx.clearRect(0, 0, cols, rows);
    pctx.imageSmoothingEnabled = true;
    pctx.imageSmoothingQuality = "high";
    pctx.drawImage(mips[m].c, Wd / 2 / P - s / 2, Hd / 2 / P - s / 2, s, s);

    var px;
    try {
      px = pctx.getImageData(0, 0, cols, rows).data;
    } catch (e) {
      bail();
      return false;
    }

    for (var i = 0; i < n; i++) {
      if (px[i * 4 + 3] < 110) {
        onMark[i] = 0;
        continue;
      }
      onMark[i] = 1;
      var v = 0.93 + rnd(i, 9) * 0.14; // each tile a little different
      var r = Math.min(255, px[i * 4] * v);
      var g = Math.min(255, px[i * 4 + 1] * v);
      var b = Math.min(255, px[i * 4 + 2] * v);
      ink[i] = (r | 0) | ((g | 0) << 8) | ((b | 0) << 16) | 0xff000000;
    }
    return true;
  }

  /* Growth spreads outward from a few seed tiles, moving along the wire of the
     paperclips tile by tile, so it reads as something evolving rather than
     something switching on. Each seed starts a little later than the last. */
  function growth(n) {
    var cells = [];
    for (var i = 0; i < n; i++) if (onMark[i]) cells.push(i);
    if (!cells.length) return;

    cells.sort(function (a, b) {
      return rnd(a, 5) - rnd(b, 5);
    });

    var sep = Math.max(4, Math.round(CFG.across * 0.2));
    var seeds = [];
    for (var c = 0; c < cells.length && seeds.length < CFG.seeds; c++) {
      var ci = cells[c];
      var cx = ci % cols;
      var cy = (ci / cols) | 0;
      var ok = true;
      for (var k = 0; k < seeds.length; k++) {
        var sx = seeds[k] % cols;
        var sy = (seeds[k] / cols) | 0;
        if (Math.max(Math.abs(sx - cx), Math.abs(sy - cy)) < sep) {
          ok = false;
          break;
        }
      }
      if (ok) seeds.push(ci);
    }

    var dist = new Int32Array(n).fill(-1);
    var from = new Int8Array(n);
    var queue = new Int32Array(n);
    var head = 0;
    var tail = 0;
    seeds.forEach(function (sd, k) {
      dist[sd] = 0;
      from[sd] = k;
      queue[tail++] = sd;
    });

    while (head < tail) {
      var q = queue[head++];
      var qx = q % cols;
      var qy = (q / cols) | 0;
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          var nx = qx + dx;
          var ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          var ni = ny * cols + nx;
          if (!onMark[ni] || dist[ni] >= 0) continue;
          dist[ni] = dist[q] + 1;
          from[ni] = from[q];
          queue[tail++] = ni;
        }
      }
    }

    var maxD = 1;
    for (var a = 0; a < cells.length; a++) maxD = Math.max(maxD, dist[cells[a]]);

    var raw = new Float32Array(n);
    var top = 0;
    for (var b = 0; b < cells.length; b++) {
      var ii = cells[b];
      var dd = dist[ii] >= 0 ? dist[ii] : rnd(ii, 6) * maxD; // tiles cut off from every seed
      raw[ii] = dd + rnd(from[ii] + 100, 7) * maxD * 0.3; // seeds start at different times
      if (raw[ii] > top) top = raw[ii];
    }
    for (var e = 0; e < cells.length; e++) {
      var ei = cells[e];
      born[ei] = (raw[ei] / top) * 0.9 + rnd(ei, 10) * 0.1;
    }
  }

  /* Tiles that light up red at random, each on its own slow cycle. */
  function blinkers(n) {
    var list = [];
    for (var i = 0; i < n; i++) if (rnd(i, 8) < CFG.spark) list.push(i);
    sIdx = new Int32Array(list);
    sT = new Float32Array(list.length);
    sP = new Float32Array(list.length);
    for (var k = 0; k < list.length; k++) {
      sT[k] = 2.5 + rnd(list[k], 11) * 5;
      sP[k] = rnd(list[k], 12);
    }
  }

  /* The lines between the tiles, drawn once. */
  function drawGrout() {
    grout.width = Wd;
    grout.height = Hd;
    var g = grout.getContext("2d");
    var w = Math.max(1, Math.round(P * CFG.gap));
    g.fillStyle = CFG.line;
    for (var c = 1; c <= cols; c++) g.fillRect(c * P - w, 0, w, Hd);
    for (var r = 1; r <= rows; r++) g.fillRect(0, r * P - w, Wd, w);
  }

  /* ----------------------------------------------------------- scroll state */

  /* Two scroll models: the inner container on desktop, the window on phones.
     Both read as px scrolled into the track. */
  function scrollPos() {
    var top = phone.matches ? 0 : scroller.getBoundingClientRect().top;
    return top - track.getBoundingClientRect().top;
  }

  function setScroll(px) {
    if (phone.matches) {
      window.scrollTo(
        0,
        track.getBoundingClientRect().top + window.pageYOffset + px
      );
    } else {
      scroller.scrollTop = px;
    }
  }

  function measure() {
    var u = scrollPos() / cycle;
    target = CFG.loop ? u : clamp(u, 0, 1);

    /* First reading, or no easing: land on it without gliding from the top. */
    if (!primed || CFG.glide <= 0) {
      primed = true;
      progress = target;
      apply();
    }
  }

  /* Looping: the first and last frame of a pass are the same picture, so the
     scroll position can be moved by whole passes without anything changing on
     screen. That keeps the reader in the middle of a long track. It happens at
     once near either end, and otherwise once scrolling has paused, because
     moving the scroll mid-flick can cut short momentum on some phones. */
  function recentre(paused) {
    if (!CFG.loop) return;
    var u = scrollPos() / cycle;
    var mid = Math.floor(passes / 2);
    var edge = u < 0.5 || u > passes - 0.5;
    if (!edge && !(paused && Math.floor(u) !== mid)) return;

    var k = Math.floor(u) - mid;
    if (!k) return;
    setScroll((u - k) * cycle);
    target -= k;
    progress -= k;
  }

  function apply() {
    var p = CFG.loop ? progress - Math.floor(progress) : clamp(progress, 0, 1);

    var away = ease(range(p, CFG.away[0], CFG.away[1]));
    var back = ease(range(p, CFG.back[0], CFG.back[1]));
    scrollD = away * (1 - back);
  }

  /* ---------------------------------------------------------------- drawing */

  function loop(now) {
    if (dead) return;

    if (scrolled) {
      scrolled = false;
      measure();
      recentre(false);
    } else if (settle && now - lastScroll > 160) {
      settle = false;
      recentre(true);
    }

    /* Wheel notches arrive in steps. Easing the position toward the scroll
       target turns each step into a short glide. */
    var dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
    last = now;
    if (progress !== target) {
      var gap = target - progress;
      progress =
        Math.abs(gap) < 0.0002
          ? target
          : progress + gap * (1 - Math.exp(-dt / CFG.glide));
      apply();
    }

    var k = clamp((now - t0) / CFG.intro, 0, 1);
    var d = Math.max(1 - soft(k), scrollD);
    render(now / 1000, 1 - d);

    requestAnimationFrame(loop);
  }

  /* form runs from 0 (empty mosaic) to 1 (paperclips fully grown). */
  function render(t, form) {
    var growing = form > 0.001 && form < 0.999;
    var moving = form !== lastForm || growing || forceBase;

    /* Once nothing is growing only the blinking tiles change, so draw less. */
    if (!moving && t - lastDraw < 1 / 24) return;
    lastDraw = t;

    if (moving) {
      tiles(form, t, growing);
      lastForm = form;
      forceBase = false;
    }

    buf.set(base);
    blink(form, t);

    lctx.putImageData(imgData, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(lo, 0, 0, cols * P, rows * P);
    ctx.drawImage(grout, 0, 0);
  }

  /* Colour every tile: empty ones grey, and the ones the paperclips have
     reached blended toward their red. The growing edge flickers slightly. */
  function tiles(form, t, growing) {
    var n = cols * rows;
    var top = form * (1 + SOFT);
    var wa = growing ? WOBBLE : 0;

    for (var i = 0; i < n; i++) {
      var tw = 255;
      var c = 0xffffffff;

      if (onMark[i]) {
        var thr = born[i];
        if (wa) thr += wa * Math.sin(t * 2.1 + wob[i]);
        var s = (top - thr) / SOFT;
        if (s > 0) {
          if (s > 1) s = 1;
          var e = s * s * (3 - 2 * s);
          var k = ink[i];
          var r = k & 255;
          var g = (k >> 8) & 255;
          var b = (k >> 16) & 255;
          c =
            ((tw + (r - tw) * e) | 0) |
            (((tw + (g - tw) * e) | 0) << 8) |
            (((tw + (b - tw) * e) | 0) << 16) |
            0xff000000;
        }
      }
      base[i] = c;
    }
  }

  /* A few tiles light up red and fade on their own slow cycles. Once the
     paperclips are grown their own tiles glint. */
  function blink(form, t) {
    var lively = 0.55 + 0.45 * 4 * form * (1 - form);

    for (var k = 0; k < sIdx.length; k++) {
      var u = (t / sT[k] + sP[k]) % 1;
      if (u >= DUTY) continue;

      var s = Math.sin((Math.PI * u) / DUTY);
      var env = s * s;
      var i = sIdx[k];
      var tr;
      var tg;
      var tb;
      var st;

      if (onMark[i]) {
        if (form < 0.98) continue;
        tr = 255;
        tg = 190;
        tb = 178;
        st = 0.55 * env;
      } else {
        tr = 232;
        tg = 58;
        tb = 50;
        st = 0.62 * env * lively;
      }

      var c = buf[i];
      var r = c & 255;
      var g = (c >> 8) & 255;
      var b = (c >> 16) & 255;
      buf[i] =
        ((r + (tr - r) * st) | 0) |
        (((g + (tg - g) * st) | 0) << 8) |
        (((b + (tb - b) * st) | 0) << 16) |
        0xff000000;
    }
  }
})();
