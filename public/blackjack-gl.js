/* ============================================================
   blackjack-gl.js — LAYER 1 ambient WebGL atmosphere (Three.js r128).
   Renders ONLY mood: a deep-teal felt slab, a glowing cyan rim, a magenta
   back-kiss, cyan/teal haze, and drifting dust motes. Holds ZERO game state —
   the DOM felt/cards on top are the authoritative, fully-playable layer. If
   WebGL is unavailable or anything throws, start() returns false and the CSS
   felt is the complete fallback. Frame-capped ~30fps; pauses when hidden.
     BlackjackGL.start(canvasEl) -> bool ;  BlackjackGL.stop()
   ============================================================ */
(function (root) {
  "use strict";
  var GL = { _raf: 0, _on: false };
  var THREE = root.THREE;

  function radialTexture(inner, outer) {
    var c = document.createElement("canvas"); c.width = c.height = 128;
    var g = c.getContext("2d"); var grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, inner); grd.addColorStop(1, outer); g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  GL.start = function (canvas) {
    THREE = root.THREE; if (!THREE || !canvas) return false;
    try {
      var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
      if (THREE.ACESFilmicToneMapping) { renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.14; }
      var scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x04140f, 0.02);
      var cam = new THREE.PerspectiveCamera(42, 2, 0.1, 100);
      cam.position.set(0, 6.2, 8.2); cam.lookAt(0, 0, -0.4);

      // felt slab
      var felt = new THREE.Mesh(
        new THREE.PlaneGeometry(20, 12, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0x073a2e, roughness: 0.9, metalness: 0.0, emissive: 0x04140f, emissiveIntensity: 0.25 })
      );
      felt.rotation.x = -Math.PI / 2; felt.position.y = -0.02; scene.add(felt);

      // glowing cyan rim (a flat ring just above the felt) + a softer additive halo ring
      var rim = new THREE.Mesh(new THREE.TorusGeometry(5.6, 0.07, 12, 90), new THREE.MeshBasicMaterial({ color: 0x39e7ff }));
      rim.rotation.x = -Math.PI / 2; rim.position.y = 0.02; rim.scale.set(1.25, 1, 1); scene.add(rim);
      var halo = new THREE.Mesh(new THREE.TorusGeometry(5.6, 0.34, 10, 90),
        new THREE.MeshBasicMaterial({ color: 0x39e7ff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }));
      halo.rotation.x = -Math.PI / 2; halo.position.y = 0.02; halo.scale.set(1.25, 1, 1); scene.add(halo);

      // haze (additive plane drifting overhead)
      var haze = new THREE.Mesh(new THREE.PlaneGeometry(22, 14),
        new THREE.MeshBasicMaterial({ map: radialTexture("rgba(57,231,255,.5)", "rgba(57,231,255,0)"), transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false }));
      haze.rotation.x = -Math.PI / 2; haze.position.y = 1.2; scene.add(haze);

      // dust motes
      var N = 26, pos = new Float32Array(N * 3);
      for (var i = 0; i < N; i++) { pos[i * 3] = (Math.random() - 0.5) * 14; pos[i * 3 + 1] = Math.random() * 4; pos[i * 3 + 2] = (Math.random() - 0.5) * 8; }
      var pg = new THREE.BufferGeometry(); pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      var motes = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0x9fe9ff, size: 0.06, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, map: radialTexture("#fff", "rgba(255,255,255,0)") }));
      scene.add(motes);

      // lights
      scene.add(new THREE.HemisphereLight(0x2a3a8a, 0x04140f, 0.45));
      var key = new THREE.SpotLight(0xbfe9ff, 1.4, 40, 0.6, 0.85); key.position.set(0, 11, 4); scene.add(key);
      var mag = new THREE.PointLight(0xff4d9d, 0.9, 16); mag.position.set(0, 1.4, -5); scene.add(mag);
      var cyl = new THREE.PointLight(0x39e7ff, 0.5, 22); cyl.position.set(-6, 2, 3); scene.add(cyl);

      function resize() {
        var w = canvas.clientWidth || canvas.offsetWidth || 600, h = canvas.clientHeight || canvas.offsetHeight || 360;
        renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix();
      }
      resize(); root.addEventListener("resize", resize);

      var last = 0, t = 0;
      function loop(now) {
        if (!GL._on) return;
        GL._raf = requestAnimationFrame(loop);
        if (root.document && root.document.hidden) return;
        if (now - last < 33) return; last = now; t += 0.016; // ~30fps
        haze.rotation.z += 0.0008;
        rim.material.color.setHSL(0.5, 1, 0.55 + 0.12 * Math.sin(t * 1.0)); // gentle rim breathe
        halo.material.opacity = 0.14 + 0.07 * (0.5 + 0.5 * Math.sin(t * 1.0));
        var p = motes.geometry.attributes.position;
        for (var i = 0; i < N; i++) { p.array[i * 3 + 1] += 0.006; if (p.array[i * 3 + 1] > 4.2) p.array[i * 3 + 1] = 0; }
        p.needsUpdate = true;
        cam.position.x = Math.sin(t * 0.12) * 0.18; cam.lookAt(0, 0, -0.4); // ±idle sway
        renderer.render(scene, cam);
      }
      GL._on = true; GL._raf = requestAnimationFrame(loop);
      GL._stop = function () { GL._on = false; if (GL._raf) cancelAnimationFrame(GL._raf); root.removeEventListener("resize", resize); try { renderer.dispose(); } catch (e) {} };
      GL._resize = resize;
      return true;
    } catch (e) { if (root.console) console.warn("BlackjackGL disabled:", e && e.message); return false; }
  };
  GL.stop = function () { if (GL._stop) GL._stop(); GL._on = false; };

  root.BlackjackGL = GL;
})(typeof window !== "undefined" ? window : this);
