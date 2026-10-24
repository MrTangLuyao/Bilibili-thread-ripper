// Bilibili's international site: the same pages under a language, /zh-Hans/video/…,
// /en/bangumi/play/…, /ja/list/watchlater, or with ?site=OVERSEAS&lang=…, and a home page
// without the channel bar. The user_site cookie (CN or OVERSEAS) tells both Bilibili's
// server and its page code which site to show. page-hook.js reads addresses with the language
// taken off; bridge.js keeps viewers on the domestic site while 阻止使用国际版 is on (off unless
// switched on).
//
// The languages keep growing, so one is recognised by its form and by the browser knowing it
// as a language, besides the ones the site has today (Chrome knows fewer languages than Node).
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

  // The same page on the domestic site, or "" when this already is one.
  function domesticAddress(href) {
    let url;
    try { url = new URL(String(href)); } catch (_error) { return ""; }
    if (url.hostname !== "www.bilibili.com") return "";
    let changed = false;
    const path = withoutLanguage(url.pathname);
    if (path !== url.pathname) { url.pathname = path; changed = true; }
    if (String(url.searchParams.get("site") || "").toUpperCase() === "OVERSEAS") {
      url.searchParams.delete("site");
      url.searchParams.delete("lang");
      changed = true;
    }
    return changed ? url.href : "";
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

  root.__BTR_BILIBILI_SITE__ = Object.freeze({ isLanguage, withoutLanguage, domesticAddress, keepDomestic, stopKeepingDomestic, mayRedirect });
})(globalThis);
