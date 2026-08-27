(function installEarlyPlayerMask(root) {
  "use strict";

  const API_NAME = "__BILI_THREAD_RIPPER_EARLY_MASK__";
  if (root[API_NAME]) return;

  const ATTRIBUTE = "data-btr-early-mask";
  const STYLE_ID = "__bilibili_thread_ripper_early_mask_style__";

  function isVideoRoute() {
    return /\/video\//.test(root.location?.pathname || "");
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      html[${ATTRIBUTE}="true"] #bilibili-player,
      html[${ATTRIBUTE}="true"] #bilibili-player .bpx-player-container,
      html[${ATTRIBUTE}="true"] .bilibili-player,
      html[${ATTRIBUTE}="true"] .bpx-player-container {
        position: relative !important;
        background: #000 !important;
      }
      html[${ATTRIBUTE}="true"] #bilibili-player::after,
      html[${ATTRIBUTE}="true"] .bilibili-player::after,
      html[${ATTRIBUTE}="true"] .bpx-player-container::after {
        content: "" !important;
        position: absolute !important;
        inset: 0 !important;
        z-index: 2147482999 !important;
        display: block !important;
        background: #000 !important;
        pointer-events: auto !important;
      }
      html[${ATTRIBUTE}="true"] #bilibili-player video,
      html[${ATTRIBUTE}="true"] .bilibili-player video,
      html[${ATTRIBUTE}="true"] .bpx-player-container video {
        visibility: hidden !important;
      }
    `;
    (document.documentElement || document.head)?.append(style);
  }

  function arm() {
    ensureStyle();
    if (isVideoRoute()) document.documentElement?.setAttribute(ATTRIBUTE, "true");
    else release();
  }

  function release() {
    document.documentElement?.removeAttribute(ATTRIBUTE);
  }

  const nativePushState = history.pushState.bind(history);
  const nativeReplaceState = history.replaceState.bind(history);
  history.pushState = function (...args) {
    const result = nativePushState(...args);
    arm();
    return result;
  };
  history.replaceState = function (...args) {
    const result = nativeReplaceState(...args);
    arm();
    return result;
  };
  root.addEventListener("popstate", arm);

  Object.defineProperty(root, API_NAME, {
    configurable: false,
    value: Object.freeze({ arm, isArmed: () => document.documentElement?.hasAttribute(ATTRIBUTE) === true, release })
  });
  arm();
})(globalThis);
