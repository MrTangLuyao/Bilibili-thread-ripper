(function installVideoP2pGuard(root) {
  "use strict";
  // Video pages only; the live module has its own P2P mocks.
  if (/^live\.bilibili\.com$/i.test(root.location?.hostname || "")) return;

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const INSTALL_FLAG = "__biliThreadRipperVideoP2pGuardInstalled";
  const rangeCore = root.__BILI_RANGE_CORE__;
  if (!rangeCore || root[INSTALL_FLAG]) return;
  Object.defineProperty(root, INSTALL_FLAG, { value: true });

  let settings = rangeCore.normalizeSettings({});
  let settingsLoaded = false;
  // Blocked until the saved settings arrive: the player probes WebRTC once while it
  // starts, so a guard that waited would usually miss it. A viewer who switched the
  // guard off gets the real objects back as soon as the settings land.
  const guardOn = () => !settingsLoaded || (settings.enabled && settings.videoP2pBlock !== false);

  // Bilibili's player only uses P2P when the SDKs load and WebRTC is available; with
  // neither it stays on the HTTP CDN path. The getters hand out the page's own objects
  // whenever the guard is off, and the setters keep whatever the page assigns.
  class MockPcdn { on() {} off() {} emit() {} destroy() {} }
  const guard = (name, blocked) => {
    let real = root[name];
    try {
      Object.defineProperty(root, name, {
        configurable: true,
        get() { return guardOn() ? blocked : real; },
        set(value) { real = value; }
      });
    } catch (_error) {}
  };
  for (const name of ["PCDNLoader", "BPP2PSDK", "SeederSDK"]) guard(name, MockPcdn);
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) {
    if (name in root) guard(name, undefined);
  }

  root.addEventListener("message", (event) => {
    if (event.source !== root || event.data?.channel !== CHANNEL || event.data.type !== "settings") return;
    settings = rangeCore.normalizeSettings(event.data.payload);
    settingsLoaded = true;
  });
})(globalThis);
