/* ============================================================
   bloom3d.js — a tiny, dependency-free NEON BLOOM post-processing pipeline for
   Three.js r128 (no examples/jsm needed, works with just the vendored three.min.js).

   Pipeline: render scene → bright-pass (threshold) → separable Gaussian blur
   (half-res ping-pong, N iterations) → additive composite (+ gentle vignette/tone)
   to the screen. Replace `renderer.render(scene, cam)` with `bloom.render()`.

     const bloom = new NeonBloom(renderer, scene, camera,
       { width, height, strength, threshold, soft, iterations });
     bloom.setSize(w, h);   // on resize
     bloom.render();        // each frame
   ============================================================ */
(function (root) {
  "use strict";
  const THREE = root.THREE; if (!THREE) return;

  const VERT = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
  const BRIGHT = [
    "varying vec2 vUv; uniform sampler2D tDiffuse; uniform float threshold; uniform float soft;",
    "void main(){",
    "  vec3 c = texture2D(tDiffuse, vUv).rgb;",
    "  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));",
    "  float k = smoothstep(threshold, threshold + soft, l);",
    "  gl_FragColor = vec4(c * k, 1.0);",
    "}"
  ].join("\n");
  const BLUR = [
    "varying vec2 vUv; uniform sampler2D tDiffuse; uniform vec2 dir; uniform vec2 res;",
    "void main(){",
    "  vec2 px = dir / res;",
    "  vec3 s = vec3(0.0);",
    "  s += texture2D(tDiffuse, vUv + px * -4.0).rgb * 0.051;",
    "  s += texture2D(tDiffuse, vUv + px * -3.0).rgb * 0.090;",
    "  s += texture2D(tDiffuse, vUv + px * -2.0).rgb * 0.120;",
    "  s += texture2D(tDiffuse, vUv + px * -1.0).rgb * 0.151;",
    "  s += texture2D(tDiffuse, vUv).rgb             * 0.176;",
    "  s += texture2D(tDiffuse, vUv + px *  1.0).rgb * 0.151;",
    "  s += texture2D(tDiffuse, vUv + px *  2.0).rgb * 0.120;",
    "  s += texture2D(tDiffuse, vUv + px *  3.0).rgb * 0.090;",
    "  s += texture2D(tDiffuse, vUv + px *  4.0).rgb * 0.051;",
    "  gl_FragColor = vec4(s, 1.0);",
    "}"
  ].join("\n");
  const COMP = [
    "varying vec2 vUv; uniform sampler2D tBase; uniform sampler2D tBloom; uniform float strength;",
    "void main(){",
    "  vec3 base = texture2D(tBase, vUv).rgb;",
    "  vec3 bloom = texture2D(tBloom, vUv).rgb;",
    "  vec3 col = base + bloom * strength;",
    "  float vig = smoothstep(1.25, 0.35, length(vUv - 0.5));", // gentle vignette
    "  col *= mix(0.86, 1.04, vig);",
    "  col = col / (col + vec3(0.85)) * 1.85;",                 // soft filmic rolloff so bloom doesn't clip to white
    "  gl_FragColor = vec4(col, 1.0);",
    "}"
  ].join("\n");

  function NeonBloom(renderer, scene, camera, opts) {
    opts = opts || {};
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.strength = opts.strength != null ? opts.strength : 1.1;
    this.threshold = opts.threshold != null ? opts.threshold : 0.55;
    this.soft = opts.soft != null ? opts.soft : 0.25;
    this.iterations = opts.iterations || 3;
    this._qScene = new THREE.Scene();
    this._qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this._quad.frustumCulled = false; this._qScene.add(this._quad);
    const sm = (frag, uniforms) => new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false });
    this._mBright = sm(BRIGHT, { tDiffuse: { value: null }, threshold: { value: this.threshold }, soft: { value: this.soft } });
    this._mBlur = sm(BLUR, { tDiffuse: { value: null }, dir: { value: new THREE.Vector2(1, 0) }, res: { value: new THREE.Vector2(1, 1) } });
    this._mComp = sm(COMP, { tBase: { value: null }, tBloom: { value: null }, strength: { value: this.strength } });
    const dpr = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
    this.setSize(opts.width || (renderer.domElement.width / dpr), opts.height || (renderer.domElement.height / dpr));
  }
  NeonBloom.prototype.setSize = function (w, h) {
    const dpr = this.renderer.getPixelRatio ? this.renderer.getPixelRatio() : 1;
    w = Math.max(4, Math.round(w * dpr)); h = Math.max(4, Math.round(h * dpr));
    if (w === this.w && h === this.h) return; this.w = w; this.h = h;
    const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
    const opt = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: true };
    [this._sceneRT, this._rtA, this._rtB].forEach((rt) => rt && rt.dispose());
    this._sceneRT = new THREE.WebGLRenderTarget(w, h, opt);
    this._rtA = new THREE.WebGLRenderTarget(hw, hh, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: false });
    this._rtB = new THREE.WebGLRenderTarget(hw, hh, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: false });
    this._half = new THREE.Vector2(hw, hh);
  };
  NeonBloom.prototype._pass = function (mat, target) {
    this._quad.material = mat;
    this.renderer.setRenderTarget(target || null);
    this.renderer.render(this._qScene, this._qCam);
  };
  NeonBloom.prototype.render = function () {
    const r = this.renderer, prev = r.getRenderTarget();
    // 1. full scene → sceneRT
    r.setRenderTarget(this._sceneRT); r.render(this.scene, this.camera);
    // 2. bright-pass → rtA (half-res)
    this._mBright.uniforms.tDiffuse.value = this._sceneRT.texture;
    this._mBright.uniforms.threshold.value = this.threshold;
    this._mBright.uniforms.soft.value = this.soft;
    this._pass(this._mBright, this._rtA);
    // 3. separable Gaussian blur, ping-pong
    this._mBlur.uniforms.res.value.copy(this._half);
    for (let i = 0; i < this.iterations; i++) {
      this._mBlur.uniforms.tDiffuse.value = this._rtA.texture; this._mBlur.uniforms.dir.value.set(1.4, 0);
      this._pass(this._mBlur, this._rtB);
      this._mBlur.uniforms.tDiffuse.value = this._rtB.texture; this._mBlur.uniforms.dir.value.set(0, 1.4);
      this._pass(this._mBlur, this._rtA);
    }
    // 4. composite (scene + bloom) → screen
    this._mComp.uniforms.tBase.value = this._sceneRT.texture;
    this._mComp.uniforms.tBloom.value = this._rtA.texture;
    this._mComp.uniforms.strength.value = this.strength;
    this._pass(this._mComp, null);
    r.setRenderTarget(prev);
  };
  root.NeonBloom = NeonBloom;
})(typeof globalThis !== "undefined" ? globalThis : this);
