// This small stand-in keeps the parts of the chrome.* API that bridge.js uses: storage,
// and runtime.lastError for its callbacks.
//
// The settings live in the script manager's storage, which every bilibili subdomain shares.
// Only the manager's side of the script (loader.js) can reach it, so this page code asks it
// with events. loader.js marks the page when it answers them; without that mark, or when it
// does not answer, the settings stay in this site's localStorage as before, which is kept per
// subdomain. Changes made in another tab arrive from the manager, or, where the manager does
// not report them, are read again when this tab comes back into view.
const chrome = (() => {
  const PREFIX = "BTR_Userscript.";
  const AREAS = ["sync", "local"];
  const mark = document.documentElement?.getAttribute("data-btr-userscript-storage") || "";
  const listeners = new Set();
  const parse = (text) => {
    try {
      const value = typeof text === "string" ? JSON.parse(text || "{}") : text;
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (_error) {
      return {};
    }
  };
  const diff = (before, after) => {
    const changes = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = { oldValue: before[key], newValue: after[key] };
    }
    return changes;
  };
  const notify = (changes, area) => {
    if (!Object.keys(changes).length) return;
    for (const listener of listeners) {
      try { listener(changes, area); }
      catch (error) { console.error("BTR settings listener", error); }
    }
  };

  // This site's localStorage: the fallback, and what every version before 2026 used.
  const localBackend = {
    load: (area) => {
      try { return Promise.resolve(parse(localStorage.getItem(PREFIX + area))); }
      catch (_error) { return Promise.resolve({}); }
    },
    change: (area, op, value) => {
      let next = {};
      try { next = parse(localStorage.getItem(PREFIX + area)); } catch (_error) {}
      if (op === "set") Object.assign(next, value);
      else for (const key of value) delete next[key];
      try { localStorage.setItem(PREFIX + area, JSON.stringify(next)); }
      catch (error) { return Promise.reject(error); }
      return Promise.resolve(next);
    }
  };

  // The manager's storage, through loader.js. Requests and answers are JSON text: objects
  // would not cross Firefox's boundary between the page and the manager's sandbox.
  let requestCount = 0;
  const pending = new Map();
  const managerBackend = {
    request(message) {
      return new Promise((resolve, reject) => {
        const id = String(++requestCount);
        pending.set(id, { resolve, reject });
        document.dispatchEvent(new CustomEvent("btr-userscript-storage-request", { detail: JSON.stringify({ ...message, id }) }));
      });
    },
    load(area) { return this.request({ op: "get", area }); },
    change(area, op, value) { return this.request(op === "set" ? { op, area, items: value } : { op, area, keys: value }); }
  };
  document.addEventListener("btr-userscript-storage-reply", (event) => {
    let reply = null;
    try { reply = JSON.parse(event.detail); } catch (_error) { return; }
    const entry = pending.get(String(reply?.id));
    if (!entry) return;
    pending.delete(String(reply.id));
    if (reply.error) entry.reject(new Error(reply.error));
    else entry.resolve(parse(reply.value));
  });

  const cache = {};
  const loads = {};
  let backend = mark ? managerBackend : localBackend;
  // A manager that marked the page but never answers must not keep the settings from loading.
  const load = (area) => {
    loads[area] ||= (backend === managerBackend
      ? Promise.race([backend.load(area), new Promise((_resolve, reject) => setTimeout(() => reject(new Error("no answer")), 3000))])
        .catch(() => { backend = localBackend; return backend.load(area); })
      : backend.load(area)).then((value) => { cache[area] = value; return value; });
    return loads[area];
  };
  // What the storage now holds after a change, from this tab or from another one.
  const settle = (area, value) => {
    const before = cache[area] || {};
    cache[area] = value;
    notify(diff(before, value), area);
  };

  const runtime = { lastError: null };
  // Callers either pass a callback and read runtime.lastError, or await the promise.
  const finish = (promise, callback) => {
    const done = promise.then((value) => [value, null], (error) => [undefined, error]);
    if (typeof callback !== "function") return done.then(([value, error]) => (error ? Promise.reject(error) : value));
    return done.then(([value, error]) => {
      runtime.lastError = error ? { message: String(error.message || error) } : null;
      try { callback(value); }
      finally { runtime.lastError = null; }
      return value;
    });
  };
  // The change shows at once in this tab; the storage's own answer, which may also carry
  // another tab's change, settles it.
  const change = (area, op, value) => load(area).then((stored) => {
    const next = { ...stored };
    if (op === "set") Object.assign(next, value);
    else for (const key of value) delete next[key];
    settle(area, next);
    return backend.change(area, op, value).then((result) => settle(area, result));
  });
  const storageArea = (area) => ({
    get(keys, callback) {
      return finish(load(area).then((stored) => {
        if (keys === null || keys === undefined) return { ...stored };
        if (typeof keys === "string") return keys in stored ? { [keys]: stored[keys] } : {};
        if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]]));
        return Object.fromEntries(Object.keys(keys).map((key) => [key, key in stored ? stored[key] : keys[key]]));
      }), callback);
    },
    set(items, callback) {
      return finish(change(area, "set", { ...items }), callback);
    },
    remove(keys, callback) {
      return finish(change(area, "remove", [].concat(keys)), callback);
    }
  });

  // Another tab changed something.
  addEventListener("storage", (event) => {
    if (backend !== localBackend || !event.key?.startsWith(PREFIX)) return;
    const area = event.key.slice(PREFIX.length);
    if (AREAS.includes(area) && cache[area]) settle(area, parse(event.newValue));
  });
  document.addEventListener("btr-userscript-storage-change", (event) => {
    let message = null;
    try { message = JSON.parse(event.detail); } catch (_error) { return; }
    if (backend === managerBackend && AREAS.includes(message?.area) && cache[message.area]) settle(message.area, parse(message.value));
  });
  // Managers that do not report other tabs' changes ("live" is missing from the mark): read
  // the storage again whenever this tab comes back.
  if (mark && !mark.split(" ").includes("live")) {
    const refresh = () => {
      if (document.visibilityState !== "visible" || backend !== managerBackend) return;
      for (const area of AREAS) if (cache[area]) backend.load(area).then((value) => settle(area, value), () => {});
    };
    addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
  }

  return Object.freeze({
    runtime,
    storage: Object.freeze({
      sync: storageArea("sync"),
      local: storageArea("local"),
      onChanged: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) }
    })
  });
})();
