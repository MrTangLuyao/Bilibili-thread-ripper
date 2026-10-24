// Builds the Canary userscript into canary/: the code as it is now, under its own name and
// its own version, for contributors and anyone who wants to try what comes next. The Canary
// workflow runs it after the tests pass and commits the file; it also runs here:
// `node scripts/canary.mjs`.
//
// The version is today's date (Melbourne time) and that day's Canary build number, counted on
// from the file already there: 2026.10.24.1, 2026.10.24.2, … It never goes backwards, and it
// has nothing to do with the released version, since the two are different scripts.
//
// Nothing is written when the code is the same as in the file already there, so a run
// without code changes leaves nothing to commit.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CANARY_OUTPUT, buildUserscript, canaryUrl, root, writeUserscript } from "./build.mjs";

const TIME_ZONE = "Australia/Melbourne";

export function melbourneDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return `${parts.year}.${parts.month}.${parts.day}`;
}

export function versionOf(script) {
  return /^\/\/ @version\s+(\S+)$/m.exec(script || "")?.[1] || "";
}

// The next Canary version after the one already published.
export function nextCanaryVersion(previous, now = new Date()) {
  const today = melbourneDate(now);
  const [y, m, d, n] = String(previous || "").split(".").map(Number);
  return `${y}.${m}.${d}` === today && Number.isSafeInteger(n) ? `${today}.${n + 1}` : `${today}.1`;
}

// Whether the code now builds to exactly the file already published, under its version. A
// Windows checkout may have given that file CRLF line endings; the build writes LF.
export function unchanged(previous, buildAt) {
  const version = versionOf(previous);
  return Boolean(version) && buildAt(version) === previous.replace(/\r\n/g, "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = join(root, CANARY_OUTPUT);
  const updateUrl = canaryUrl(process.env.GITHUB_REPOSITORY || undefined);
  const previous = existsSync(output) ? readFileSync(output, "utf8") : "";
  const report = (values) => {
    if (!process.env.GITHUB_OUTPUT) return;
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
  };
  if (unchanged(previous, (version) => buildUserscript(version, { channel: "canary", updateUrl }))) {
    console.log(`代码和 Canary ${versionOf(previous)} 一样，不用更新。`);
    report({ changed: "false", version: versionOf(previous) });
  } else {
    const version = nextCanaryVersion(versionOf(previous));
    writeUserscript(version, CANARY_OUTPUT, { channel: "canary", updateUrl });
    console.log(`Canary ${version}: ${output}`);
    report({ changed: "true", version });
  }
}
