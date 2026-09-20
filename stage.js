/* Pelume home: a white field of fine grain in which the paperclips form pixel
   by pixel, then sharpen. Scrolling breaks them back into pixels, brings up the
   statement word by word, then forms the paperclips again. The scroll loops, so
   there is no end to reach in either direction.

   Progressive enhancement. Without scripting, or with reduced motion, the page
   is the paperclip mark with the statement underneath it. */

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
  var text = shell.querySelector("[data-statement]");
  if (!scroller || !track || !stage || !img) return;

  /* ------------------------------------------------------------ settings */

  var CFG = {
    intro: 3800, // ms for the first resolve from grain to paperclips
    delay: 350, // ms of plain white before it starts
    screens: 4, // one pass of the sequence, in stage heights
    loop: true, // keep scrolling round instead of stopping at the end
    passes: 5, // passes held in the scroll track when looping
    markSize: 0.66, // paperclips, as a fraction of the shorter stage side
    pixel: 8, // px per grain while the paperclips form
    grain: 12, // how dark the grey grain gets, out of 255
    sway: 0.045, // paperclip rotation drift, radians
    source: 1800, // px the SVG is rasterised at, once

    /* Scroll phases, each as [start, end] over 0..1 of the track. */
    away: [0.02, 0.26], // paperclips break into pixels and fade to white
    show: [0.24, 0.32], // statement fades in
    read: [0.3, 0.62], // words come up from dim to full ink
    hide: [0.7, 0.78], // statement fades out
    back: [0.78, 0.98], // paperclips resolve again
    dim: 0.13, // starting ink of each word
    band: 10, // words that are part way up at any moment
    glide: 0.15 // seconds the scroll position takes to catch up (0 = no easing)
  };

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

  /* Repeatable random number for a cell, so the pixels come and go in the same
     order every time and stay put when the window is resized. */
  function hash(x, y) {
    var h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  var SHARP = 0.25; // share of the dissolve spent sharpening the mosaic
  var SOFT = 0.12; // how long each pixel takes to come up, in fill

  /* --------------------------------------------------------------- state */

  var canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  var ctx = canvas.getContext("2d", { alpha: false });

  var lo = document.createElement("canvas");
  var lctx = lo.getContext("2d");
  var mask = document.createElement("canvas");
  var mctx = mask.getContext("2d");
  var maskData = null;
  var rank = null; // per-cell random order for the grain
  var rankW = 0;
  var rankH = 0;
  var grain = null; // fillStyle pattern
  var mips = []; // paperclips at 1, 1/2, 1/4 ... scale, for clean downsampling

  var W = 0;
  var H = 0;
  var dpr = 1;
  var Wd = 0;
  var Hd = 0;
  var markPx = 0;
  var maxBlock = 100;

  var words = [];
  var cycle = 1; // px of scrolling in one pass of the sequence
  var passes = 1;
  var target = 0; // passes scrolled, straight from the scroll position
  var progress = 0; // eased towards target, drives everything on screen
  var primed = false;
  var last = 0;
  var lastScroll = 0;
  var settle = false;
  var reach = 0; // how far the words have come up, 0..1
  var scrollD = 0; // 0 sharp, 1 fully pixelated, from scroll alone
  var textShown = 0;
  var scrolled = true;
  var t0 = 0;
  var lastSig = "";
  var sizeKey = "";

  shell.classList.add("is-scene");
  splitWords(text);

  /* A reload should start at the paperclips, not wherever the browser left it. */
  if (CFG.loop && "scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }

  loadMark(
    function (source) {
      buildMips(source);
      grain = lctx.createPattern(makeGrain(), "repeat");
      stage.insertBefore(canvas, stage.firstChild);
      shell.classList.add("is-live");
      layout(true);
      bind();
      last = performance.now();
      t0 = last + CFG.delay;
      requestAnimationFrame(loop);
    },
    function () {
      /* Could not read the SVG: fall back to the plain page. */
      shell.classList.remove("is-scene");
    }
  );

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
    var base = document.createElement("canvas");
    base.width = base.height = s;
    base.getContext("2d").drawImage(source, 0, 0, s, s);
    mips = [{ c: base, s: s }];

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

  /* Light grey noise, one pixel per grain, so the white field reads as pixels
     before any paperclip has formed. */
  function makeGrain() {
    var g = document.createElement("canvas");
    g.width = g.height = 128;
    var x = g.getContext("2d");
    var id = x.createImageData(128, 128);
    for (var i = 0; i < id.data.length; i += 4) {
      var v = 255 - Math.floor(Math.pow(Math.random(), 1.5) * CFG.grain);
      id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
      id.data[i + 3] = 255;
    }
    x.putImageData(id, 0, 0);
    return g;
  }

  /* --------------------------------------------------------------- layout */

  function layout(force) {
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

    /* The pass length changed, so put the scroll back at the same point in the
       sequence. Looping starts in the middle pass with room either way. */
    if (resized) {
      var mid = CFG.loop ? Math.floor(passes / 2) : 0;
      var at = 0;
      if (primed) at = CFG.loop ? progress - Math.floor(progress) : clamp(progress, 0, 1);
      setScroll((mid + at) * cycle);
      target = progress = mid + at;
    }

    lastSig = "";
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

    textShown =
      ease(range(p, CFG.show[0], CFG.show[1])) *
      (1 - ease(range(p, CFG.hide[0], CFG.hide[1])));

    reach = range(p, CFG.read[0], CFG.read[1]);
    paintText();
  }

  /* --------------------------------------------------------------- statement */

  function splitWords(p) {
    var frag = document.createDocumentFragment();
    p.textContent.split(/(\s+)/).forEach(function (token) {
      if (!token) return;
      if (/^\s+$/.test(token)) {
        frag.appendChild(document.createTextNode(token));
        return;
      }
      var span = document.createElement("span");
      span.className = "word";
      span.textContent = token;
      frag.appendChild(span);
      words.push(span);
    });
    p.textContent = "";
    p.appendChild(frag);
  }

  function paintText() {
    text.style.opacity = textShown.toFixed(3);

    var lit = reach * (words.length + CFG.band);
    for (var i = 0; i < words.length; i++) {
      var t = ease(clamp((lit - i) / CFG.band, 0, 1));
      words[i].style.color =
        "rgba(0,0,0," + (CFG.dim + (1 - CFG.dim) * t).toFixed(3) + ")";
    }
  }

  /* ---------------------------------------------------------------- drawing */

  function loop(now) {
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
    var d = Math.max(1 - ease(k), scrollD);
    render(now / 1000, d);

    requestAnimationFrame(loop);
  }

  /* d runs from 0 (sharp paperclips) to 1 (no paperclips, only grain).
     From 1 down to SHARP the paperclips fill in one grain at a time, in a
     random order. From SHARP down to 0 the grains shrink to single pixels. */
  function render(t, d) {
    var sharpen = d < SHARP;
    var grainPx = Math.max(1, Math.round(CFG.pixel * dpr));
    var B = sharpen ? Math.max(1, Math.round(Math.pow(grainPx, d / SHARP))) : grainPx;
    var fill = sharpen ? 1 : 1 - range(d, SHARP, 1);
    var grainAmt = ease(range(d, 0, 0.5)) * (1 - textShown);

    /* Once no paperclip pixels are showing, nothing moves. */
    var sig = fill < 0.003 ? B + "|" + grainAmt.toFixed(3) : "";
    if (sig && sig === lastSig) return;
    lastSig = sig;

    var angle = Math.sin(t * 0.21) * CFG.sway;
    var lift = Math.sin(t * 0.33) * H * 0.006 * dpr;
    var side = markPx * (1 + 0.1 * d) * (1 + Math.sin(t * 0.37) * 0.008);

    /* Fully sharp: draw straight to the screen at device resolution. */
    if (B === 1) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, Wd, Hd);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.save();
      ctx.translate(Wd / 2, Hd / 2 + lift);
      ctx.rotate(angle);
      ctx.drawImage(mips[0].c, -side / 2, -side / 2, side, side);
      ctx.restore();
      return;
    }

    /* Otherwise draw at one pixel per grain, then scale up without smoothing. */
    var lw = Math.ceil(Wd / B);
    var lh = Math.ceil(Hd / B);
    if (lo.width !== lw || lo.height !== lh) {
      lo.width = lw;
      lo.height = lh;
    }

    lctx.globalCompositeOperation = "source-over";
    lctx.globalAlpha = 1;
    lctx.fillStyle = "#fff";
    lctx.fillRect(0, 0, lw, lh);

    if (fill > 0.003) {
      var s = side / B;
      var m = 0;
      while (m + 1 < mips.length && mips[m + 1].s >= s) m++;

      lctx.imageSmoothingEnabled = true;
      lctx.imageSmoothingQuality = "high";
      lctx.save();
      lctx.translate(Wd / 2 / B, (Hd / 2 + lift) / B);
      lctx.rotate(angle);
      lctx.drawImage(mips[m].c, -s / 2, -s / 2, s, s);
      lctx.restore();

      /* Cover the grains that have not come up yet. */
      if (fill < 0.997) hide(lw, lh, fill);
    }

    if (grainAmt > 0.003) {
      lctx.globalCompositeOperation = "multiply";
      lctx.globalAlpha = grainAmt;
      lctx.fillStyle = grain;
      lctx.fillRect(0, 0, lw, lh);
      lctx.globalCompositeOperation = "source-over";
      lctx.globalAlpha = 1;
    }

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(lo, 0, 0, lw * B, lh * B);
  }

  /* Paint white over every grain whose turn has not come. Each grain has its own
     fixed number; a grain shows once fill passes it, easing in over SOFT. */
  function hide(lw, lh, fill) {
    var n = lw * lh;

    if (!rank || rankW !== lw || rankH !== lh) {
      rank = new Float32Array(n);
      for (var y = 0; y < lh; y++) {
        for (var x = 0; x < lw; x++) rank[y * lw + x] = hash(x, y);
      }
      rankW = lw;
      rankH = lh;
      mask.width = lw;
      mask.height = lh;
      maskData = mctx.createImageData(lw, lh);
      for (var j = 0; j < n * 4; j += 4) {
        maskData.data[j] = maskData.data[j + 1] = maskData.data[j + 2] = 255;
      }
    }

    var px = maskData.data;
    var top = fill * (1 + SOFT);
    for (var i = 0; i < n; i++) {
      var a = (top - rank[i]) / SOFT;
      px[i * 4 + 3] = a <= 0 ? 255 : a >= 1 ? 0 : 255 - a * 255;
    }
    mctx.putImageData(maskData, 0, 0);
    lctx.drawImage(mask, 0, 0);
  }
})();
