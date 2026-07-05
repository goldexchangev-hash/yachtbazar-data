/* ============================================================
   baccarat-fx.js — thin, self-contained win/loss FX for the baccarat felt
   (spec §7). Owner rules, binding:
     WIN  = three layered signals over ~2.5s, nothing full-screen:
            (1) winning zone rim ignites gold and pulses ×2 (CSS class),
            (2) 3–5 chip sprites fly zone → your puck/balance (380ms, 60ms
                stagger, scale 1→0.6, slight arc),
            (3) balance count-up 600ms ease-out + floating green "+$X" +
                a compact "YOU WON $X" pill (spring 180ms, hold 1.6s, fade
                300ms). Tie win adds ONE felt-confined 1.2s confetti burst.
     LOSS = QUIET. Chips fade to 30% and drift down 12px over 600ms. No
            shake, no red flash, no sound, no "YOU LOST".
     PUSH = chips slide back toward your puck with a tiny "returned" note.
   Everything respects prefers-reduced-motion (state changes stay, motion
   goes). No dependencies; card/win SFX live in blackjack-sfx.js (reused).
   ============================================================ */
(function (root) {
  "use strict";
  var doc = root.document;

  function reduced() {
    try { return root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  }
  function money(n) { return "$" + (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
  function center(el) { var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  /* (1) gold zone ignition — the CSS keyframes (.win-glow in baccarat.css)
     do the double pulse; this just gates the class on/off. */
  function winZone(zoneEl, holdMs) {
    if (!zoneEl) return;
    zoneEl.classList.remove("win-glow"); void zoneEl.offsetWidth; // restart the animation
    zoneEl.classList.add("win-glow");
    setTimeout(function () { zoneEl.classList.remove("win-glow"); }, holdMs || 2600);
  }

  /* (2) chip fly — 3–5 fixed-position sprites from a zone to the balance/puck.
     380ms each, 60ms stagger, scale 1→0.6, slight arc via a mid keyframe. */
  function chipFly(fromEl, toEl, count, color) {
    if (!fromEl || !toEl || !doc || !doc.body) return;
    if (reduced()) return; // motion only — the balance/pill still update
    var n = Math.max(3, Math.min(5, count || 4));
    var a = center(fromEl), b = center(toEl);
    for (var i = 0; i < n; i++) (function (i) {
      var chip = doc.createElement("div");
      chip.className = "bacfx-chip";
      chip.style.background = "radial-gradient(circle at 38% 32%, #ffe9a0, " + (color || "#ffd23f") + " 60%, #a8791a 100%)";
      var jx = (Math.random() - 0.5) * 26, jy = (Math.random() - 0.5) * 14;
      chip.style.left = (a.x + jx) + "px"; chip.style.top = (a.y + jy) + "px";
      doc.body.appendChild(chip);
      var dx = b.x - (a.x + jx), dy = b.y - (a.y + jy);
      var arc = -(24 + Math.random() * 22); // rise above the straight line mid-flight
      if (chip.animate) {
        var anim = chip.animate([
          { transform: "translate(-50%,-50%) translate(0px,0px) scale(1)", opacity: 1 },
          { transform: "translate(-50%,-50%) translate(" + (dx * 0.5) + "px," + (dy * 0.5 + arc) + "px) scale(.85)", opacity: 1, offset: 0.55 },
          { transform: "translate(-50%,-50%) translate(" + dx + "px," + dy + "px) scale(.6)", opacity: 0.15 },
        ], { duration: 380, delay: i * 60, easing: "cubic-bezier(.3,.7,.4,1)", fill: "forwards" });
        anim.onfinish = function () { try { chip.remove(); } catch (e) {} };
        setTimeout(function () { try { chip.remove(); } catch (e) {} }, 380 + i * 60 + 400); // belt-and-suspenders
      } else { try { chip.remove(); } catch (e) {} }
    })(i);
  }

  /* (3a) balance count-up — 600ms ease-out onto a text node; render(n) writes it. */
  function countUp(from, to, render, ms) {
    if (typeof render !== "function") return;
    if (reduced() || !root.requestAnimationFrame) { render(to); return; }
    var dur = ms || 600, t0 = 0;
    function step(ts) {
      if (!t0) t0 = ts;
      var k = Math.min(1, (ts - t0) / dur);
      var e = 1 - Math.pow(1 - k, 3); // ease-out cubic
      render(from + (to - from) * e);
      if (k < 1) root.requestAnimationFrame(step); else render(to);
    }
    root.requestAnimationFrame(step);
  }

  /* (3b) "YOU WON $X" pill — pixel font, gold on dark; spring in 180ms,
     hold 1.6s, fade 300ms. Rendered inside the host (felt-confined). */
  function winPill(hostEl, amount) {
    if (!hostEl) return;
    var pill = doc.createElement("div");
    pill.className = "bacfx-winpill";
    pill.textContent = "YOU WON " + money(amount);
    hostEl.appendChild(pill);
    if (reduced()) { setTimeout(function () { try { pill.remove(); } catch (e) {} }, 1900); return; }
    requestAnimationFrame(function () { pill.classList.add("in"); });
    setTimeout(function () { pill.classList.add("out"); }, 180 + 1600);
    setTimeout(function () { try { pill.remove(); } catch (e) {} }, 180 + 1600 + 340);
  }

  /* floating "+$X" — small green float above a puck / the balance (1.5s). */
  function floatUp(el, text, color) {
    if (!el) return;
    var f = doc.createElement("div");
    f.className = "bacfx-float";
    f.textContent = text;
    if (color) f.style.color = color;
    el.appendChild(f);
    setTimeout(function () { try { f.remove(); } catch (e) {} }, 1500);
  }

  /* LOSS — quiet: chips fade to 30% and drift down 12px over 600ms. The next
     snapshot clears the stacks; this only paints the fade-out. NO sound here. */
  function quietLoss(stackEl) {
    if (!stackEl) return;
    if (reduced()) { stackEl.style.opacity = "0.3"; return; }
    stackEl.classList.add("bacfx-lossdrift");
  }

  /* dealer sweep — losing table chips slide up-left toward the shoe + fade 350ms. */
  function sweep(stackEl) {
    if (!stackEl) return;
    if (reduced()) { stackEl.style.opacity = "0"; return; }
    stackEl.classList.add("bacfx-sweep");
  }

  /* PUSH — chips slide back down toward your puck (returned), 500ms. */
  function pushReturn(stackEl) {
    if (!stackEl) return;
    if (reduced()) { stackEl.style.opacity = "0"; return; }
    stackEl.classList.add("bacfx-pushback");
  }

  /* Tie-win confetti — ONE felt-confined burst, ~1.2s, canvas inside the felt
     (never full-screen; z-order stays under the caption). */
  function confetti(feltEl) {
    if (!feltEl || reduced()) return;
    var cv = doc.createElement("canvas");
    cv.className = "bacfx-confetti";
    var w = feltEl.clientWidth || 720, h = feltEl.clientHeight || 540;
    cv.width = w; cv.height = h;
    feltEl.appendChild(cv);
    var ctx = cv.getContext("2d");
    if (!ctx) { try { cv.remove(); } catch (e) {} return; }
    var COLORS = ["#00e701", "#45f0a6", "#ffd23f", "#39e7ff", "#ffffff"];
    var parts = [], N = 70;
    for (var i = 0; i < N; i++) {
      var a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 5;
      parts.push({ x: w / 2 + (Math.random() - 0.5) * 60, y: h * 0.42, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 3,
        g: 0.14, s: 3 + Math.random() * 5, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        c: COLORS[(Math.random() * COLORS.length) | 0] });
    }
    var t0 = Date.now(), DUR = 1200;
    (function loop() {
      var k = (Date.now() - t0) / DUR;
      if (k >= 1) { try { cv.remove(); } catch (e) {} return; }
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = Math.max(0, 1 - k);
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i]; p.vy += p.g; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 1.5); ctx.restore();
      }
      root.requestAnimationFrame(loop);
    })();
  }

  root.BaccaratFX = {
    reduced: reduced,
    winZone: winZone,
    chipFly: chipFly,
    countUp: countUp,
    winPill: winPill,
    floatUp: floatUp,
    quietLoss: quietLoss,
    sweep: sweep,
    pushReturn: pushReturn,
    confetti: confetti,
  };
})(typeof window !== "undefined" ? window : this);
