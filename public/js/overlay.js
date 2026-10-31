// Temporary full-screen surprise. To remove it: delete the
// <script src="/js/overlay.js"> line in index.html (nothing else depends on it).
// Shows once per browser session, closes on the X / tap / Escape, and sits
// outside #app so the game's re-renders never touch it.
(function () {
  try {
    if (sessionStorage.getItem("pg_overlay_seen")) return;
  } catch (e) {}

  var overlay = document.createElement("div");
  overlay.id = "pgOverlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Surprise");

  // Two copies of the same tile, the second offset by half a tile each way,
  // so the ovals interlock and leave almost no gaps.
  overlay.style.setProperty("--w", "clamp(150px, 30vw, 280px)");
  overlay.style.setProperty("--h", "calc(var(--w) * 1.357)");
  overlay.style.cssText +=
    "position:fixed;inset:0;z-index:9999;cursor:pointer;background-color:#1C1920;" +
    "background-image:url(/img/overlay-face.png),url(/img/overlay-face.png);" +
    "background-repeat:repeat,repeat;" +
    "background-size:var(--w) var(--h),var(--w) var(--h);" +
    "background-position:0 0,calc(var(--w) / 2) calc(var(--h) / 2);";

  var x = document.createElement("button");
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  x.textContent = "✕";
  x.style.cssText =
    "position:absolute;top:12px;right:12px;width:44px;height:44px;border-radius:50%;" +
    "border:1px solid rgba(255,255,255,0.5);background:rgba(0,0,0,0.75);color:#fff;" +
    "font-size:22px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;";
  overlay.appendChild(x);

  function close() {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    try {
      sessionStorage.setItem("pg_overlay_seen", "1");
    } catch (e) {}
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }

  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  x.focus();
})();
