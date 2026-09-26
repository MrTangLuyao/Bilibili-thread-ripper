// Runs wherever the userscript manager puts the script. The accelerator itself has to run in
// the bilibili page, so pageCode is started there. The manager's menu only sends a page
// event that opens the settings panel.
const LOADED = "data-btr-userscript";
const pageWindow = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;

// The settings live in the manager's storage, which every bilibili subdomain shares; this
// site's localStorage is separate on each one, so a setting changed on space.bilibili.com
// never reached the video pages. Only this side of the script can use the manager's storage:
// the page code (storage-shim.js) asks for it with events carrying JSON text. The first time,
// what this subdomain's localStorage held is taken over; it stays there too.
const STORAGE_MARK = "data-btr-userscript-storage";
const manager = typeof GM !== "undefined" && typeof GM?.getValue === "function" && typeof GM?.setValue === "function" ? GM : null;
const managerReportsChanges = typeof GM_addValueChangeListener === "function";

function answerPage(type, message) {
  document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(message) }));
}

function serveStorage() {
  const read = async (area) => {
    const stored = await manager.getValue(area);
    if (typeof stored === "string") return stored;
    let earlier = null;
    try { earlier = localStorage.getItem(`BTR_Userscript.${area}`); } catch (_error) {}
    if (earlier) await manager.setValue(area, earlier);
    return earlier || "{}";
  };
  // One request at a time: a change reads what is stored and writes it back.
  let queue = Promise.resolve();
  document.addEventListener("btr-userscript-storage-request", (event) => {
    let request = null;
    try { request = JSON.parse(event.detail); } catch (_error) { return; }
    if (!request || !["sync", "local"].includes(request.area)) return;
    queue = queue.then(async () => {
      let value = {};
      try { value = JSON.parse(await read(request.area)) || {}; } catch (_error) {}
      if (request.op === "set") Object.assign(value, request.items);
      else if (request.op === "remove") for (const key of [].concat(request.keys)) delete value[key];
      if (request.op === "set" || request.op === "remove") await manager.setValue(request.area, JSON.stringify(value));
      answerPage("btr-userscript-storage-reply", { id: request.id, value });
    }).catch((error) => answerPage("btr-userscript-storage-reply", { id: request.id, error: String(error?.message || error) }));
  });
  if (managerReportsChanges) {
    for (const area of ["sync", "local"]) {
      GM_addValueChangeListener(area, (_name, _oldValue, value, remote) => {
        if (remote) answerPage("btr-userscript-storage-change", { area, value: typeof value === "string" ? value : "{}" });
      });
    }
  }
}
if (manager) serveStorage();

function injected() {
  return document.documentElement?.hasAttribute(LOADED) === true;
}

function inject() {
  const source = `(${pageCode})();`;
  // Prefer the manager's own injection, which also works on pages with a strict CSP.
  if (typeof GM_addElement === "function") {
    try { GM_addElement(document.documentElement, "script", { textContent: source })?.remove?.(); }
    catch (_error) {}
  }
  if (injected()) return;
  const script = document.createElement("script");
  script.textContent = source;
  document.documentElement.append(script);
  script.remove();
  if (!injected()) console.error("BTR: 无法在页面里启动线程撕裂者");
}

// The page code reads this mark once, when it starts, to know whether its settings go
// through the manager ("live": the manager also reports other tabs' changes).
function start() {
  if (manager) document.documentElement.setAttribute(STORAGE_MARK, managerReportsChanges ? "manager live" : "manager");
  if (pageWindow === window) pageCode();
  else inject();
}

if (document.documentElement) start();
else {
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return;
    observer.disconnect();
    start();
  });
  observer.observe(document, { childList: true });
}

// The script now runs in live-site iframes too; the manager menu entry stays one per tab.
let topLevelFrame = true;
try { topLevelFrame = window.self === window.top; } catch (_error) {}
if (typeof GM_registerMenuCommand === "function" && topLevelFrame) {
  GM_registerMenuCommand("线程撕裂者设置", () => document.dispatchEvent(new CustomEvent("btr-userscript-open-settings")));
}
