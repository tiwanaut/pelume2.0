/* Pelume home: a white field of large pixels that resolves into the paperclips.
   Scrolling breaks the paperclips back into pixels, brings up the statement
   word by word, then resolves the paperclips again.

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
    intro: 3400, // ms for the first resolve from pixels to paperclips
    delay: 350, // ms of plain white before it starts
    screens: 4, // track length, in stage heights
    markSize: 0.78, // paperclips, as a fraction of the shorter stage side
    coarse: 10, // coarsest block is the longer stage side divided by this
    sway: 0.045, // paperclip rotation drift, radians
    source: 1800, // px the SVG is rasterised at, once

    /* Scroll phases, each as [start, end] over 0..1 of the track. */
    away: [0.02, 0.26], // paperclips break into pixels and fade to white
    show: [0.24, 0.32], // statement fades in
    read: [0.3, 0.62], // words come up from dim to full ink
    hide: [0.7, 0.78], // statement fades out
    back: [0.78, 0.98], // paperclips resolve again
    dim: 0.13, // starting ink of each word
    band: 6 // words that are part way up at any moment
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

  /* --------------------------------------------------------------- state */

  var canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  var ctx = canvas.getContext("2d", { alpha: false });

  var lo = document.createElement("canvas");
  var lctx = lo.getContext("2d");
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
  var progress = 0;
  var scrollD = 0; // 0 sharp, 1 fully pixelated, from scroll alone
  var textShown = 0;
  var scrolled = true;
  var t0 = 0;
  var lastSig = "";
  var sizeKey = "";

  shell.classList.add("is-scene");
  splitWords(text);

  loadMark(
    function (source) {
      buildMips(source);
      grain = lctx.createPattern(makeGrain(), "repeat");
      stage.insertBefore(canvas, stage.firstChild);
      shell.classList.add("is-live");
      layout(true);
      bind();
      t0 = performance.now() + CFG.delay;
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

  /* Light grey noise, one pixel per block while the image is coarse, so the
     white field reads as pixels before any paperclip has come through. */
  function makeGrain() {
    var g = document.createElement("canvas");
    g.width = g.height = 128;
    var x = g.getContext("2d");
    var id = x.createImageData(128, 128);
    for (var i = 0; i < id.data.length; i += 4) {
      var v = 255 - Math.floor(Math.pow(Math.random(), 1.5) * 22);
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
      window.innerHeight,
      window.devicePixelRatio
    ].join("|");
    if (!force && key === sizeKey) return;
    sizeKey = key;

    stage.style.height = container ? h + "px" : "";
    track.style.height = Math.round(stage.offsetHeight * CFG.screens) + "px";

    W = stage.clientWidth;
    H = stage.clientHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    Wd = Math.max(1, Math.round(W * dpr));
    Hd = Math.max(1, Math.round(H * dpr));
    canvas.width = Wd;
    canvas.height = Hd;

    markPx = Math.min(W, H) * CFG.markSize * dpr;
    maxBlock = Math.max(24, Math.round(Math.max(W, H) / CFG.coarse));

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
    };
    window.addEventListener("scroll", flag, { passive: true });
    scroller.addEventListener("scroll", flag, { passive: true });
  }

  /* ----------------------------------------------------------- scroll state */

  /* Two scroll models, as on the letter pages: the inner container on desktop,
     the window on phones. */
  function measure() {
    var top = phone.matches ? 0 : scroller.getBoundingClientRect().top;
    var travel = track.offsetHeight - stage.offsetHeight;
    var gone = top - track.getBoundingClientRect().top;
    progress = travel > 0 ? clamp(gone / travel, 0, 1) : 0;

    var away = ease(range(progress, CFG.away[0], CFG.away[1]));
    var back = ease(range(progress, CFG.back[0], CFG.back[1]));
    scrollD = away * (1 - back);

    textShown =
      ease(range(progress, CFG.show[0], CFG.show[1])) *
      (1 - ease(range(progress, CFG.hide[0], CFG.hide[1])));

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

    var reach =
      range(progress, CFG.read[0], CFG.read[1]) * (words.length + CFG.band);
    for (var i = 0; i < words.length; i++) {
      var t = clamp((reach - i) / CFG.band, 0, 1);
      words[i].style.color =
        "rgba(0,0,0," + (CFG.dim + (1 - CFG.dim) * t).toFixed(3) + ")";
    }
  }

  /* ---------------------------------------------------------------- drawing */

  function loop(now) {
    if (scrolled) {
      scrolled = false;
      measure();
    }

    var k = clamp((now - t0) / CFG.intro, 0, 1);
    var d = Math.max(1 - ease(k), scrollD);
    render(now / 1000, d);

    requestAnimationFrame(loop);
  }

  /* d runs from 0 (sharp paperclips) to 1 (coarse white pixels). */
  function render(t, d) {
    var alpha = 1 - ease(range(d, 0.1, 0.92));
    var block = Math.max(1, Math.round(Math.pow(maxBlock, d)));
    var B = Math.max(1, Math.round(block * dpr));
    var grainAmt = clamp((block - 3) / 24, 0, 1) * (1 - textShown);

    /* Nothing is moving once the paperclips are gone. */
    var sig = alpha < 0.003 ? B + "|" + grainAmt.toFixed(3) : "";
    if (sig && sig === lastSig) return;
    lastSig = sig;

    var angle = Math.sin(t * 0.21) * CFG.sway;
    var lift = Math.sin(t * 0.33) * H * 0.006 * dpr;
    var side = markPx * (1 + 0.1 * d) * (1 + Math.sin(t * 0.37) * 0.008);

    if (B === 1) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, Wd, Hd);
      if (alpha > 0.003) {
        ctx.globalAlpha = alpha;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.save();
        ctx.translate(Wd / 2, Hd / 2 + lift);
        ctx.rotate(angle);
        ctx.drawImage(mips[0].c, -side / 2, -side / 2, side, side);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
      return;
    }

    /* Draw at one pixel per block, then scale up without smoothing. */
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

    if (alpha > 0.003) {
      var s = side / B;
      var m = 0;
      while (m + 1 < mips.length && mips[m + 1].s >= s) m++;

      lctx.imageSmoothingEnabled = true;
      lctx.imageSmoothingQuality = "high";
      lctx.globalAlpha = alpha;
      lctx.save();
      lctx.translate(Wd / 2 / B, (Hd / 2 + lift) / B);
      lctx.rotate(angle);
      lctx.drawImage(mips[m].c, -s / 2, -s / 2, s, s);
      lctx.restore();
      lctx.globalAlpha = 1;
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
})();
