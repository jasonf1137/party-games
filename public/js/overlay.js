// Temporary full-screen surprise. To remove it: delete the
// <script src="/js/overlay.js"> line in index.html (nothing else depends on it).
// Shows once per browser session, closes on tap/click/Escape, and sits outside
// #app so the game's re-renders never touch it.
(function () {
  try {
    if (sessionStorage.getItem("pg_overlay_seen")) return;
  } catch (e) {}

  var overlay = document.createElement("div");
  overlay.id = "pgOverlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Surprise");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;" +
    "align-items:center;justify-content:center;gap:14px;padding:16px;" +
    "background:#1C1920;cursor:pointer;";

  var img = document.createElement("img");
  img.src = "/img/overlay-face.jpg";
  img.alt = "A surprise face";
  img.style.cssText = "max-width:min(80vw,360px);max-height:68vh;width:auto;height:auto;";

  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-primary btn-lg";
  btn.textContent = "Close";

  var hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Tap anywhere to close";

  overlay.appendChild(img);
  overlay.appendChild(btn);
  overlay.appendChild(hint);

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
  btn.focus();
})();
