// Draws pics/contributors.svg, the contributors at the end of README.md: GitHub's list of the
// people whose commits are on main, most commits first, drawn the way contrib.rocks does. The
// avatars are inside the file, so GitHub shows the picture as it is in the repository instead
// of a copy it cached. Run it by hand when someone new has contributed, and commit the
// picture: `node scripts/contributors.mjs`. GitHub's list can be a few hours behind.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { root } from "./build.mjs";

export const OUTPUT = "pics/contributors.svg";
const SIZE = 64;
const GAP = 4;
const COLUMNS = 12;

const escape = (text) => String(text).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]);

// people: [{ login, image: "data:image/…;base64,…" }], in the order they are drawn.
export function drawContributors(people) {
  if (!people.length) throw new Error("GitHub 的贡献者列表是空的，图片保持不变。");
  const columns = Math.min(COLUMNS, people.length);
  const rows = Math.ceil(people.length / COLUMNS);
  const width = columns * (SIZE + GAP) - GAP, height = rows * (SIZE + GAP) - GAP;
  const avatars = people.map((person, index) => {
    const x = (index % COLUMNS) * (SIZE + GAP), y = Math.floor(index / COLUMNS) * (SIZE + GAP);
    return [
      `<g transform="translate(${x} ${y})"><title>${escape(person.login)}</title>`,
      `<image width="${SIZE}" height="${SIZE}" clip-path="url(#avatar)" xlink:href="${escape(person.image)}"/>`,
      `<circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2 - 0.5}" fill="none" stroke="#c0c0c0"/></g>`
    ].join("\n");
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><clipPath id="avatar"><circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2}"/></clipPath></defs>`,
    ...avatars,
    "</svg>",
    ""
  ].join("\n");
}

async function fetchJson(url, token) {
  const response = await fetch(url, { headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok) throw new Error(`${url}：HTTP ${response.status}`);
  return response.json();
}

// Twice the drawn size, for screens with more pixels than CSS pixels.
async function fetchAvatar(url) {
  const avatar = new URL(url);
  avatar.searchParams.set("s", String(SIZE * 2));
  const response = await fetch(avatar);
  if (!response.ok) throw new Error(`${avatar.href}：HTTP ${response.status}`);
  const type = (response.headers.get("content-type") || "image/png").split(";")[0];
  return `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const listed = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchJson(`https://api.github.com/repos/MrTangLuyao/Bilibili-thread-ripper/contributors?per_page=100&page=${page}`, token);
    listed.push(...batch);
    if (batch.length < 100) break;
  }
  const people = [];
  for (const person of listed.filter((entry) => entry.type === "User" && entry.login)) {
    people.push({ login: person.login, image: await fetchAvatar(person.avatar_url) });
  }
  const file = join(root, OUTPUT);
  const picture = drawContributors(people);
  if (existsSync(file) && readFileSync(file, "utf8") === picture) console.log(`贡献者没有变化（${people.length} 人）。`);
  else {
    writeFileSync(file, picture);
    console.log(`${OUTPUT} 重新生成了：${people.map((person) => person.login).join("、")}`);
  }
}
