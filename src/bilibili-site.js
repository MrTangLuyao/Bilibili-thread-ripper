// Bilibili's international site: the same pages under a language, /zh-Hans/video/…,
// /en/bangumi/play/…, /ja/list/watchlater, or with ?site=OVERSEAS&lang=…, and a home page
// without the channel bar. The user_site cookie (CN or OVERSEAS) tells both Bilibili's
// server and its page code which site to show. page-hook.js reads addresses with the language
// taken off; bridge.js keeps viewers on the domestic site while BTR and 阻止使用国际版 are both
// on (阻止使用国际版 is off unless switched on).
//
// The languages keep growing, so one is recognised by its form and by the browser knowing it
// as a language, besides the ones the site has today (Chrome knows fewer languages than Node).
//
// A video's address can also name it by its av number (/video/av170001: an old link, or an
// address another script rewrote); avToBv gives the BV number of the same video.
(function installBilibiliSite(root) {
  "use strict";

  const KNOWN = ["zh-hans", "zh-hant", "en", "ja", "th", "vi", "id", "ar", "pt", "es", "tr", "ru", "ms"];
  const TAG = /^[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?$/i;
  const COOKIE = "domain=.bilibili.com; path=/; max-age=31536000";
  // Two trips back to the domestic site within this time: Bilibili keeps sending this tab to
  // the international one (a signed-in account it allows nothing else), so it is left there.
  const REDIRECT_WINDOW_MS = 15000;
  const REDIRECT_KEY = "btr-domestic-site-redirects";
  let names = null;
  try { names = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }); } catch (_error) {}

  function isLanguage(segment) {
    const value = String(segment || "");
    if (!TAG.test(value)) return false;
    if (KNOWN.includes(value.toLowerCase())) return true;
    try { return Boolean(names?.of(value)); } catch (_error) { return false; }
  }

  // The address's path without the language in front: /zh-Hans/video/BV… → /video/BV….
  function withoutLanguage(pathname) {
    const [, first = "", ...rest] = String(pathname || "/").split("/");
    return isLanguage(first) ? `/${rest.join("/")}` : String(pathname || "/");
  }

  // The same page on the domestic site, or "" when this already is one. Space pages have an
  // international site too (space.bilibili.com/en/2); there only the site's own languages are
  // taken off, as its router has them.
  function domesticAddress(href) {
    let url;
    try { url = new URL(String(href)); } catch (_error) { return ""; }
    let path = url.pathname;
    if (url.hostname === "www.bilibili.com") path = withoutLanguage(path);
    else if (url.hostname === "space.bilibili.com") {
      const [, first = "", ...rest] = path.split("/");
      if (KNOWN.includes(first.toLowerCase())) path = `/${rest.join("/")}`;
    } else return "";
    if (path === url.pathname && String(url.searchParams.get("site") || "").toUpperCase() !== "OVERSEAS") return "";
    url.pathname = path;
    url.search = withoutSiteParameters(url.search);
    return url.href;
  }

  // The query without the international site's own parameters (site=, lang=), the rest kept as
  // written, as Bilibili's page code does.
  function withoutSiteParameters(search) {
    const kept = String(search || "").replace(/^\?/, "").split("&").filter((part) => !/^(site|lang)=/i.test(part));
    return kept.join("&") ? `?${kept.join("&")}` : "";
  }

  // Whether a navigation goes from a domestic page to the same page on the international
  // site: the redirect Bilibili's page code makes once it knows who is signed in. For a signed-
  // in viewer it decides by the account (its default_sites cookie) and not by user_site, so
  // keeping user_site on CN does not stop it (#68).
  function isSiteRedirect(destination, current) {
    let from, to;
    try { from = new URL(String(current)); to = new URL(String(destination)); } catch (_error) { return false; }
    if (from.host !== to.host || domesticAddress(from.href)) return false;
    const twin = domesticAddress(to.href);
    if (!twin) return false;
    const page = (url) => { const parsed = new URL(url); return `${parsed.pathname.replace(/\/+$/, "") || "/"}${withoutSiteParameters(parsed.search)}`; };
    return page(twin) === page(from.href);
  }

  function readCookie(name) {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(document.cookie);
    return match ? match[1] : null;
  }

  // Tells the server and Bilibili's page code to show the domestic site, so that
  // bilibili.com/ is never sent on to bilibili.com/<language>.
  function keepDomestic() {
    if (readCookie("user_site") !== "CN") document.cookie = `user_site=CN; ${COOKIE}`;
  }

  // When the switch goes off, Bilibili chooses the site again, as it would without BTR.
  function stopKeepingDomestic() {
    if (readCookie("user_site") === "CN") document.cookie = `user_site=; domain=.bilibili.com; path=/; max-age=0`;
  }

  // Without the tab's own storage there is no way to tell a loop, so no redirect either.
  function mayRedirect(now = Date.now()) {
    try {
      const recent = JSON.parse(sessionStorage.getItem(REDIRECT_KEY) || "[]").filter((at) => now - at < REDIRECT_WINDOW_MS);
      if (recent.length >= 2) return false;
      sessionStorage.setItem(REDIRECT_KEY, JSON.stringify([...recent, now]));
      return true;
    } catch (_error) { return false; }
  }

  // Bilibili's published conversion, for every av number below 2^51; "" for anything else.
  function avToBv(aid) {
    const text = String(aid ?? "").trim();
    if (!/^\d{1,16}$/.test(text)) return "";
    const number = BigInt(text);
    if (number < 1n || number >= 1n << 51n) return "";
    const table = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
    const chars = ["B", "V", "1", "0", "0", "0", "0", "0", "0", "0", "0", "0"];
    let value = ((1n << 51n) | number) ^ 23442827791579n;
    for (let index = chars.length - 1; value > 0n; index -= 1) {
      chars[index] = table[Number(value % 58n)];
      value /= 58n;
    }
    [chars[3], chars[9]] = [chars[9], chars[3]];
    [chars[4], chars[7]] = [chars[7], chars[4]];
    return chars.join("");
  }

  root.__BTR_BILIBILI_SITE__ = Object.freeze({ isLanguage, withoutLanguage, domesticAddress, isSiteRedirect, keepDomestic, stopKeepingDomestic, mayRedirect, avToBv });
})(globalThis);
