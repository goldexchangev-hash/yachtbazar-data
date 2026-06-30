/* ============================================================
   fishhunter3000-sprites.js — procedural sprite factory for FISH HUNTER 3000.
   Separate from Fish Shooter assets. Generates neon cyber-fish textures at
   runtime when /assets/fishhunter3000/*.png are missing.
   ============================================================ */
(function (root) {
  "use strict";

  var FRAMES = 6;
  var TEX_SIZE = 128;

  function hex(c) {
    return "#" + (c >>> 0).toString(16).padStart(6, "0");
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function drawGlow(ctx, x, y, r, color, alpha) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color.replace(")", "," + alpha + ")").replace("rgb", "rgba").replace("#", ""));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = r * 0.8;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function bodyPath(ctx, kind, w, h, frame) {
    var t = frame / FRAMES;
    var fin = Math.sin(t * Math.PI * 2) * 0.12;
    ctx.beginPath();
    if (kind === "ray") {
      ctx.moveTo(-w * 0.45, 0);
      ctx.quadraticCurveTo(0, -h * (0.55 + fin), w * 0.5, 0);
      ctx.quadraticCurveTo(0, h * (0.55 + fin), -w * 0.45, 0);
    } else if (kind === "jelly") {
      ctx.ellipse(0, h * 0.05, w * 0.42, h * 0.48, 0, 0, Math.PI * 2);
    } else if (kind === "puffer") {
      ctx.arc(0, 0, w * 0.38, 0, Math.PI * 2);
    } else if (kind === "sword") {
      ctx.moveTo(-w * 0.5, fin * h);
      ctx.lineTo(w * 0.55, 0);
      ctx.lineTo(-w * 0.5, -fin * h);
      ctx.closePath();
    } else if (kind === "shark") {
      ctx.moveTo(-w * 0.48, h * 0.08);
      ctx.quadraticCurveTo(w * 0.1, -h * 0.35, w * 0.5, 0);
      ctx.quadraticCurveTo(w * 0.1, h * 0.35, -w * 0.48, h * 0.08);
    } else if (kind === "whale") {
      ctx.moveTo(-w * 0.5, 0);
      ctx.quadraticCurveTo(-w * 0.1, -h * 0.42, w * 0.45, -h * 0.05);
      ctx.quadraticCurveTo(w * 0.2, h * 0.35, -w * 0.5, h * 0.12);
      ctx.closePath();
    } else if (kind === "eel") {
      for (var i = 0; i <= 8; i++) {
        var px = lerp(-w * 0.5, w * 0.5, i / 8);
        var py = Math.sin(i * 0.9 + t * Math.PI * 2) * h * 0.22;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
    } else if (kind === "drone") {
      ctx.roundRect(-w * 0.35, -h * 0.25, w * 0.7, h * 0.5, 8);
    } else if (kind === "bot") {
      ctx.roundRect(-w * 0.32, -h * 0.28, w * 0.64, h * 0.56, 12);
    } else if (kind === "boss") {
      ctx.moveTo(-w * 0.5, h * 0.05);
      ctx.lineTo(-w * 0.15, -h * 0.45);
      ctx.lineTo(w * 0.35, -h * 0.35);
      ctx.lineTo(w * 0.5, 0);
      ctx.lineTo(w * 0.35, h * 0.35);
      ctx.lineTo(-w * 0.15, h * 0.45);
      ctx.closePath();
    } else {
      ctx.moveTo(-w * 0.42, fin * h * 0.3);
      ctx.quadraticCurveTo(w * 0.15, -h * 0.28, w * 0.48, 0);
      ctx.quadraticCurveTo(w * 0.15, h * 0.28, -w * 0.42, -fin * h * 0.3);
      ctx.closePath();
    }
  }

  var KIND_MAP = {
    pixel: "fish", neon: "fish", chrome: "fish", plasma: "ray", glitch: "puffer",
    quantum: "jelly", laser: "sword", cyber: "shark", holo: "whale",
    vault: "drone", storm: "eel", frenzy: "bot", leviathan: "boss",
  };

  function drawFishFrame(def, frame) {
    var canvas = document.createElement("canvas");
    canvas.width = TEX_SIZE;
    canvas.height = TEX_SIZE;
    var ctx = canvas.getContext("2d");
    var cx = TEX_SIZE / 2, cy = TEX_SIZE / 2;
    var kind = KIND_MAP[def.id] || "fish";
    var col = hex(def.color || 0x00f5ff);
    var accent = hex((def.color || 0x00f5ff) ^ 0x333333);
    var w = TEX_SIZE * 0.72 * (def.size || 1);
    var h = TEX_SIZE * 0.42 * (def.size || 1);

    ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
    ctx.translate(cx, cy);

    ctx.save();
    ctx.shadowColor = col;
    ctx.shadowBlur = 18;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.ellipse(0, h * 0.35, w * 0.35, h * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    bodyPath(ctx, kind, w, h, frame);
    var grad = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
    grad.addColorStop(0, accent);
    grad.addColorStop(0.45, col);
    grad.addColorStop(1, "#ffffff");
    ctx.fillStyle = grad;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = col;
    ctx.shadowBlur = 14;
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1;
    if (kind === "fish" || kind === "shark" || kind === "whale") {
      ctx.beginPath();
      ctx.moveTo(-w * 0.15, -h * 0.12);
      ctx.lineTo(w * 0.05, 0);
      ctx.lineTo(-w * 0.15, h * 0.12);
      ctx.stroke();
    }
    if (def.special === "vault") {
      ctx.fillStyle = "#ffd23f";
      ctx.fillRect(-6, -6, 12, 12);
    }
    if (def.special === "storm") {
      ctx.strokeStyle = "#44eeff";
      ctx.beginPath();
      ctx.moveTo(-w * 0.2, -h * 0.3);
      ctx.lineTo(0, h * 0.35);
      ctx.lineTo(w * 0.2, -h * 0.3);
      ctx.stroke();
    }

    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(w * 0.18, -h * 0.08, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#001";
    ctx.beginPath();
    ctx.arc(w * 0.2, -h * 0.08, 2, 0, Math.PI * 2);
    ctx.fill();

    return canvas;
  }

  function drawCannonFrame(frame) {
    var canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 96;
    var ctx = canvas.getContext("2d");
    var cx = 48, cy = 60;
    ctx.translate(cx, cy);
    ctx.fillStyle = "#1a2a44";
    ctx.strokeStyle = "#00f5ff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 8, 28, Math.PI, 0);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#334466";
    ctx.fillRect(-18, 8, 36, 14);
    var recoil = Math.sin(frame / FRAMES * Math.PI * 2) * 3;
    ctx.fillStyle = "#556688";
    ctx.fillRect(-8 + recoil, -32, 16, 40);
    ctx.strokeStyle = "#ff3dff";
    ctx.strokeRect(-8 + recoil, -32, 16, 40);
    ctx.fillStyle = "#00f5ff";
    ctx.shadowColor = "#00f5ff";
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(0 + recoil, -36, 6, 0, Math.PI * 2);
    ctx.fill();
    return canvas;
  }

  function drawBulletTex() {
    var canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    var ctx = canvas.getContext("2d");
    var g = ctx.createRadialGradient(16, 16, 0, 16, 16, 14);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.35, "#00f5ff");
    g.addColorStop(1, "rgba(0,245,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(16, 16, 14, 0, Math.PI * 2);
    ctx.fill();
    return canvas;
  }

  function drawBgTex(w, h) {
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#020818");
    g.addColorStop(0.45, "#061a3a");
    g.addColorStop(1, "#0a0520");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    for (var i = 0; i < 80; i++) {
      ctx.fillStyle = "rgba(0,245,255," + (0.05 + Math.random() * 0.15) + ")";
      ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    for (var j = 0; j < 6; j++) {
      var gx = Math.random() * w, gy = Math.random() * h;
      var rg = ctx.createRadialGradient(gx, gy, 0, gx, gy, 120 + Math.random() * 80);
      rg.addColorStop(0, "rgba(123,92,255,0.12)");
      rg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = rg;
      ctx.fillRect(gx - 150, gy - 150, 300, 300);
    }
    return canvas;
  }

  function build(PIXI, defs) {
    var out = { fish: {}, cannon: [], bullet: null, bg: null };
    defs.forEach(function (def) {
      var frames = [];
      for (var f = 0; f < FRAMES; f++) {
        frames.push(PIXI.Texture.from(drawFishFrame(def, f)));
      }
      out.fish[def.id] = frames;
    });
    for (var c = 0; c < FRAMES; c++) {
      out.cannon.push(PIXI.Texture.from(drawCannonFrame(c)));
    }
    out.bullet = PIXI.Texture.from(drawBulletTex());
    out.bg = PIXI.Texture.from(drawBgTex(512, 512));
    return out;
  }

  root.FH3KSprites = { build: build, drawFishFrame: drawFishFrame, FRAMES: FRAMES };
})(typeof window !== "undefined" ? window : global);
