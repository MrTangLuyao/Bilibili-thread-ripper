"use strict";
// Runs the tests one after another: `node dev/run-tests.js` (or `npm test`).
// The browser tests need dev/server.js; it is started here unless one is already running.
// Playwright comes from NODE_PATH, Chrome from BTR_CHROME_PATH (see the tests).
// The tests that play real videos from Bilibili only run when BTR_TEST_BVID and
// BTR_TEST_CID name one.
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const unit = ["shared-core-test", "vod-selection-test", "auto-concurrency-test", "live-core-test", "optimization-test"];
const browser = ["notification-smoke-test", "notification-error-test", "userscript-test", "regression-smoke-test"];
const network = process.env.BTR_TEST_BVID && process.env.BTR_TEST_CID ? ["native-mse-end-test"] : [];

function serverUp() {
  return new Promise((resolve) => {
    const socket = net.connect(18763, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn(process.execPath, [path.join(root, "dev/server.js")], { cwd: root, stdio: "ignore" });
    for (let i = 0; i < 50 && !(await serverUp()); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const failed = [];
  try {
    for (const name of [...unit, ...browser, ...network]) {
      const started = Date.now();
      const result = spawnSync(process.execPath, [path.join(root, "dev", `${name}.js`)], { cwd: root, encoding: "utf8", env: process.env });
      const ok = result.status === 0;
      console.log(`${ok ? "PASS" : "FAIL"} ${name} (${((Date.now() - started) / 1000).toFixed(1)} 秒)`);
      if (!ok) {
        failed.push(name);
        console.log(`${result.stdout || ""}${result.stderr || ""}`.trim().split("\n").slice(-20).join("\n"));
      }
    }
  } finally {
    server?.kill();
  }
  if (!network.length) console.log("没有设置 BTR_TEST_BVID / BTR_TEST_CID，跳过需要真实视频的测试");
  console.log(failed.length ? `${failed.length} 项失败：${failed.join("、")}` : "全部通过");
  process.exitCode = failed.length ? 1 : 0;
})();
