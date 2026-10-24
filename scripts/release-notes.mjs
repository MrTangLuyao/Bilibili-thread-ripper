// Prints a released version's section of CHANGELOG.md, for its GitHub Release, after checking
// that the published userscript carries that version. The Release workflow runs it on the tag:
// `node scripts/release-notes.mjs 2026.10.24.1`. Every Release starts with NOTICE, for people
// who come from the early video about the Chrome extension, which is no longer maintained.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_OUTPUT, VERSION_PATTERN, root } from "./build.mjs";

export const NOTICE = "> [!NOTE]\n> 早期视频里介绍的 Chrome 独立插件版已经停止维护，请不要再安装。安装方法见[安装说明](https://github.com/MrTangLuyao/Bilibili-thread-ripper#-%E5%AE%89%E8%A3%85)。";

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
console.log(`${NOTICE}\n\n${notes}`);
