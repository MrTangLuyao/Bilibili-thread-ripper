// Builds the userscript: the header from user_scripts/adapter/meta.json, the page code (its
// pageFiles, in that order) wrapped in pageCode(), and the loader after it. The version is
// written in here and nowhere else: the source files carry the __BTR_VERSION__ placeholder,
// and __BTR_CHANNEL__ for which of the two scripts this is ("stable" or "canary").
//
//   node scripts/build.mjs                        development build into dist/, with the
//                                                 version of the latest tag
//   node scripts/build.mjs --canary               the same, built as the Canary, into dist/
//   node scripts/build.mjs --release 2026.9.26.1  the file users install and update from;
//                                                 only scripts/release.mjs does this
//
// The Canary is a second script beside the released one: its own name, so a script manager
// keeps both and updates each on its own, and its own file, canary/ on main, which
// scripts/canary.mjs writes after the tests pass.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const meta = JSON.parse(readFileSync(join(root, "user_scripts/adapter/meta.json"), "utf8"));
export const RELEASE_OUTPUT = meta.output;
export const DEV_OUTPUT = "dist/bilibili-thread-ripper.user.js";
export const CANARY_OUTPUT = "canary/bilibili-thread-ripper-canary.user.js";
export const CANARY_DEV_OUTPUT = "dist/bilibili-thread-ripper-canary.user.js";
// Four numeric parts, always: older Tampermonkey compares only as many parts as both versions
// have, and Greasemonkey 4 refuses more than four.
export const VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;
const PLACEHOLDER = "__BTR_VERSION__";
const CHANNEL_PLACEHOLDER = "__BTR_CHANNEL__";

// Where the Canary file is served from, in the repository it is published in.
export function canaryUrl(repository = "MrTangLuyao/Bilibili-thread-ripper") {
  return `https://raw.githubusercontent.com/${repository}/main/${CANARY_OUTPUT}`;
}

function source(file) {
  return readFileSync(join(root, file), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

export function latestTag() {
  return execFileSync("git", ["describe", "--tags", "--abbrev=0"], { cwd: root, encoding: "utf8" }).trim();
}

export function buildUserscript(version, { channel = "stable", updateUrl = canaryUrl() } = {}) {
  if (!VERSION_PATTERN.test(version)) throw new Error(`版本号必须是四段数字：${version}`);
  if (!["stable", "canary"].includes(channel)) throw new Error(`没有这个渠道：${channel}`);
  const canary = channel === "canary";
  const header = meta.header.map(([key, value]) => {
    let text = value.replace("{version}", version);
    if (canary && key === "name") text = `${text} Canary`;
    if (canary && key === "description") text = `测试版：跟着开发中的最新代码自动更新，可能不稳定。${text}`;
    if (canary && (key === "updateURL" || key === "downloadURL")) text = updateUrl;
    return `// ${`@${key}`.padEnd(13)} ${text}`;
  });
  const fill = (text) => text.split(PLACEHOLDER).join(version).split(CHANNEL_PLACEHOLDER).join(channel);
  let text = ["// ==UserScript==", ...header, "// ==/UserScript==", "", "// 这个文件由 scripts/build.mjs 生成，不要直接修改。"].join("\n");
  text += "\n(function () {\n\"use strict\";\n\nfunction pageCode() {\n\"use strict\";\n";
  text += "if (document.documentElement?.hasAttribute(\"data-btr-userscript\")) return;\n";
  text += "document.documentElement?.setAttribute(\"data-btr-userscript\", \"\");\n";
  // The live player sits in a live.bilibili.com iframe (/blanc/…), so frames get the script
  // too; every other bilibili iframe (comments, events) leaves at once. It is marked as
  // started first all the same: without the mark the loader takes the start for failed.
  text += "if (window.top !== window && !/^live\\.bilibili\\.com$/i.test(location.hostname)) return;\n";
  for (const file of meta.pageFiles) text += `\n/* ${file} */\n${fill(source(file))}\n`;
  text += "}\n";
  text += `\n/* ${meta.loader} */\n${fill(source(meta.loader))}\n`;
  text += "})();\n";
  return text;
}

export function writeUserscript(version, output, options) {
  const text = buildUserscript(version, options);
  mkdirSync(dirname(join(root, output)), { recursive: true });
  writeFileSync(join(root, output), text);
  return join(root, output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const at = process.argv.indexOf("--release");
  const release = at >= 0;
  const canary = process.argv.includes("--canary");
  const version = release ? String(process.argv[at + 1] || "") : latestTag();
  const file = writeUserscript(version, release ? RELEASE_OUTPUT : canary ? CANARY_DEV_OUTPUT : DEV_OUTPUT, { channel: canary && !release ? "canary" : "stable" });
  console.log(`${release ? "正式版" : canary ? "Canary 开发版" : "开发版"} ${version}: ${file}`);
}
