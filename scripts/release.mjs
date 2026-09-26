// Publishes a version: `node scripts/release.mjs` (or `npm run release`).
//
// 1. Checks: nothing uncommitted, on main, not behind origin, the tags fetched, and something
//    written under "## [Unreleased]" in CHANGELOG.md.
// 2. The version is today's date (Melbourne time) and the day's release number:
//    2026.9.26.1, 2026.9.26.2, …
// 3. "## [Unreleased]" gets a new heading "## [2026.9.26.1] - 2026-09-26" under it, so what
//    was written there becomes this release; older entries stay as they are.
// 4. Builds user_scripts/bilibili-thread-ripper.user.js and runs dev/run-tests.js.
// 5. Commits "release 2026.9.26.1" and tags it.
// 6. Prints this release's CHANGELOG section and the push commands. It does not push: the
//    file on main is what every user's script manager downloads.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_OUTPUT, VERSION_PATTERN, root, writeUserscript } from "./build.mjs";

const TIME_ZONE = "Australia/Melbourne";
const CHANGELOG = join(root, "CHANGELOG.md");
const UNRELEASED = "## [Unreleased]";

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
function stop(message) {
  console.error(`发版停止：${message}`);
  process.exit(1);
}

// ---- 1. Checks ----
if (git("status", "--porcelain")) stop("工作区有没提交的改动，先提交或者撤销。");
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") stop("只能在 main 分支上发版。");
try { git("fetch", "--tags", "origin"); } catch (_error) { stop("拉不到远端的 tag 和提交，检查网络后再试。"); }
if (Number(git("rev-list", "--count", "HEAD..origin/main"))) stop("本地 main 落后于 origin/main，先 git pull。");

const changelog = readFileSync(CHANGELOG, "utf8");
const eol = changelog.includes("\r\n") ? "\r\n" : "\n";
const lines = changelog.split(/\r?\n/);
const start = lines.indexOf(UNRELEASED);
if (start < 0) stop(`CHANGELOG.md 里没有 "${UNRELEASED}" 这一节。`);
let end = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
if (end < 0) end = lines.length;
if (!lines.slice(start + 1, end).some((line) => line.trim())) stop(`"${UNRELEASED}" 下面是空的，先写这次改了什么。`);

// ---- 2. Version ----
const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "numeric", day: "numeric" })
  .formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
const prefix = `${parts.year}.${parts.month}.${parts.day}.`;
const tags = git("tag", "--list").split("\n").filter((tag) => VERSION_PATTERN.test(tag));
const sameDay = tags.filter((tag) => tag.startsWith(prefix)).map((tag) => Number(tag.slice(prefix.length)));
const version = `${prefix}${Math.max(0, ...sameDay) + 1}`;
const newer = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 4; i += 1) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const ahead = tags.find((tag) => !newer(version, tag));
if (ahead) stop(`已经有一个不比 ${version} 旧的版本 ${ahead}，检查电脑的日期。`);
const date = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;

// ---- 3. CHANGELOG ----
const heading = `## [${version}] - ${date}`;
const section = [heading, ...lines.slice(start + 1, end)].join("\n").trim();
lines.splice(start + 1, 0, "", heading);
writeFileSync(CHANGELOG, lines.join(eol));

// ---- 4. Build and test ----
const undo = () => git("checkout", "--", "CHANGELOG.md", RELEASE_OUTPUT);
try {
  writeUserscript(version, RELEASE_OUTPUT);
} catch (error) {
  undo();
  stop(`构建失败：${error.message}`);
}
console.log(`构建完成：${version}，开始测试……`);
const tests = spawnSync(process.execPath, [join(root, "dev/run-tests.js")], { cwd: root, stdio: "inherit" });
if (tests.status !== 0) {
  undo();
  stop("测试没有全部通过，CHANGELOG.md 和油猴脚本已经改回原样。");
}

// ---- 5. Commit and tag ----
git("add", "CHANGELOG.md", RELEASE_OUTPUT);
git("commit", "-m", `release ${version}`);
git("tag", version);

// ---- 6. What to do next ----
console.log(`\n已提交并打好 tag：${version}\n`);
console.log("GitHub release 的说明（可以直接复制）：\n");
console.log(section.slice(heading.length).trim());
console.log("\n确认没问题后推送（推送到 main 就等于发给所有用户）：\n");
console.log("  git push origin main");
console.log(`  git push origin ${version}`);
