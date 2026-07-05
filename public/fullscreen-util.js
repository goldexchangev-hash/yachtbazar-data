/* ============================================================
   fullscreen-util.js — window.FsUtil: ONE shared mobile/desktop fullscreen module
   for every game with a ⛶ (baccarat + fish + fishshooter + fishshooter2 + swoop).
   Loaded by BOTH index.html (site/TV) and baccarat.html (standalone felt).

   WHAT IT OWNS (the callers keep their own CSS overlay contract — rr-fs / bac-fs
   class toggles, reparenting, exit buttons — and call enterFs/exitFs around it):
     • the native Fullscreen API attempt: element.requestFullscreen({navigationUI:"hide"})
       with webkit/ms fallbacks, promise- and legacy-callback safe;
     • screen.orientation.lock(...) INSIDE real fullscreen (and unlock on exit);
     • RE-ASSERTION: holds fullscreen across device tilts. Chromium (Chrome 54+,
       Android/WebView, Brave/Samsung too) allows requestFullscreen with NO fresh
       user gesture while an orientationchange handler is running — FsUtil binds
       its own orientationchange listener at load (BEFORE app listeners) and opens
       a one-task "inOrient" grace window, so a tilt-to-landscape auto-fullscreen
       (which has no tap) can still get REAL browser-chrome-free fullscreen;
     • the fake-fullscreen fallback niceties where no Fullscreen API exists:
       html.fsu-fake class (CSS in styles.css / baccarat.html makes the DOCUMENT
       ~100.5lvh scrollable so the user's first upward swipe collapses the browser
       URL bar — the only mechanism iOS allows), an invisible #fsu-spacer to give
       the root scroller that height, and scrollTo(0,1) nudges (mostly inert on
       modern engines, harmless, occasionally helps older Android chrome).

   PER-PLATFORM TRUTH (researched + verified July 2026 — degrade gracefully):
     • Android Chrome / Brave / Samsung / WebView: TRUE fullscreen — URL bar,
       status bar and nav bar all hidden; orientation.lock works inside it; the
       orientationchange gesture exception makes tilt auto-fullscreen REAL too.
     • Firefox Android: true fullscreen; orientation.lock only from Fx 144
       (older versions throw — caught here); no orientationchange gesture
       exception → tilt path stays CSS-only there.
     • iPad Safari 16.4+: true element fullscreen (non-removable floating exit
       pill is Apple's); NO orientation.lock (attempt is caught).
     • iPhone Safari (ALL versions through iOS 26): PROVABLY IMPOSSIBLE —
       element fullscreen has never shipped on iPhone (fullscreenEnabled=false)
       and orientation.lock has never shipped in Safari at all. Best achievable:
       the 100dvh CSS overlay ("95% fullscreen") + swipe-up chrome collapse; the
       only TRUE fullscreen is Add-to-Home-Screen (manifest display:fullscreen →
       standalone). We do NOT chase the canvas→<video> webkitEnterFullscreen hack
       (input goes to the native player — unusable for a game).
     • MetaMask in-app browser (iOS AND Android): PROVABLY IMPOSSIBLE — verified
       in metamask-mobile source: the WebView never sets allowsFullscreenVideo
       (Android) nor isElementFullscreenEnabled (iOS), so requestFullscreen
       rejects on both. MetaMask's own top/bottom bars ARE scroll-collapsible,
       so the fsu-fake scrollable-document trick recovers most of the screen.
       Detect via FsUtil.isMetaMask() (UA contains "MetaMaskMobile").
     • Desktop: native fullscreen; orientation.lock rejects (caught).
   ============================================================ */
