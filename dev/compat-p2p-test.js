(function installCompatP2pTest(root) {
  "use strict";

  // The compatibility mode with the real native-range-transport.js. Bilibili's core can take
  // pieces from other viewers (NC, and the P2P it calls RP), switched on by a remote setting;
  // those pieces never come through the requests BTR downloads. What is checked: while BTR
  // speeds up a player, its core is told not to use them, again when Bilibili switches them
  // back on, and gets Bilibili's own choice back when BTR lets go; with BTR switched off, or
  // on a core without these switches, nothing changes.
  const CID = "900000031";
  const VIDEO = `https://upos-sz-mirrorali.bilivideo.com/upgcxcode/11/22/${CID}/${CID}-1-100026.m4s?sig=video`;
  const AUDIO = `https://upos-sz-mirrorali.bilivideo.com/upgcxcode/11/22/${CID}/${CID}-1-30280.m4s?sig=audio`;
  const video = document.querySelector("video");
  let useNC = true, useP2P = true;
  const dash = { getVideoElement: () => video, on() {}, off() {}, getQualityFor: () => 0,
    getUseNC: () => useNC, setUseNC: (value) => { useNC = value; },
    getUseP2P: () => useP2P, setUseP2P: (value) => { useP2P = value; } };
  const plain = { getVideoElement: () => video, on() {}, off() {}, getQualityFor: () => 0 };
  let core = dash;
  const wrapper = { getCorePlayer: () => core, fire() {}, getQualityChangedData: (event) => event };
  root.player = { __core: () => wrapper, getQuality: () => ({ nowQ: 80, newQ: 80, realQ: 80 }) };

  const result = document.getElementById("compat-p2p-result");
  const output = { steps: {} };
  const finish = () => {
    output.pass = Object.values(output.steps).length >= 6 && Object.values(output.steps).every(Boolean);
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const settings = { enabled: true, takeover: "compat", mode: "overseas", concurrency: 8, autoConcurrency: false };
  const newPlayer = () => root.__BILI_NATIVE_RANGE_PLAYER_FACTORY__.createNativePlayer({
    container: document.querySelector(".bpx-player-container"),
    getSettings: () => settings,
    cdnBans: root.__BILI_CDN_RESOLVER_FACTORY__.createBanList(),
    playinfo: { data: { dash: {
      video: [{ id: 80, baseUrl: VIDEO, backupUrl: [], mimeType: "video/mp4", codecs: "avc1.640032", bandwidth: 3000000 }],
      audio: [{ id: 30280, baseUrl: AUDIO, backupUrl: [], mimeType: "audio/mp4", codecs: "mp4a.40.2", bandwidth: 128000 }]
    } } }
  });

  addEventListener("load", async () => {
    try {
      let player = newPlayer();
      await settle();
      output.steps.turnedOff = useNC === false && useP2P === false;

      // Bilibili switches them back on (its configuration runs again): off again at the next look.
      useNC = true; useP2P = true;
      video.dispatchEvent(new Event("timeupdate"));
      output.steps.keptOff = useNC === false && useP2P === false;

      const debug = player.getDebug();
      output.steps.diagnosticsSayIt = debug.peerLoading === "off, Bilibili had NC true P2P true"
        && debug.timeline.filter((entry) => entry.what === "peer loading off").length === 1;
      output.peerLoading = debug.peerLoading;

      // BTR lets go of the player (another video, or switched off): Bilibili's choice is back.
      player.destroy();
      output.steps.restoredOnDestroy = useNC === true && useP2P === true;

      // Switched off in the settings: the core is left as Bilibili set it.
      settings.enabled = false;
      player = newPlayer();
      await settle();
      video.dispatchEvent(new Event("timeupdate"));
      output.steps.untouchedWhenOff = useNC === true && useP2P === true && player.getDebug().peerLoading === "untouched";
      player.destroy();
      settings.enabled = true;

      // A core without these switches (an older client) works as before.
      core = plain;
      player = newPlayer();
      await settle();
      video.dispatchEvent(new Event("timeupdate"));
      output.steps.olderCoreUnharmed = player.transportActive && player.getDebug().peerLoading === "untouched";
      player.destroy();
    } catch (error) { output.error = String(error?.stack || error); }
    finish();
  });
})(globalThis);
