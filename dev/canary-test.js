"use strict";
// The Canary's version and when scripts/canary.mjs writes a new file.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  const root = path.resolve(__dirname, "..");
  const canary = await import(pathToFileURL(path.join(root, "scripts/canary.mjs")).href);
  const build = await import(pathToFileURL(path.join(root, "scripts/build.mjs")).href);

  // Melbourne time decides the day: 23:30 UTC on the 23rd is already the 24th there.
  const late = new Date("2026-10-23T23:30:00Z");
  assert.equal(canary.melbourneDate(late), "2026.10.24");
  assert.equal(canary.nextCanaryVersion("", late), "2026.10.24.1", "the first Canary of a day");
  assert.equal(canary.nextCanaryVersion("2026.10.24.1", late), "2026.10.24.2", "the next build that day");
  assert.equal(canary.nextCanaryVersion("2026.10.24.9", late), "2026.10.24.10");
  assert.equal(canary.nextCanaryVersion("2026.10.23.7", late), "2026.10.24.1", "a new day starts again at 1");
  assert.equal(canary.nextCanaryVersion("not a version", late), "2026.10.24.1");
  for (const version of ["2026.10.24.1", "2026.10.24.12"]) assert.match(version, build.VERSION_PATTERN);
  console.log("PASS Canary 版本号按墨尔本日期算，当天从 1 开始往上加");

  const buildAt = (version) => build.buildUserscript(version, { channel: "canary" });
  const published = buildAt("2026.10.24.3");
  assert.equal(canary.versionOf(published), "2026.10.24.3");
  assert.equal(canary.unchanged(published, buildAt), true, "the same code is not published again");
  assert.equal(canary.unchanged(published.replace("pageCode", "pageCode "), buildAt), false, "changed code is published");
  assert.equal(canary.unchanged("", buildAt), false, "nothing published yet");
  // The released script never counts as the Canary's previous build.
  assert.equal(canary.unchanged(build.buildUserscript("2026.10.24.3"), buildAt), false);
  console.log("PASS 代码没变就不发新的 Canary，变了才发");
})().catch((error) => { console.error(error); process.exitCode = 1; });
