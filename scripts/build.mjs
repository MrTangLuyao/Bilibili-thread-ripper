// Builds the userscript: the header from user_scripts/adapter/meta.json, the page code (its
// pageFiles, in that order) wrapped in pageCode(), and the loader around it. The version is
// written in here and nowhere else: the source files carry the __BTR_VERSION__ placeholder.
//
//   node scripts/build.mjs                        development build into dist/, with the
//                                                 version of the latest tag
//   node scripts/build.mjs --release 2026.9.26.1  the file users install and update from;
//                                                 only scripts/release.mjs does this
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const meta = JSON.parse(readFileSync(join(root, "user_scripts/adapter/meta.json"), "utf8"));
export const RELEASE_OUTPUT = meta.output;
export const DEV_OUTPUT = "dist/bilibili-thread-ripper.user.js";
// Four numeric parts, always: older Tampermonkey compares only as many parts as both versions
// have, and Greasemonkey 4 refuses more than four.
export const VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;
const PLACEHOLDER = "__BTR_VERSION__";

function source(file) {
  return readFileSync(join(root, file), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

export function latestTag() {
  return execFileSync("git", ["describe", "--tags", "--abbrev=0"], { cwd: root, encoding: "utf8" }).trim();
}

export function buildUserscript(version) {
  if (!VERSION_PATTERN.test(version)) throw new Error(`版本号必须是四段数字：${version}`);
  const header = meta.header.map(([key, value]) => `// ${`@${key}`.padEnd(13)} ${value.replace("{version}", version)}`);
  let text = ["// ==UserScript==", ...header, "// ==/UserScript==", "", "// 这个文件由 scripts/build.mjs 生成，不要直接修改。"].join("\n");
  text += "\n(function () {\n\"use strict\";\n\nfunction pageCode() {\n\"use strict\";\n";
  // The live player sits in a live.bilibili.com iframe (/blanc/…), so frames get the script
  // too; every other bilibili iframe (comments, events) leaves at once.
  text += "if (window.top !== window && !/^live\\.bilibili\\.com$/i.test(location.hostname)) return;\n";
  text += "if (document.documentElement?.hasAttribute(\"data-btr-userscript\")) return;\n";
  text += "document.documentElement?.setAttribute(\"data-btr-userscript\", \"\");\n";
  for (const file of meta.pageFiles) text += `\n/* ${file} */\n${source(file).split(PLACEHOLDER).join(version)}\n`;
  text += "}\n";
  text += `\n/* ${meta.loader} */\n${source(meta.loader)}\n`;
  text += "})();\n";
  return text;
}

export function writeUserscript(version, output) {
  const text = buildUserscript(version);
  mkdirSync(dirname(join(root, output)), { recursive: true });
  writeFileSync(join(root, output), text);
  return join(root, output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const at = process.argv.indexOf("--release");
  const release = at >= 0;
  const version = release ? String(process.argv[at + 1] || "") : latestTag();
  const file = writeUserscript(version, release ? RELEASE_OUTPUT : DEV_OUTPUT);
  console.log(`${release ? "正式版" : "开发版"} ${version}: ${file}`);
}
