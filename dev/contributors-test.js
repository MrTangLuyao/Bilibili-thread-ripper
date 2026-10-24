"use strict";
// The contributors picture scripts/contributors.mjs draws for README.md.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  const root = path.resolve(__dirname, "..");
  const contributors = await import(pathToFileURL(path.join(root, "scripts/contributors.mjs")).href);
  const person = (login) => ({ login, image: "data:image/png;base64,AAAA" });

  // One row of 64-pixel avatars 4 pixels apart, in GitHub's order, like contrib.rocks.
  const ten = contributors.drawContributors(Array.from({ length: 10 }, (_item, index) => person(`user${index}`)));
  assert.match(ten, /^<svg [^>]*width="676" height="64" viewBox="0 0 676 64">/);
  assert.deepEqual([...ten.matchAll(/<title>([^<]*)<\/title>/g)].map((match) => match[1]), Array.from({ length: 10 }, (_item, index) => `user${index}`));
  assert.match(ten, /<g transform="translate\(612 0\)">/);
  // Twelve to a row; a thirteenth starts the next one.
  const thirteen = contributors.drawContributors(Array.from({ length: 13 }, (_item, index) => person(`user${index}`)));
  assert.match(thirteen, /width="812" height="132"/);
  assert.match(thirteen, /<g transform="translate\(0 68\)"><title>user12<\/title>/);
  // Names are escaped, and an empty list stops instead of drawing nothing.
  assert.match(contributors.drawContributors([person("a<b")]), /<title>a&lt;b<\/title>/);
  assert.throws(() => contributors.drawContributors([]), /空的/);
  // The README shows the picture from the repository.
  assert.match(readFileSync(path.join(root, "README.md"), "utf8"), new RegExp(`<img src="${contributors.OUTPUT}" alt="贡献者">`));
  console.log("PASS 贡献者图片按 GitHub 的顺序画，一行 12 个");
})().catch((error) => { console.error(error); process.exitCode = 1; });