(function (root) {
  "use strict";
  var doc = root.document;
  if (!doc || root.FsUtil) return;

  /* ---------- capability probes ---------- */
  function canNative() {
    return !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled || doc.webkitFullScreenEnabled || doc.msFullscreenEnabled);
  }
  function fsEl() { return doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement || null; }
  function isMetaMask() { try { return /MetaMaskMobile/i.test(root.navigator.userAgent || ""); } catch (e) { return false; } }
  function isStandalone() {
    try {
      if (root.navigator && root.navigator.standalone === true) return true; // iOS A2HS
      return !!(root.matchMedia && (root.matchMedia("(display-mode: standalone)").matches || root.matchMedia("(display-mode: fullscreen)").matches));
    } catch (e) { return false; }
  }
  function isLandscape() {
    // screen.orientation.type updates BEFORE/with the orientationchange dispatch (viewport
    // matchMedia can lag it by a frame during rotation) — prefer it when present.
    try { if (root.screen && root.screen.orientation && root.screen.orientation.type) return root.screen.orientation.type.indexOf("landscape") === 0; } catch (e) {}
    try { if (root.matchMedia) return root.matchMedia("(orientation: landscape)").matches; } catch (e) {}
    return root.innerWidth > root.innerHeight;
  }

  /* ---------- state ---------- */
  var S = null;          // active session: { el, skipNative, lock, landscapeOnly, reassert, mode, locked }
  var spacer = null;     // #fsu-spacer — makes the root scroller ~100.5lvh tall in fake mode
  var inOrient = false;  // true while an orientationchange dispatch is running (gesture-exception window)
  var maxH = { l: 0, p: 0 }; // tallest innerHeight seen per orientation → chromeVisible() heuristic
  var resizeT = null;

  function trackH() { var k = isLandscape() ? "l" : "p"; var h = root.innerHeight || 0; if (h > maxH[k]) maxH[k] = h; }

  /* ---------- fake-mode helpers ---------- */
  function makeSpacer() {
    try {
      if (!spacer) { spacer = doc.createElement("div"); spacer.id = "fsu-spacer"; spacer.setAttribute("aria-hidden", "true"); }
      if (spacer.parentNode !== doc.body) doc.body.appendChild(spacer);
      var st = spacer.style;
      // inline !important beats every stylesheet !important (incl. the rr-fs child-hide),
      // so the spacer needs NO external CSS and survives `body.rr-fs-on > * { display:none }`.
      st.setProperty("display", "block", "important");
      st.setProperty("position", "absolute", "important");
      st.setProperty("top", "0", "important");
      st.setProperty("left", "0", "important");
      st.setProperty("width", "1px", "important");
      var px = Math.ceil(((root.screen && root.screen.height) || root.innerHeight || 800) * 1.05);
      st.setProperty("height", px + "px", "important");     // px fallback…
      st.setProperty("height", "100.5lvh", "important");    // …overridden where lvh is supported (iOS 15.4+/Chrome 108+)
      st.setProperty("visibility", "hidden", "important");
      st.setProperty("pointer-events", "none", "important");
    } catch (e) {}
  }
  function dropSpacer() { try { if (spacer && spacer.parentNode) spacer.parentNode.removeChild(spacer); } catch (e) {} }
  function nudge() { try { root.scrollTo(0, 1); } catch (e) {} } // best-effort URL-bar collapse; a 1px scroll never moves a fixed overlay

  function setMode(mode) {
    if (!S) return;
    S.mode = mode;
    var h = doc.documentElement.classList;
    h.add("fsu-fs");
    h.toggle("fsu-native", mode === "native");
    h.toggle("fsu-fake", mode === "fake");
  }
  function enterFake() {
    if (!S) return;
    setMode("fake");
    makeSpacer();
    nudge(); setTimeout(nudge, 260); setTimeout(nudge, 900);
    maybeHint();
  }

  /* ---------- one-time platform hints (owner directive: "remove the url section" on iPhone
     Safari / MetaMask — programmatically IMPOSSIBLE there (see PER-PLATFORM TRUTH above), so
     the best effort is telling the player the ONE real path to true fullscreen, once per
     device, only when we actually land in fake mode on those platforms). The site's manifest
     is display:fullscreen + apple-mobile-web-app-capable, so the A2HS claim is honest. */
  var hintShown = {};
  function hintOnce(kind) {
    if (hintShown[kind]) return false;
    hintShown[kind] = true; // session latch even when storage is unavailable
    try {
      var k = "fsuHint:" + kind;
      if (root.localStorage.getItem(k)) return false;
      root.localStorage.setItem(k, "1");
    } catch (e) {}
    return true;
  }
  function showHint(kind) {
    try {
      var old = doc.getElementById("fsu-hint"); if (old && old.parentNode) old.parentNode.removeChild(old);
      var pill = doc.createElement("div");
      pill.id = "fsu-hint";
      pill.setAttribute("role", "status");
      pill.textContent = kind === "metamask"
        ? "For true fullscreen, open this site in Chrome or Safari"
        : "Tip: Share → Add to Home Screen for true fullscreen";
      var st = pill.style; // inline !important: self-contained in BOTH host documents, survives every overlay/child-hide rule
      st.setProperty("position", "fixed", "important");
      st.setProperty("top", "calc(env(safe-area-inset-top, 0px) + 10px)", "important");
      st.setProperty("left", "50%", "important");
      st.setProperty("transform", "translateX(-50%)", "important");
      st.setProperty("z-index", "2147483647", "important");
      st.setProperty("max-width", "92vw", "important");
      st.setProperty("box-sizing", "border-box", "important");
      st.setProperty("padding", "10px 16px", "important");
      st.setProperty("border-radius", "12px", "important");
      st.setProperty("background", "rgba(4, 19, 38, .92)", "important");
      st.setProperty("border", "1px solid rgba(255, 255, 255, .35)", "important");
      st.setProperty("color", "#fff", "important");
      st.setProperty("font", "600 13px/1.45 system-ui, -apple-system, sans-serif", "important");
      st.setProperty("text-align", "center", "important");
      st.setProperty("box-shadow", "0 6px 24px rgba(0, 0, 0, .5)", "important");
      st.setProperty("cursor", "pointer", "important");
      st.setProperty("opacity", "0", "important");
      st.setProperty("transition", "opacity .35s ease", "important");
      doc.body.appendChild(pill);
      setTimeout(function () { st.setProperty("opacity", "1", "important"); }, 30);
      var gone = false;
      var dismiss = function () {
        if (gone) return; gone = true;
        st.setProperty("opacity", "0", "important");
        setTimeout(function () { try { if (pill.parentNode) pill.parentNode.removeChild(pill); } catch (e) {} }, 400);
      };
      pill.addEventListener("click", dismiss);
      setTimeout(dismiss, 8000); // auto-fade: a hint, never a nag
    } catch (e) {}
  }
  function maybeHint() {
    try {
      if (isStandalone()) return; // already installed → already true fullscreen
      if (isMetaMask()) { if (hintOnce("metamask")) setTimeout(function () { showHint("metamask"); }, 600); return; }
      var ua = (root.navigator && root.navigator.userAgent) || "";
      // iPhone/iPod Safari only (iPad reaches native fs); canNative() false = the provably-impossible case
      if (/iPhone|iPod/.test(ua) && !canNative() && hintOnce("a2hs")) setTimeout(function () { showHint("a2hs"); }, 600);
    } catch (e) {}
  }

  /* ---------- native path ---------- */
  function lockOrientation() {
    if (!S || !S.lock) return;
    try {
      if (root.screen && root.screen.orientation && root.screen.orientation.lock) {
        S.locked = true;
        var p = root.screen.orientation.lock(S.lock);
        if (p && p.catch) p.catch(function () { if (S) S.locked = false; }); // iPad Safari / desktop / old Fx: unsupported → keep going
      }
    } catch (e) { if (S) S.locked = false; } // Firefox Android <144 throws synchronously
  }
  function unlockOrientation() { try { if (root.screen && root.screen.orientation && root.screen.orientation.unlock) root.screen.orientation.unlock(); } catch (e) {} }

  function onNativeOk() { if (!S) return; setMode("native"); dropSpacer(); lockOrientation(); }
  function onNativeFail() { if (!S) return; enterFake(); }

  function tryNative() {
    if (!S || !S.el || !canNative()) { onNativeFail(); return; }
    var el = S.el, p = null;
    try {
      if (el.requestFullscreen) {
        try { p = el.requestFullscreen({ navigationUI: "hide" }); } catch (e2) { p = el.requestFullscreen(); }
      } else if (el.webkitRequestFullscreen) p = el.webkitRequestFullscreen();
      else if (el.webkitRequestFullScreen) p = el.webkitRequestFullScreen();
      else if (el.msRequestFullscreen) p = el.msRequestFullscreen();
      else { onNativeFail(); return; }
    } catch (e) { onNativeFail(); return; }
    if (p && p.then) p.then(onNativeOk, onNativeFail);
    else setTimeout(function () { if (fsEl()) onNativeOk(); else onNativeFail(); }, 120); // legacy webkit returns undefined
  }

  /* ---------- re-assertion (hold fullscreen across tilts) ---------- */
  function onOrient() {
    inOrient = true;
    // the Chromium gesture exception lasts for THIS dispatch — later listeners (the app's
    // synchronous tilt sync) run inside it; a macrotask closes the window right after.
    setTimeout(function () { inOrient = false; }, 0);
    trackH();
    if (!S) return;
    if (!fsEl() && canNative() && S.reassert !== false) {
      if (!S.landscapeOnly || isLandscape()) tryNative(); // synchronous: inside the exception window
    }
    if (S && S.mode === "fake") { setTimeout(nudge, 120); setTimeout(nudge, 500); }
  }
  function onResize() {
    trackH();
    if (!S) return;
    if (resizeT) clearTimeout(resizeT);
    resizeT = setTimeout(function () {
      resizeT = null;
      if (!S) return;
      // Samsung Internet & some WebViews fire resize (not orientationchange) on rotation.
      // Outside a gesture the attempt usually rejects — caught and cheap.
      if (!fsEl() && canNative() && S.reassert !== false && (!S.landscapeOnly || isLandscape())) tryNative();
      if (S && S.mode === "fake") nudge();
    }, 180);
  }
  (function bindGlobal() { // at load, BEFORE any app listeners → FsUtil's onOrient opens the grace window first
    try { root.addEventListener("orientationchange", onOrient); } catch (e) {}
    try { if (root.screen && root.screen.orientation && root.screen.orientation.addEventListener) root.screen.orientation.addEventListener("change", onOrient); } catch (e) {}
    try { root.addEventListener("resize", onResize, { passive: true }); } catch (e) { try { root.addEventListener("resize", onResize); } catch (e2) {} }
    trackH();
  })();

  /* ---------- public API ---------- */
  // enterFs(el, opts) → "native"|"fake" (the mode being ATTEMPTED; fake→native upgrades
  // can land async). opts:
  //   skipNative      — no user gesture available (tilt path). Native is still attempted
  //                     when called inside an orientationchange dispatch (Chromium exception).
  //   lockOrientation — "landscape" etc.: asserted only once REAL fullscreen is live,
  //                     unlocked on exitFs. null/omitted = never lock (baccarat has its own
  //                     portrait fullscreen layout — do NOT force-rotate it).
  //   landscapeOnly   — tilt sessions: only re-assert native fullscreen while the device
  //                     is physically landscape (so rotating back to portrait exits cleanly).
  //   reassert:false  — opt out of tilt re-assertion entirely.
  function enterFs(el, opts) {
    opts = opts || {};
    if (!el) return "fake";
    trackH();
    if (S && S.el === el) { // idempotent re-entry (keep-alive syncs re-fire enterFullscreen)
      if (opts.lockOrientation !== undefined) S.lock = opts.lockOrientation || null;
      if (opts.skipNative === false) S.skipNative = false;
      if (!fsEl() && canNative() && (!S.skipNative || inOrient)) tryNative();
      return S.mode;
    }
    if (S) exitFs(); // one session at a time (channel switch)
    S = {
      el: el,
      skipNative: !!opts.skipNative,
      lock: opts.lockOrientation || null,
      landscapeOnly: !!opts.landscapeOnly,
      reassert: opts.reassert !== false,
      mode: "fake",
      locked: false,
    };
    if (canNative() && (!S.skipNative || inOrient)) { setMode("fake"); tryNative(); }
    else enterFake();
    return (canNative() && (!S.skipNative || inOrient)) ? "native" : "fake";
  }

  function exitFs() {
    var h = doc.documentElement.classList;
    h.remove("fsu-fs"); h.remove("fsu-native"); h.remove("fsu-fake");
    dropSpacer();
    if (S && S.locked) unlockOrientation();
    S = null;
    try {
      var p = null;
      if (doc.fullscreenElement && doc.exitFullscreen) p = doc.exitFullscreen();
      else if (doc.webkitFullscreenElement && doc.webkitExitFullscreen) p = doc.webkitExitFullscreen();
      else if (doc.msFullscreenElement && doc.msExitFullscreen) p = doc.msExitFullscreen();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  function isFs() { return !!(fsEl() || S); }

  // chromeVisible(): best-effort "is browser chrome (URL bar) eating the viewport?"
  //   true  — we've seen a taller viewport in this orientation (bar currently expanded),
  //           or the viewport is far shorter than the physical screen;
  //   false — native fullscreen / installed PWA / no evidence of chrome;
  //   null  — no data yet (heuristic, never load-bearing).
  function chromeVisible() {
    if (fsEl()) return false;
    if (isStandalone()) return false;
    var k = isLandscape() ? "l" : "p";
    var h = root.innerHeight || 0;
    if (maxH[k] && maxH[k] - h > 24) return true;
    try {
      var sw = root.screen ? root.screen.width : 0, sh = root.screen ? root.screen.height : 0;
      var phys = isLandscape() ? Math.min(sw, sh) : Math.max(sw, sh);
      if (phys && phys - h > 80) return true;
    } catch (e) {}
    return maxH[k] ? false : null;
  }

  root.FsUtil = {
    enterFs: enterFs,
    exitFs: exitFs,
    isFs: isFs,
    canNative: canNative,
    isMetaMask: isMetaMask,
    isStandalone: isStandalone,
    chromeVisible: chromeVisible,
    nudgeChrome: nudge,
    active: function () { return S ? { mode: S.mode, locked: !!S.locked, skipNative: !!S.skipNative } : null; },
    _hint: showHint, // internal: preview/test hook (gates live in maybeHint)
  };
})(typeof window !== "undefined" ? window : this);
