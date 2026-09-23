/* Pelume mark: renders the paperclips once as a mosaic of small red tiles,
   cropped into the corner of the hero by its own box. Static — it does not
   grow, blink, or respond to scrolling or hovering. Redraws only if the box
   is resized (e.g. the window changing width). */

(function () {
  "use strict";

  var box = document.querySelector("[data-mark]");
  var img = box && box.querySelector("img");
  if (!box || !img) return;

  var CFG = {
    across: 46, // tiles across the box: higher is finer
    minTile: 4, // smallest tile, in px
    gap: 0.16, // gap between tiles, as a share of a tile
    source: 1200 // px the SVG is rasterised at, once
  };

  /* Repeatable random number 0..1 for a tile and a purpose, so the same tile
     always gets the same small variation and the mosaic does not reshuffle
     when it is redrawn. */
  function rnd(i, k) {
    var h = Math.imul(i + 1, 374761393) + Math.imul(k + 1, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  var canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  var ctx = canvas.getContext("2d");

  var mips = []; // the mark at 1, 1/2, 1/4 ... scale, for a clean downsample
  var source = null;

  loadMark(function (s) {
    source = s;
    buildMips(source);
    box.insertBefore(canvas, box.firstChild);
    box.classList.add("is-live");
    paint();
  }, bail);

  window.addEventListener("resize", debounce(paint, 150));

  function bail() {
    // Fetch failed, or SVG decoding is unsupported: the plain <img> stands.
  }

  /* ---------------------------------------------------------- the paperclips */

  /* The SVG is fetched as text so its size can be set to CFG.source before it
     is drawn, which keeps it sharp however large the box turns out to be.
     Over file://, the fetch is blocked, so the <img> is used as it is. */
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

  function buildMips(src) {
    var s = CFG.source;
    var c0 = document.createElement("canvas");
    c0.width = c0.height = s;
    c0.getContext("2d").drawImage(src, 0, 0, s, s);
    mips = [{ c: c0, s: s }];

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

  /* --------------------------------------------------------------- painting */

  function paint() {
    if (!source || !mips.length) return;

    var w = box.clientWidth;
    var h = box.clientHeight;
    if (!w || !h) return;

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var Wd = Math.max(1, Math.round(w * dpr));
    var Hd = Math.max(1, Math.round(h * dpr));
    canvas.width = Wd;
    canvas.height = Hd;

    var P = Math.max(CFG.minTile, Math.round(Math.min(Wd, Hd) / CFG.across));
    var cols = Math.ceil(Wd / P);
    var rows = Math.ceil(Hd / P);

    // Sample the mark at one pixel per tile, picking the mip closest to that
    // size so the downsample stays clean rather than aliased.
    var m = 0;
    while (m + 1 < mips.length && mips[m + 1].s >= Math.max(cols, rows)) m++;

    var probe = document.createElement("canvas");
    probe.width = cols;
    probe.height = rows;
    var pctx = probe.getContext("2d");
    pctx.imageSmoothingEnabled = true;
    pctx.imageSmoothingQuality = "high";
    pctx.drawImage(mips[m].c, 0, 0, cols, rows);

    var px;
    try {
      px = pctx.getImageData(0, 0, cols, rows).data;
    } catch (e) {
      return; // getImageData can fail over file://; the plain <img> stands.
    }

    ctx.clearRect(0, 0, Wd, Hd);
    var gap = Math.max(1, Math.round(P * CFG.gap));
    var side = P - gap;

    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        var i = y * cols + x;
        if (px[i * 4 + 3] < 110) continue; // outside the paperclips

        var v = 0.93 + rnd(i, 9) * 0.14; // each tile a little different
        var r = Math.min(255, px[i * 4] * v) | 0;
        var g = Math.min(255, px[i * 4 + 1] * v) | 0;
        var b = Math.min(255, px[i * 4 + 2] * v) | 0;

        ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
        ctx.fillRect(x * P, y * P, side, side);
      }
    }
  }
})();
