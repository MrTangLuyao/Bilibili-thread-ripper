// Prints a released version's section of CHANGELOG.md, for its GitHub Release, after checking
// that the published userscript carries that version. The Release workflow runs it on the tag:
// `node scripts/release-notes.mjs 2026.10.24.1`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_OUTPUT, VERSION_PATTERN, root } from "./build.mjs";

function stop(message) {
  console.error(`发布停止：${message}`);
  process.exit(1);
}

const version = String(process.argv[2] || "");
if (!VERSION_PATTERN.test(version)) stop(`版本号必须是四段数字：${version}`);
const published = /^\/\/ @version\s+(\S+)$/m.exec(readFileSync(join(root, RELEASE_OUTPUT), "utf8"))?.[1];
if (published !== version) stop(`${RELEASE_OUTPUT} 的版本是 ${published}，不是 ${version}。`);
const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split(/\r?\n/);
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start < 0) stop(`CHANGELOG.md 里没有 ${version} 这一节。`);
const end = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
const notes = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
if (!notes) stop(`CHANGELOG.md 里 ${version} 这一节是空的。`);
console.log(notes);
