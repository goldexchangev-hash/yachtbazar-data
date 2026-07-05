/* ============================================================
   lenny.js — LENNY, the anxious sweaty mascot who dances on every win.

   Drop-in, zero-dependency, no build step. Any Crypto TV channel calls
   ONE line on its win:

       Lenny.celebrate({ betUsd: 10, winUsd: 4.20 });

   He's a rigged inline-SVG puppet (separate head / eyes / hair / arms /
   legs) animated via the Web Animations API off a single intensity knob
   derived from the BET — bigger bet = bigger, wilder, funnier dance, from
   a shy corner shimmy ("The Nervous Nibble") up to a full-screen takeover
   ("Lennygeddon"). The overlay is pointer-events:none so it never blocks
   play, sits over the TV screen, and cleans itself up.

   window.Lenny = { mount, celebrate, win, stop, config }
   ============================================================ */
(function () {
  "use strict";
  var SVGNS = "http://www.w3.org/2000/svg";

  var cfg = {
    container: "#tv-screen",   // the TV screen element the overlay covers
    enabled: true,
    minBetUsd: 10,
    maxBetUsd: 5000,           // bet that maps to full intensity
    jackpotBetUsd: 500,        // bet (or huge win) that triggers the takeover
    reducedMotion: "auto",     // 'auto' | 'off' (force motion) | 'force' (force static)
  };

  var host = null;     // overlay <div>
  var lennyEl = null;  // the main Lenny <svg>
  var fxCanvas = null, fxCtx = null;
  var textEl = null;
  var clones = [];
  var anims = [];      // active WAAPI animations to cancel
  var particles = [];
  var fxRAF = 0;
  var busy = false;
  var hideTimer = 0;
  var styleInjected = false;

  /* ---------------- reduced motion ---------------- */
  function reduced() {
    if (cfg.reducedMotion === "force") return true;
    if (cfg.reducedMotion === "off") return false;
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  /* ---------------- styles ---------------- */
  function injectStyle() {
    if (styleInjected) return; styleInjected = true;
    var css =
      "#lenny-overlay{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:40;}" +
      "#lenny-overlay .lenny-fx{position:absolute;inset:0;width:100%;height:100%;}" +
      "#lenny-overlay .lenny-svg{position:absolute;right:1%;bottom:-2%;height:34%;width:auto;filter:drop-shadow(0 6px 10px rgba(0,0,0,.5));opacity:0;will-change:transform;}" +
      "#lenny-overlay .lenny-svg.clone{opacity:0;}" +
      "#lenny-overlay .lenny-text{position:absolute;left:50%;top:30%;transform:translate(-50%,-50%);font-family:'Bungee','Press Start 2P',sans-serif;color:#ffd23f;text-shadow:0 0 14px rgba(255,210,63,.7),3px 3px 0 #1a0712;opacity:0;white-space:nowrap;}" +
      "#lenny-overlay .ln g{transform-box:fill-box;}" +
      "#lenny-overlay .ln .ln-root{transform-origin:50% 100%;}" +
      "#lenny-overlay .ln .ln-body{transform-origin:50% 8%;}" +
      "#lenny-overlay .ln .ln-head{transform-origin:50% 96%;}" +
      "#lenny-overlay .ln .ln-hair{transform-origin:50% 92%;}" +
      "#lenny-overlay .ln .ln-earL,#lenny-overlay .ln .ln-earR{transform-origin:50% 50%;}" +
      "#lenny-overlay .ln .ln-armL,#lenny-overlay .ln .ln-armR{transform-origin:50% 6%;}" +
      "#lenny-overlay .ln .ln-foreL,#lenny-overlay .ln .ln-foreR{transform-origin:50% 4%;}" +
      "#lenny-overlay .ln .ln-legL,#lenny-overlay .ln .ln-legR{transform-origin:50% 4%;}" +
      "#lenny-overlay .ln .ln-eyes{transform-origin:50% 50%;}" +
      "#lenny-overlay .ln .ln-mouth{transform-origin:50% 50%;}";
    var s = document.createElement("style");
    s.id = "lenny-style"; s.textContent = css;
    document.head.appendChild(s);
  }

  /* ---------------- the rigged Lenny puppet (inline SVG) ---------------- */
  function lennySVG() {
    return '' +
'<svg class="lenny-svg ln" viewBox="0 0 200 340" xmlns="' + SVGNS + '" aria-hidden="true">' +
'<defs>' +
  '<filter id="ln-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
'</defs>' +
'<g class="ln-root">' +
  // shadow handled by CSS drop-shadow
  // legs
  '<g class="ln-legL"><rect x="84" y="232" width="13" height="84" rx="6" fill="#23262e"/><path d="M80 314 q-2 12 10 14 h16 q4-2 0-8 l-12-6 z" fill="#0c0d12"/></g>' +
  '<g class="ln-legR"><rect x="103" y="232" width="13" height="84" rx="6" fill="#23262e"/><path d="M120 314 q2 12 -10 14 h-16 q-4-2 0-8 l12-6 z" fill="#0c0d12"/></g>' +
  // body / jacket
  '<g class="ln-body">' +
    '<path d="M68 116 q32-16 64 0 l8 110 q-40 16 -80 0 z" fill="#2a2d35"/>' +    // jacket
    '<path d="M92 116 l8 14 8-14 -2 104 -12 0 z" fill="#f2f4fb"/>' +             // shirt V
    '<path d="M96 130 l8 0 3 80 -7 8 -7-8 z" fill="#ffffff" stroke="#cfd6ee" stroke-width="1"/>' + // white tie
    '<path d="M68 116 q-10 40 -6 96 l10 4 -2-96 z" fill="#23262e"/>' +          // lapel L
    '<path d="M132 116 q10 40 6 96 l-10 4 2-96 z" fill="#23262e"/>' +           // lapel R
    // arms (shoulder -> forearm -> hand)
    '<g class="ln-armL"><rect x="56" y="118" width="15" height="56" rx="7" fill="#2a2d35"/>' +
      '<g class="ln-foreL"><rect x="55" y="168" width="14" height="50" rx="7" fill="#2a2d35"/>' +
        '<ellipse cx="62" cy="222" rx="11" ry="13" fill="#c2c6cf"/><ellipse cx="62" cy="222" rx="7" ry="9" fill="#d7dbe2"/></g></g>' +
    '<g class="ln-armR"><rect x="129" y="118" width="15" height="56" rx="7" fill="#2a2d35"/>' +
      '<g class="ln-foreR"><rect x="131" y="168" width="14" height="50" rx="7" fill="#2a2d35"/>' +
        '<ellipse cx="138" cy="222" rx="11" ry="13" fill="#c2c6cf"/><ellipse cx="138" cy="222" rx="7" ry="9" fill="#d7dbe2"/></g></g>' +
    // head
    '<g class="ln-head">' +
      '<g class="ln-earL"><ellipse cx="58" cy="74" rx="13" ry="20" fill="#b6bac4"/><ellipse cx="60" cy="74" rx="6" ry="11" fill="#8e93a0"/></g>' +
      '<g class="ln-earR"><ellipse cx="142" cy="74" rx="13" ry="20" fill="#b6bac4"/><ellipse cx="140" cy="74" rx="6" ry="11" fill="#8e93a0"/></g>' +
      '<path d="M66 64 q34-30 68 0 q10 44 -6 70 q-28 22 -56 0 q-16-26 -6-70 z" fill="#c2c6cf"/>' + // skull
      '<g class="ln-eyes" filter="url(#ln-glow)"><circle cx="86" cy="70" r="14" fill="#ffffff"/><circle cx="114" cy="70" r="14" fill="#ffffff"/></g>' +
      '<path d="M96 92 q4 6 8 0" fill="none" stroke="#7a7f8c" stroke-width="2"/>' + // nose
      '<g class="ln-mouth"><rect x="84" y="104" width="32" height="16" rx="4" fill="#3a3f4b"/>' +
        '<rect x="86" y="106" width="28" height="6" fill="#eef1ff"/><rect x="86" y="113" width="28" height="5" fill="#dfe4f2"/>' +
        '<line x1="95" y1="105" x2="95" y2="119" stroke="#9aa0b0" stroke-width="1.2"/><line x1="105" y1="105" x2="105" y2="119" stroke="#9aa0b0" stroke-width="1.2"/></g>' +
      // sweat
      '<circle class="ln-sweat" cx="72" cy="92" r="3.4" fill="#bfe9ff"/>' +
      '<circle class="ln-sweat" cx="130" cy="86" r="3" fill="#bfe9ff"/>' +
      // hair (wild spikes)
      '<g class="ln-hair"><path d="M64 60 q-6-26 8-30 q-2-14 12-14 q6-12 18-8 q10-10 22-2 q14-4 16 10 q16 2 10 20 q10 6 2 18 q-12-16 -22-10 q-6-12 -18-8 q-10-10 -22-2 q-12-4 -18 8 q-10-2 -8 14 z" fill="#15161c"/></g>' +
    '</g>' +
  '</g>' +
'</g>' +
'</svg>';
  }

  /* ---------------- mount ---------------- */
  function resolveContainer(el) {
    if (el && el.nodeType === 1) return el;
    if (typeof el === "string") return document.querySelector(el);
    return document.querySelector(cfg.container);
  }

  function mount(el) {
    injectStyle();
    var container = resolveContainer(el);
    if (!container) return false;
    if (host && host.parentNode === container) return true;
    if (host && host.parentNode) host.parentNode.removeChild(host);

    var cs = window.getComputedStyle(container);
    if (cs.position === "static") container.style.position = "relative";

    host = document.createElement("div");
    host.id = "lenny-overlay";
    host.setAttribute("role", "presentation");
    host.setAttribute("aria-hidden", "true");
    host.innerHTML =
      '<canvas class="lenny-fx"></canvas>' +
      lennySVG() +
      '<div class="lenny-text"></div>';
    container.appendChild(host);

    fxCanvas = host.querySelector(".lenny-fx");
    fxCtx = fxCanvas.getContext("2d");
    lennyEl = host.querySelector(".lenny-svg");
    textEl = host.querySelector(".lenny-text");
    sizeCanvas();
    try { new ResizeObserver(sizeCanvas).observe(container); }
    catch (e) { window.addEventListener("resize", sizeCanvas); }
    return true;
  }

  function sizeCanvas() {
    if (!host || !fxCanvas) return;
    var r = host.getBoundingClientRect();
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    fxCanvas.width = Math.max(1, Math.round(r.width * dpr));
    fxCanvas.height = Math.max(1, Math.round(r.height * dpr));
    fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fxCanvas._w = r.width; fxCanvas._h = r.height;
  }

  /* ---------------- WAAPI helpers ---------------- */
  function A(el, frames, opts) {
    if (!el) return null;
    var a = el.animate(frames, opts);
    anims.push(a);
    return a;
  }
  function loop(el, frames, dur, opts) {
    opts = opts || {};
    return A(el, frames, { duration: dur, iterations: Infinity, easing: opts.easing || "ease-in-out", direction: opts.direction || "alternate", delay: opts.delay || 0 });
  }
  function q(root, sel) { return root.querySelector(sel); }

  /* ---------------- the dance ---------------- */
  function danceOn(svg, i, opts) {
    opts = opts || {};
    var ph = opts.phase || 0;                 // phase offset for clones
    var dur = 1150 - i * 640;                 // faster when wilder
    var rootG = q(svg, ".ln-root"), head = q(svg, ".ln-head"), hair = q(svg, ".ln-hair");
    var armL = q(svg, ".ln-armL"), armR = q(svg, ".ln-armR"), foreL = q(svg, ".ln-foreL"), foreR = q(svg, ".ln-foreR");
    var legL = q(svg, ".ln-legL"), legR = q(svg, ".ln-legR"), eyes = q(svg, ".ln-eyes"), mouth = q(svg, ".ln-mouth");
    var earL = q(svg, ".ln-earL"), earR = q(svg, ".ln-earR");

    var hop = 6 + i * 26, lean = 2 + i * 9, sw = 8 + i * 26;
    var flail = 10 + i * 130;                 // arm swing degrees
    var fore = 15 + i * 95;
    var kick = i > 0.35 ? (10 + i * 55) : 4;

    // root: hop + squash + lean
    loop(rootG, [
      { transform: "translateY(0) scale(1,1) rotate(-" + lean + "deg)" },
      { transform: "translateY(-" + hop + "px) scale(" + (1 - i * 0.06) + "," + (1 + i * 0.1) + ") rotate(" + lean + "deg)" },
    ], dur, { delay: ph });
    // head bob + tilt
    loop(head, [{ transform: "translateY(0) rotate(-" + (4 + i * 12) + "deg)" }, { transform: "translateY(-" + (2 + i * 5) + "px) rotate(" + (4 + i * 12) + "deg)" }], dur * 0.92, { delay: ph });
    // hair overshoot whip
    loop(hair, [{ transform: "rotate(" + (8 + i * 26) + "deg)" }, { transform: "rotate(-" + (8 + i * 26) + "deg)" }], dur * 0.8, { delay: ph + 40 });
    // arms flail, out of phase
    loop(armL, [{ transform: "rotate(" + (sw) + "deg)" }, { transform: "rotate(-" + flail + "deg)" }], dur * 0.7, { delay: ph });
    loop(armR, [{ transform: "rotate(-" + (sw) + "deg)" }, { transform: "rotate(" + flail + "deg)" }], dur * 0.7, { delay: ph + dur * 0.35 });
    loop(foreL, [{ transform: "rotate(" + (fore * 0.4) + "deg)" }, { transform: "rotate(-" + fore + "deg)" }], dur * 0.5, { delay: ph });
    loop(foreR, [{ transform: "rotate(-" + (fore * 0.4) + "deg)" }, { transform: "rotate(" + fore + "deg)" }], dur * 0.5, { delay: ph + 60 });
    // legs knock/kick
    loop(legL, [{ transform: "rotate(" + kick + "deg)" }, { transform: "rotate(-" + (kick * 0.5) + "deg)" }], dur * 0.85, { delay: ph });
    loop(legR, [{ transform: "rotate(-" + kick + "deg)" }, { transform: "rotate(" + (kick * 0.5) + "deg)" }], dur * 0.85, { delay: ph + dur * 0.4 });
    // ears flap on big bets
    if (i > 0.5) { loop(earL, [{ transform: "rotate(0)" }, { transform: "rotate(-" + (i * 20) + "deg)" }], dur * 0.6); loop(earR, [{ transform: "rotate(0)" }, { transform: "rotate(" + (i * 20) + "deg)" }], dur * 0.6); }
    // eyes bug-out pop
    loop(eyes, [{ transform: "scale(1,1)" }, { transform: "scale(" + (1.15 + i * 0.45) + "," + (1.15 + i * 0.55) + ")" }, { transform: "scale(1,1)" }], dur * 1.1, { direction: "normal", easing: "ease-out" });
    // mouth shout
    loop(mouth, [{ transform: "scaleY(1)" }, { transform: "scaleY(" + (1.1 + i * 0.7) + ")" }], dur * 0.6, { delay: ph });

    // occasional 360 twirl at high intensity
    if (i > 0.6 && !opts.noTwirl) {
      A(svg, [{ transform: "scaleX(1)" }, { transform: "scaleX(-1)" }, { transform: "scaleX(1)" }],
        { duration: 700, iterations: Infinity, easing: "ease-in-out", delay: 600 });
    }
  }

  /* ---------------- particles ---------------- */
  var COIN = "#ffd23f", CONF = ["#39e7ff", "#ff4d9d", "#ffd23f", "#45f0a6", "#ffffff", "#ff8a3d"];
  function burst(n, theme) {
    if (!fxCanvas) return;
    var w = fxCanvas._w, h = fxCanvas._h;
    for (var k = 0; k < n; k++) {
      var fromCorner = Math.random() < 0.5;
      var x = fromCorner ? (Math.random() < 0.5 ? 0 : w) : rnd(w * 0.3, w * 0.9);
      var y = fromCorner ? h : rnd(h * 0.4, h);
      var ang = -Math.PI / 2 + rnd(-0.8, 0.8);
      var spd = rnd(180, 60 + h * 1.1);
      particles.push({
        x: x, y: y, vx: Math.cos(ang) * spd + (fromCorner ? (x < w / 2 ? spd * 0.5 : -spd * 0.5) : 0),
        vy: Math.sin(ang) * spd, life: rnd(0.9, 1.9), max: 1.9,
        sz: theme === "coin" ? rnd(6, 11) : rnd(4, 9),
        rot: rnd(0, 6.28), vr: rnd(-9, 9),
        col: theme === "coin" ? COIN : CONF[k % CONF.length], coin: theme === "coin",
      });
    }
    if (!fxRAF) fxRAF = requestAnimationFrame(stepFx);
  }
  var lastT = 0;
  function stepFx(t) {
    if (!fxCtx) { fxRAF = 0; return; }
    var dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0.016; lastT = t;
    fxCtx.clearRect(0, 0, fxCanvas._w, fxCanvas._h);
    for (var k = particles.length - 1; k >= 0; k--) {
      var p = particles[k];
      p.vy += 900 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt; p.life -= dt;
      if (p.life <= 0 || p.y > fxCanvas._h + 30) { particles.splice(k, 1); continue; }
      fxCtx.save(); fxCtx.translate(p.x, p.y); fxCtx.rotate(p.rot);
      fxCtx.globalAlpha = clamp(p.life / 0.5, 0, 1); fxCtx.fillStyle = p.col;
      if (p.coin) { fxCtx.beginPath(); fxCtx.arc(0, 0, p.sz, 0, 6.28); fxCtx.fill(); fxCtx.fillStyle = "#fff3b0"; fxCtx.beginPath(); fxCtx.arc(-p.sz * 0.25, -p.sz * 0.25, p.sz * 0.4, 0, 6.28); fxCtx.fill(); }
      else fxCtx.fillRect(-p.sz / 2, -p.sz / 2, p.sz, p.sz * 0.6);
      fxCtx.restore();
    }
    if (particles.length) fxRAF = requestAnimationFrame(stepFx);
    else { fxRAF = 0; lastT = 0; if (fxCtx) fxCtx.clearRect(0, 0, fxCanvas._w, fxCanvas._h); }
  }

  function shake(px) {
    var c = host && host.parentNode;
    if (!c || reduced()) return;
    A(c, [{ transform: "translate(0,0)" }, { transform: "translate(" + px + "px," + (-px) + "px)" }, { transform: "translate(" + (-px) + "px," + px + "px)" }, { transform: "translate(0,0)" }],
      { duration: 320, iterations: Math.round(2 + px / 6), easing: "ease-in-out" });
  }

  function floatText(txt, big) {
    if (!textEl) return;
    textEl.textContent = txt;
    textEl.style.fontSize = (big ? "clamp(22px,7vw,54px)" : "clamp(14px,4vw,28px)");
    A(textEl, [
      { opacity: 0, transform: "translate(-50%,-30%) scale(0.6)" },
      { opacity: 1, transform: "translate(-50%,-55%) scale(1.08)", offset: 0.25 },
      { opacity: 1, transform: "translate(-50%,-60%) scale(1)", offset: 0.75 },
      { opacity: 0, transform: "translate(-50%,-90%) scale(1)" },
    ], { duration: big ? 2200 : 1500, easing: "ease-out" });
  }

  /* ---------------- celebrate (the public trigger) ---------------- */
  function fmtUsd(n) { return "$" + (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  function celebrate(o) {
    o = o || {};
    if (!cfg.enabled) return;
    if (!host) { if (!mount()) return; }
    var bet = Math.max(cfg.minBetUsd, +o.betUsd || cfg.minBetUsd);
    var win = +o.winUsd || 0;
    var jackpot = bet >= cfg.jackpotBetUsd || (win > 0 && win >= bet * 8);
    // continuous intensity from the BET (log scale): minBet -> 0, maxBet -> 1
    var i = clamp(Math.log(bet / cfg.minBetUsd) / Math.log(cfg.maxBetUsd / cfg.minBetUsd), 0, 1);

    // re-entrant: a new win just refreshes, never stacks
    stop(true);
    busy = true;

    if (reduced()) { return reducedCelebrate(win); }

    sizeCanvas();
    var dur = jackpot ? 4200 : (1400 + i * 2600);   // total stage time
    var size = jackpot ? 82 : (32 + i * 40);        // % of overlay height

    // entrance: pop up from the bottom edge with a BWAH overshoot
    lennyEl.style.height = size + "%";
    lennyEl.style.right = jackpot ? "50%" : "1%";
    lennyEl.style.transform = jackpot ? "translateX(50%)" : "none";
    lennyEl.style.zIndex = "3";   // main Lenny in front of his translucent clones
    A(lennyEl, [
      { opacity: 0, transform: (jackpot ? "translateX(50%) " : "") + "translateY(60%) scaleY(.7)" },
      { opacity: 1, transform: (jackpot ? "translateX(50%) " : "") + "translateY(-6%) scaleY(1.12)", offset: 0.55 },
      { opacity: 1, transform: (jackpot ? "translateX(50%) " : "") + "translateY(0) scaleY(1)" },
    ], { duration: 360, easing: "cubic-bezier(.2,1.5,.4,1)", fill: "forwards" });

    danceOn(lennyEl, i, {});

    // FX scaled by intensity
    var pcount = Math.round(20 + i * 230);
    burst(pcount, win >= bet ? "coin" : "confetti");
    if (i > 0.25) shake(4 + i * 16);
    if (win > 0) floatText("+" + fmtUsd(win), jackpot || i > 0.55);

    // clones for bigger bets
    spawnClones(i, jackpot, dur);

    if (jackpot) {
      floatText("JACKPOT!", true);
      setTimeout(function () { burst(180, "coin"); shake(20); }, 250);
      // after the peak, shrink back to the corner to finish as a normal shimmy
      setTimeout(function () {
        if (!busy) return;
        A(lennyEl, [{ transform: "translateX(50%) scale(1)" }, { transform: "translateX(0) scale(1)" }],
          { duration: 500, easing: "ease-in-out", fill: "forwards" });
        lennyEl.style.height = (40) + "%"; lennyEl.style.right = "1%";
      }, 1800);
    }

    // exit + cleanup
    clearTimeout(hideTimer);
    hideTimer = setTimeout(exit, dur);
  }

  function spawnClones(i, jackpot, dur) {
    var n = jackpot ? 4 : (i > 0.55 ? 2 : i > 0.32 ? 1 : 0);
    if (window.innerWidth < 600) n = Math.ceil(n / 2);
    for (var k = 0; k < n; k++) {
      var c = lennyEl.cloneNode(true);
      c.classList.add("clone");
      c.style.opacity = "0.5";
      c.style.height = (parseFloat(lennyEl.style.height) * rnd(0.55, 0.8)) + "%";
      c.style.right = (jackpot ? (10 + k * 22) : (16 + k * 26)) + "%";
      c.style.zIndex = "1";
      host.insertBefore(c, fxCanvas.nextSibling);
      clones.push(c);
      A(c, [{ opacity: 0 }, { opacity: 0.5 }], { duration: 300, fill: "forwards" });
      danceOn(c, clamp(i * rnd(0.7, 1), 0, 1), { phase: rnd(60, 260), noTwirl: true });
    }
  }

  function reducedCelebrate(win) {
    // accessibility: a calm static pop + a badge, no shake/strobe/clones
    lennyEl.style.height = "40%"; lennyEl.style.right = "1%"; lennyEl.style.transform = "none";
    A(lennyEl, [{ opacity: 0 }, { opacity: 1 }], { duration: 250, fill: "forwards" });
    if (win > 0) floatText("WIN " + fmtUsd(win), false);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(exit, 1600);
  }

  function exit() {
    if (!busy || !lennyEl) return;
    A(lennyEl, [{ opacity: 1, transform: lennyEl.style.transform + " translateY(0) scaleY(1)" },
      { opacity: 1, transform: lennyEl.style.transform + " translateY(-8%) scaleY(1.15)", offset: 0.2 },
      { opacity: 0, transform: lennyEl.style.transform + " translateY(80%) scaleY(.8)" }],
      { duration: 360, easing: "ease-in", fill: "forwards" });
    setTimeout(function () { stop(false); }, 360);
  }

  /* ---------------- stop / teardown ---------------- */
  function stop(keepBusy) {
    clearTimeout(hideTimer);
    for (var k = 0; k < anims.length; k++) { try { anims[k].cancel(); } catch (e) {} }
    anims.length = 0;
    for (var c = 0; c < clones.length; c++) { if (clones[c].parentNode) clones[c].parentNode.removeChild(clones[c]); }
    clones.length = 0;
    if (fxRAF) { cancelAnimationFrame(fxRAF); fxRAF = 0; }
    particles.length = 0; lastT = 0;
    if (fxCtx && fxCanvas) fxCtx.clearRect(0, 0, fxCanvas._w || 0, fxCanvas._h || 0);
    if (lennyEl && !keepBusy) { lennyEl.style.opacity = "0"; lennyEl.style.transform = "none"; }
    if (textEl && !keepBusy) textEl.style.opacity = "0";
    if (host && host.parentNode) { try { host.parentNode.style.transform = ""; } catch (e) {} }
    if (!keepBusy) busy = false;
  }

  function config(o) { if (o) for (var k in o) if (o.hasOwnProperty(k)) cfg[k] = o[k]; return cfg; }

  window.Lenny = { mount: mount, celebrate: celebrate, win: celebrate, stop: function () { stop(false); }, config: config };
})();
