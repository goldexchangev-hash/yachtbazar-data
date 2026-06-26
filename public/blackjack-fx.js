/* ============================================================
   blackjack-fx.js — lightweight, self-contained win celebration. A fixed
   full-screen canvas confetti burst + a popping win banner. No dependencies
   (the felt itself is DOM/CSS), so the page stays light. Tiered by outcome:
   a normal win sparkles; a blackjack erupts in gold.
     BlackjackFX.celebrate("win"|"blackjack", deltaUsd)
   ============================================================ */
(function (root) {
  "use strict";
  var COLORS = ["#39e7ff", "#45f0a6", "#ffd23f", "#ff4d9d", "#ffffff"];
  var GOLD = ["#ffd23f", "#ffe9a0", "#ff8a3d", "#fff5cf", "#ffc24d"];
  var canvas, ctx, parts = [], raf = 0, banner, bannerT = 0;

  function ensure() {
    if (canvas) return;
    canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:60";
    document.body.appendChild(canvas);
    ctx = canvas.getContext("2d");
    resize(); root.addEventListener("resize", resize);
    banner = document.createElement("div");
    banner.style.cssText = "position:fixed;left:50%;top:38%;transform:translate(-50%,-50%) scale(.4);opacity:0;" +
      "font-family:'Press Start 2P',monospace;font-size:26px;text-align:center;z-index:61;pointer-events:none;" +
      "text-shadow:0 3px 0 #04060f,0 0 24px rgba(255,210,63,.7);transition:transform .3s cubic-bezier(.2,1.4,.3,1),opacity .3s;white-space:nowrap";
    document.body.appendChild(banner);
  }
  function resize() { if (!canvas) return; canvas.width = root.innerWidth; canvas.height = root.innerHeight; }

  function burst(n, palette, power) {
    var cx = root.innerWidth / 2, cy = root.innerHeight * 0.4;
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, sp = (2 + Math.random() * 6) * power;
      parts.push({ x: cx + (Math.random() - 0.5) * 80, y: cy + (Math.random() - 0.5) * 40,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 4, g: 0.12 + Math.random() * 0.08,
        s: 4 + Math.random() * 6, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        c: palette[(Math.random() * palette.length) | 0], life: 70 + Math.random() * 50, t: 0,
        shape: Math.random() < 0.5 ? "rect" : "circ" });
    }
    if (!raf) loop();
  }

  function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i]; p.t++; p.vy += p.g; p.x += p.vx; p.y += p.vy; p.vx *= 0.99; p.r += p.vr;
      var k = 1 - p.t / p.life; if (k <= 0) { parts.splice(i, 1); continue; }
      ctx.save(); ctx.globalAlpha = Math.max(0, k); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
      if (p.shape === "rect") ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 1.6);
      else { ctx.beginPath(); ctx.arc(0, 0, p.s / 1.6, 0, 7); ctx.fill(); }
      ctx.restore();
    }
    if (banner && bannerT) { bannerT--; if (bannerT === 0) { banner.style.opacity = "0"; banner.style.transform = "translate(-50%,-50%) scale(.6)"; } }
    if (parts.length || bannerT) raf = requestAnimationFrame(loop);
    else { raf = 0; ctx.clearRect(0, 0, canvas.width, canvas.height); }
  }

  function showBanner(html, color) {
    banner.innerHTML = html; banner.style.color = color;
    banner.style.opacity = "1"; banner.style.transform = "translate(-50%,-50%) scale(1)";
    bannerT = 90; if (!raf) loop();
  }

  function celebrate(outcome, delta) {
    ensure();
    var amt = delta > 0 ? "+$" + (Math.round(delta * 100) / 100).toLocaleString() : "";
    if (outcome === "blackjack") {
      burst(160, GOLD, 1.5);
      showBanner('<span style="color:#ffd23f">BLACKJACK!</span><br><span style="font-size:16px;color:#fff">' + amt + "</span>", "#ffd23f");
    } else {
      burst(90, COLORS, 1.1);
      showBanner('<span style="color:#45f0a6">YOU WIN</span><br><span style="font-size:16px;color:#fff">' + amt + "</span>", "#45f0a6");
    }
  }

  root.BlackjackFX = { celebrate: celebrate };
})(typeof window !== "undefined" ? window : this);
