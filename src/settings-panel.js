// The settings panel. It runs in the bilibili page and opens from the button in the page's
// corner, the userscript manager's menu, or "自定义" in the player's gear menu. Settings are
// read and saved through bridge.js; storage-shim.js keeps them in the script manager's
// storage.
(function installSettingsPanel(root) {
  "use strict";

  if (root.__BTR_SETTINGS_PANEL__) return;
  const core = root.__BILI_RANGE_CORE__;
  const cdn = root.__BILI_CDN_RESOLVER_FACTORY__;
  if (!core || !cdn) return;

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const HOST_ID = "__bilibili_thread_ripper_settings__";
  const DIALOG_ID = "__bilibili_thread_ripper_settings_dialog__";
  const LAUNCHER_ID = "__bilibili_thread_ripper_launcher__";
  const THREAD_OPTIONS = [4, 8, 16, 32, 64, 128];
  const MAX_CUSTOM_HOSTS = 32;
  const HOST_GROUPS = [["大陆节点", cdn.MAINLAND_HOSTS], ["海外节点", cdn.OVERSEAS_HOSTS]];
  const PROJECT_URL = "https://github.com/MrTangLuyao/Bilibili-thread-ripper";
  // GitHub's mark.
  const GITHUB_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>`;
  // The theme button shows the choice in use: a sun for 浅色, a moon for 深色, and for 自动 a
  // half sun, half moon with a small A in the corner.
  const THEME_ICONS = `<svg class="icon-light" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"></path></svg>`
    + `<svg class="icon-dark" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20.5 13.8A8.5 8.5 0 1 1 10.2 3.5a6.6 6.6 0 0 0 10.3 10.3z"></path></svg>`
    + `<svg class="icon-auto" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="4"></circle><path d="M10 6a4 4 0 0 1 0 8z" fill="currentColor" stroke="none"></path><path d="M10 1.7v1.8M10 16.5v1.8M1.7 10h1.8M16.5 10h1.8M4.1 4.1l1.3 1.3M15.9 4.1l-1.3 1.3M4.1 15.9l1.3-1.3"></path><path d="M14.6 22.8l4.1-9 4.1 9M16 19.6h5.4"></path></svg>`;
  const THEME_LABELS = { auto: "自动（跟随系统）", light: "浅色", dark: "深色" };
  const KNOWN_HOSTS = HOST_GROUPS.flatMap(([, hosts]) => hosts);

  const PANEL_HTML = `
    <main>
      <header>
        <div class="logo" aria-hidden="true">B</div>
        <div class="title">
          <h1>线程撕裂者</h1>
          <a id="github-link" class="github-link" href="${PROJECT_URL}" target="_blank" rel="noopener noreferrer" title="在 GitHub 上查看项目" aria-label="在 GitHub 上查看项目">${GITHUB_ICON}</a>
          <button id="theme" class="theme-toggle" type="button" data-value="auto">${THEME_ICONS}</button>
        </div>
        <label class="switch" title="启用或停用">
          <input id="enabled" type="checkbox">
          <span></span>
        </label>
      </header>

      <section class="mode-select" aria-label="CDN 模式">
        <label><input type="radio" name="mode" value="mainland"><span>大陆</span></label>
        <label><input type="radio" name="mode" value="overseas"><span>海外</span></label>
        <label><input type="radio" name="mode" value="custom"><span>自定义</span></label>
      </section>

      <section id="custom-hosts" class="custom-hosts" aria-label="自定义服务器" hidden>
        <div class="custom-head"><span>自定义服务器</span><b id="custom-count">0</b></div>
        <p id="custom-empty" class="custom-note">还没选服务器，暂时按大陆 CDN 下载。</p>
        <div id="known-hosts"></div>
        <fieldset class="host-group">
          <legend>手动添加</legend>
          <div id="manual-hosts" class="manual-hosts"></div>
          <form id="host-form" class="host-form">
            <input id="host-input" type="text" placeholder="例如 upos-sz-mirrorali.bilivideo.com" spellcheck="false" autocomplete="off" aria-label="服务器地址">
            <button type="submit">添加</button>
          </form>
          <p id="host-error" class="host-error" role="alert"></p>
        </fieldset>
        <p class="custom-note">只能填 B 站的视频服务器（bilivideo.com、akamaized.net 等），视频的下载地址不会发给别的网站。</p>
      </section>

      <section class="takeover-select" aria-label="接管方式">
        <label><input type="radio" name="takeover" value="full"><span>全接管</span></label>
        <label><input type="radio" name="takeover" value="compat"><span>兼容模式</span></label>
      </section>
      <p class="takeover-note">Safari 用户建议使用兼容模式。<br>全接管：视频由插件自己来放，下载和缓冲都由插件安排，速度最快。<br>兼容模式：当遇到播放问题或设置不生效时，尝试使用兼容模式。</p>

      <section class="controls">
        <div class="control-title">
          <label for="concurrency">线程加载数</label>
          <output id="thread-value" for="concurrency">8</output>
        </div>
        <div class="auto-row">
          <label for="auto-concurrency">自动线程数（推荐）<small>BTR将智能选择需要的线程数。</small></label>
          <label class="switch"><input id="auto-concurrency" type="checkbox" aria-label="自动线程数"><span></span></label>
        </div>
        <div class="slider">
          <div id="slider-fill" class="slider-fill" aria-hidden="true"></div>
          <input id="concurrency" type="range" min="0" max="5" step="1" value="1" aria-label="线程加载数" aria-valuetext="8">
        </div>
        <div class="scale" aria-hidden="true">
          <span>4</span><span>8</span><span>16</span><span>32</span><span>64</span><span>128</span>
        </div>
      </section>

      <section class="notice-controls" aria-label="提示设置">
        <div class="notice-row"><label for="live-enabled">直播加速（实验性）</label><label class="switch"><input id="live-enabled" type="checkbox" aria-label="直播加速（实验性）"><span></span></label></div>
        <div class="notice-row"><label for="error-notices">显示错误</label><label class="switch"><input id="error-notices" type="checkbox" aria-label="显示错误"><span></span></label></div>
        <div class="notice-row"><label for="debug-notices">Debug 模式</label><label class="switch"><input id="debug-notices" type="checkbox" aria-label="Debug 模式"><span></span></label></div>
        <div class="notice-row"><label for="floating-button">悬浮按钮</label><label class="switch"><input id="floating-button" type="checkbox" aria-label="悬浮按钮"><span></span></label></div>
        <fieldset id="debug-filters" class="debug-filters" hidden>
          <legend>显示哪些 Debug 消息</legend>
          <div class="debug-filter-actions"><button id="debug-select-all" type="button">全选</button><button id="debug-select-none" type="button">全不选</button></div>
          <div class="debug-filter-options">
            <label><input type="checkbox" data-debug-category="takeover">接管与切换</label>
            <label><input type="checkbox" data-debug-category="playback">播放与暂停</label>
            <label><input type="checkbox" data-debug-category="download">下载线程</label>
            <label><input type="checkbox" data-debug-category="buffer">缓冲与跳转</label>
            <label><input type="checkbox" data-debug-category="settings">设置变化</label>
            <label><input type="checkbox" data-debug-category="other">其他日志</label>
          </div>
          <div class="debug-copy">
            <button id="debug-copy" type="button">复制诊断信息</button>
            <span id="debug-copy-status" class="debug-copy-status" role="status"></span>
          </div>
          <p class="debug-copy-note">反馈问题时点一下，把复制下来的内容贴到 issue 里。里面没有 Cookie、账号信息和视频的下载地址。</p>
          <textarea id="debug-copy-text" class="debug-copy-text" readonly hidden aria-label="诊断信息"></textarea>
        </fieldset>
      </section>

      <section class="current-threads" aria-live="polite">
        <span>目前总线程</span>
        <b id="active-count">0</b>
      </section>
    </main>`;

  const PANEL_CSS = `
    .btr-popup {
      --scheme: dark; --bg: #17191f; --surface: #20232a; --hover: #292d35;
      --border: #30343d; --divider: #343943; --control-border: #444b57;
      --text: #f5f7fb; --label: #c9ced9; --button-text: #d9dee8;
      --muted: #949baa; --subtle: #8a93a6; --switch: #313a4c; --track: #3a3e47;
      --error: #f28b85; --success: #9fd9a8; --focus: #fff;
    }
    .btr-popup[data-theme="light"] {
      --scheme: light; --bg: #fff; --surface: #f4f5f8; --hover: #e8ebf0;
      --border: #d6dae2; --divider: #d6dae2; --control-border: #aeb6c4;
      --text: #202532; --label: #363f50; --button-text: #363f50;
      --muted: #596579; --subtle: #596579; --switch: #758197; --track: #d6dae2;
      --error: #b42318; --success: #227536; --focus: #244e9b;
    }
    * { box-sizing: border-box; }
    .btr-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); }
    .btr-popup { position: fixed; top: 72px; right: 24px; width: 320px; max-width: calc(100vw - 32px); max-height: calc(100vh - 96px); overflow: auto; border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, .45); color-scheme: var(--scheme); font-family: Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; background: var(--bg); color: var(--text); font-size: 14px; line-height: normal; text-align: left; user-select: none; -webkit-user-select: none; }
    input, textarea { user-select: text; -webkit-user-select: text; }
    main { padding: 18px 16px; }
    header { display: grid; grid-template-columns: 42px 1fr auto; align-items: center; gap: 11px; margin-bottom: 22px; }
    .logo { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 8px; color: #fff; font-size: 23px; font-weight: 800; background: #fb7299; }
    h1 { margin: 0; font-size: 17px; letter-spacing: .2px; }
    .title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .github-link, .theme-toggle { display: grid; flex: none; place-items: center; width: 26px; height: 26px; border-radius: 6px; color: var(--muted); transition: color 160ms ease, background 160ms ease; }
    .github-link:hover, .theme-toggle:hover { color: var(--text); background: var(--hover); }
    .github-link:focus-visible, .theme-toggle:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .github-link svg, .theme-toggle svg { width: 18px; height: 18px; }
    .theme-toggle { margin-left: -6px; padding: 0; border: 0; background: transparent; cursor: pointer; }
    .theme-toggle svg { display: none; }
    .theme-toggle[data-value="auto"] .icon-auto, .theme-toggle[data-value="light"] .icon-light, .theme-toggle[data-value="dark"] .icon-dark { display: block; }
    .switch { position: relative; width: 42px; height: 24px; }
    .switch input { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
    .switch span { position: absolute; inset: 0; border-radius: 999px; background: var(--switch); cursor: pointer; transition: 160ms ease; }
    .switch span::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: 160ms ease; }
    .switch input:checked + span { background: #fb7299; }
    .switch input:checked + span::after { transform: translateX(18px); }
    .switch input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: 3px; }
    .mode-select { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; margin-bottom: 12px; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--border); }
    .mode-select label { position: relative; }
    .mode-select input { position: absolute; opacity: 0; }
    .mode-select span { display: block; padding: 10px 6px; color: var(--muted); background: var(--surface); font-size: 12px; text-align: center; cursor: pointer; }
    .mode-select input:checked + span { color: #fff; background: #fb7299; }
    .mode-select input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: -3px; }
    .takeover-select { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; margin-bottom: 8px; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--border); }
    .takeover-select label { position: relative; }
    .takeover-select input { position: absolute; opacity: 0; }
    .takeover-select span { display: block; padding: 10px 6px; color: var(--muted); background: var(--surface); font-size: 12px; text-align: center; cursor: pointer; }
    .takeover-select input:checked + span { color: #fff; background: #fb7299; }
    .takeover-select input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: -3px; }
    .takeover-note { margin: 0 0 12px; padding: 0 2px; color: var(--subtle); font-size: 11px; line-height: 1.6; }
    .custom-hosts { margin-bottom: 12px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    .custom-hosts[hidden] { display: none; }
    .custom-head { display: flex; align-items: center; justify-content: space-between; color: var(--label); font-size: 13px; }
    .custom-head b { min-width: 28px; padding: 2px 8px; border-radius: 5px; background: #fb7299; color: #fff; font-size: 12px; text-align: center; }
    .custom-note { margin: 8px 0 0; color: var(--subtle); font-size: 11px; line-height: 1.6; }
    .custom-note[hidden] { display: none; }
    .host-group { min-width: 0; margin: 12px 0 0; padding: 10px 0 0; border: 0; border-top: 1px solid var(--divider); }
    .host-group legend { padding: 0 0 4px; color: var(--label); font-size: 12px; }
    .host-option { display: flex; align-items: center; gap: 7px; margin-top: 7px; color: var(--label); font-size: 11px; overflow-wrap: anywhere; cursor: pointer; }
    .host-option input { flex: none; width: 14px; height: 14px; margin: 0; accent-color: #fb7299; cursor: pointer; }
    .manual-host { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 7px; color: var(--label); font-size: 11px; overflow-wrap: anywhere; }
    .manual-host button { flex: none; width: 22px; height: 22px; padding: 0; border: 1px solid var(--control-border); border-radius: 4px; background: var(--hover); color: var(--button-text); font: inherit; line-height: 20px; cursor: pointer; }
    .host-form { display: flex; gap: 6px; margin-top: 10px; }
    .host-form input { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid var(--control-border); border-radius: 5px; background: var(--bg); color: var(--text); font: inherit; font-size: 12px; }
    .host-form button { flex: none; padding: 6px 10px; border: 0; border-radius: 5px; background: #fb7299; color: #fff; font: inherit; font-size: 12px; cursor: pointer; }
    .host-error { min-height: 0; margin: 6px 0 0; color: var(--error); font-size: 11px; }
    .host-error:empty { display: none; }
    .host-form input:focus-visible, .host-form button:focus-visible, .manual-host button:focus-visible, .host-option input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .controls { padding: 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    .control-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    .control-title label { color: var(--label); font-size: 13px; }
    .auto-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .auto-row > label:first-child { display: flex; flex-direction: column; gap: 2px; color: var(--label); font-size: 13px; }
    .auto-row small { color: var(--subtle); font-size: 11px; }
    .controls.auto .slider, .controls.auto .scale { opacity: 0.4; pointer-events: none; }
    output { min-width: 42px; padding: 4px 8px; border-radius: 5px; color: #fff; background: #fb7299; font-size: 13px; font-weight: 700; text-align: center; }
    .slider { position: relative; width: 100%; height: 18px; border-radius: 9px; background: var(--track); }
    .slider-fill { position: absolute; top: 0; bottom: 0; left: 0; width: 60%; border-radius: 9px; background: #fb7299; pointer-events: none; }
    input[type="range"] { position: absolute; inset: 0; width: 100%; height: 18px; margin: 0; appearance: none; -webkit-appearance: none; border: 0; outline: 0; background: transparent; cursor: pointer; }
    input[type="range"]::-webkit-slider-runnable-track { height: 18px; background: transparent; }
    input[type="range"]::-webkit-slider-thumb { width: 24px; height: 24px; margin-top: -3px; appearance: none; -webkit-appearance: none; border: 2px solid #fff; border-radius: 50%; background: #fff; }
    input[type="range"]:focus-visible::-webkit-slider-thumb { border-color: #fb7299; }
    .scale { display: flex; justify-content: space-between; margin-top: 5px; color: var(--subtle); font-size: 10px; }
    .scale span { width: 24px; text-align: center; }
    .scale span:first-child { text-align: left; }
    .scale span:last-child { text-align: right; }
    .notice-controls { margin-top: 12px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    .notice-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--label); font-size: 13px; }
    .notice-row .switch { flex: none; }
    .notice-row + .notice-row { margin-top: 14px; }
    .debug-filters { min-width: 0; margin: 16px 0 0; padding: 12px 0 0; border: 0; border-top: 1px solid var(--divider); }
    .debug-filters[hidden] { display: none; }
    .debug-filters legend { padding: 0 0 4px; color: var(--label); font-size: 12px; }
    .debug-filter-actions { display: flex; gap: 8px; margin-bottom: 12px; }
    .debug-filter-actions button { padding: 4px 8px; border: 1px solid var(--control-border); border-radius: 4px; background: var(--hover); color: var(--button-text); font: inherit; font-size: 11px; cursor: pointer; }
    .debug-filter-actions button:hover, .manual-host button:hover { border-color: #fb7299; }
    .debug-filter-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 8px; }
    .debug-filter-options label { display: flex; align-items: center; gap: 7px; color: var(--label); font-size: 12px; cursor: pointer; }
    .debug-filter-options input { flex: none; width: 15px; height: 15px; margin: 0; accent-color: #fb7299; cursor: pointer; }
    .debug-filter-actions button:focus-visible, .debug-filter-options input:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
    .debug-copy { display: flex; align-items: center; gap: 10px; margin-top: 16px; }
    .debug-copy button { padding: 6px 12px; border: 1px solid #fb7299; border-radius: 6px; background: var(--hover); color: var(--text); font: inherit; font-size: 12px; cursor: pointer; }
    .debug-copy button:hover { background: #fb7299; }
    .debug-copy button:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
    .debug-copy-status { color: var(--success); font-size: 12px; }
    .debug-copy-status.failed { color: var(--error); }
    .debug-copy-note { margin: 8px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
    .debug-copy-text { width: 100%; height: 120px; margin-top: 8px; padding: 6px; border: 1px solid var(--control-border); border-radius: 6px; background: var(--surface); color: var(--button-text); font: 11px/1.4 Consolas, monospace; resize: vertical; }
    .debug-copy-text[hidden] { display: none; }
    .current-threads { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; padding: 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--label); font-size: 13px; }
    .current-threads b { color: var(--text); font-size: 20px; font-variant-numeric: tabular-nums; }
    .btr-close { position: sticky; bottom: 12px; display: block; width: calc(100% - 32px); margin: 0 16px 16px; padding: 8px; border: 1px solid var(--control-border); border-radius: 6px; background: var(--hover); color: var(--button-text); font: inherit; font-size: 13px; cursor: pointer; box-shadow: 0 -6px 12px var(--bg); }
    .btr-close:hover { border-color: #fb7299; }
    .btr-close:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  `;

  const LAUNCHER_CSS = `
    .btr-launcher { position: fixed; right: 76px; bottom: 116px; display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; background: #fb7299; color: #fff; font: 700 13px/1 Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; letter-spacing: .3px; cursor: grab; opacity: .6; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; box-shadow: 0 4px 14px rgba(0, 0, 0, .25); transition: opacity 160ms ease, transform 160ms ease, left 180ms ease, right 180ms ease; }
    .btr-launcher:hover, .btr-launcher:focus-visible { opacity: 1; transform: scale(1.06); }
    .btr-launcher:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .btr-launcher.dragging { cursor: grabbing; opacity: 1; transform: scale(1.1); transition: opacity 160ms ease, transform 160ms ease; }
    @media (max-width: 700px) { .btr-launcher { width: 40px; height: 40px; font-size: 12px; } }
  `;

  let current = null;
  // bridge.js sends the stored settings when they load or change, and the page its stats.
  let latestSettings = null;
  // The debug notices shown on this page, newest last, for the diagnostic copy.
  const noticeHistory = [];

  // Everything needed to look into a report, as text to paste into an issue. The page's own
  // reports already leave out download addresses and account data; any address that is left
  // is cut down to its host and path, so no signature or token goes along.
  function diagnostics() {
    const safely = (read) => { try { return read(); } catch (error) { return `读取失败：${String(error?.message || error)}`; } };
    const parse = (text) => { try { return JSON.parse(text); } catch (_error) { return text; } };
    const sections = [
      ["环境", {
        BTR: "__BTR_VERSION__",
        脚本管理器: document.documentElement?.getAttribute("data-btr-userscript-manager") || "未知",
        浏览器: navigator.userAgent,
        页面: `${location.origin}${location.pathname}`,
        时间: new Date().toISOString(),
        语言: navigator.language,
        窗口: `${root.innerWidth}x${root.innerHeight}`
      }],
      ["设置", latestSettings || "设置还没加载"]
    ];
    const video = root.__biliThreadRipperDebug;
    if (typeof video?.report === "function") sections.push(["视频接管", safely(() => parse(video.report()))]);
    const auto = root.__BILI_IDM_DOWNLOADER_FACTORY__?.autoConcurrency;
    if (typeof auto?.status === "function") sections.push(["自动线程数", safely(() => auto.status())]);
    // The live player often sits in a live.bilibili.com iframe, where its module runs.
    const liveModules = [root, ...[...document.querySelectorAll("iframe")].map((frame) => safely(() => frame.contentWindow))]
      .map((view) => safely(() => view?.__biliThreadRipperLiveDebug)).filter((api) => api && typeof api.getStats === "function");
    liveModules.forEach((api, index) => sections.push([liveModules.length > 1 ? `直播模块 ${index + 1}` : "直播模块", safely(() => ({ stats: api.getStats(), context: api.getContext?.() }))]));
    sections.push(["最近的 Debug 提示", noticeHistory.length
      ? noticeHistory.map((item) => `${new Date(item.at).toISOString().slice(11, 19)} [${item.level}/${item.category}] ${item.title}${item.count > 1 ? ` ×${item.count}` : ""}${item.detail ? ` — ${item.detail}` : ""}`).join("\n")
      : "（还没有。打开 Debug 模式以后显示过的提示才会记在这里）"]);
    const text = sections.map(([title, value]) => `## ${title}\n${typeof value === "string" ? value : JSON.stringify(value, null, 1)}`).join("\n\n");
    return text.replace(/(https?:\/\/[^\s"'?#]+)[?#][^\s"']*/gi, "$1");
  }
  let latestStats = null;
  const post = (type, payload) => root.postMessage({ channel: CHANNEL, type, payload }, "*");

  function open() {
    if (current) return;
    // A modal <dialog> sits in the browser's top layer and is the only interactive part of
    // the page while it is open. A plain fixed layer can end up under the page's own
    // top-layer elements, or inside a part of the page made inert, and then clicks on it
    // land on whatever is beneath (issue #8).
    const dialog = document.createElement("dialog");
    dialog.id = DIALOG_ID;
    dialog.style.cssText = "all:initial!important;display:block!important;position:fixed!important;inset:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;z-index:2147483646!important;";
    const dialogStyle = document.createElement("style");
    dialogStyle.textContent = `#${DIALOG_ID}::backdrop{background:transparent}`;
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;";
    dialog.append(dialogStyle, host);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    const backdrop = document.createElement("div");
    backdrop.className = "btr-backdrop";
    const panel = document.createElement("div");
    panel.className = "btr-popup";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "线程撕裂者设置");
    panel.tabIndex = -1;
    panel.innerHTML = PANEL_HTML;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "btr-close";
    closeButton.textContent = "关闭";
    panel.append(closeButton);
    shadow.append(style, backdrop, panel);

    const $ = (id) => shadow.getElementById(id);
    const enabled = $("enabled");
    const concurrency = $("concurrency");
    const autoConcurrency = $("auto-concurrency");
    const theme = $("theme");
    const systemTheme = root.matchMedia("(prefers-color-scheme: dark)");
    const systemColors = () => (systemTheme.matches ? "dark" : "light");
    const applyTheme = () => {
      panel.dataset.theme = theme.dataset.value === "auto" ? systemColors() : theme.dataset.value;
    };
    const showTheme = (value) => {
      theme.dataset.value = value;
      theme.title = `面板主题：${THEME_LABELS[value]}。点击切换`;
      theme.setAttribute("aria-label", theme.title);
      applyTheme();
    };
    systemTheme.addEventListener("change", applyTheme);
    const threadValue = $("thread-value");
    const sliderFill = $("slider-fill");
    const errorNotices = $("error-notices");
    const debugNotices = $("debug-notices");
    const liveEnabled = $("live-enabled");
    const floatingButton = $("floating-button");
    const debugFilters = $("debug-filters");
    const debugCategoryInputs = [...shadow.querySelectorAll("[data-debug-category]")];
    const customSection = $("custom-hosts");
    const hostInput = $("host-input");
    const hostError = $("host-error");
    const activeCount = $("active-count");
    let customHosts = [];

    const save = (update) => post("settings-update", update);

    function setSlider(threads) {
      const index = THREAD_OPTIONS.indexOf(Number(threads));
      const safe = index < 0 ? 1 : index;
      concurrency.value = String(safe);
      // In the automatic mode the badge says so; the slider keeps the viewer's own count.
      threadValue.value = autoConcurrency.checked ? "自动" : String(THREAD_OPTIONS[safe]);
      concurrency.setAttribute("aria-valuetext", String(THREAD_OPTIONS[safe]));
      sliderFill.style.width = `${safe / (THREAD_OPTIONS.length - 1) * 100}%`;
    }

    function setMode(mode) {
      for (const radio of shadow.querySelectorAll('input[name="mode"]')) radio.checked = radio.value === mode;
      customSection.hidden = mode !== "custom";
    }

    function renderHosts() {
      $("custom-count").textContent = String(customHosts.length);
      $("custom-empty").hidden = customHosts.length > 0;
      const known = $("known-hosts");
      known.replaceChildren(...HOST_GROUPS.map(([title, hosts]) => {
        const group = document.createElement("fieldset");
        group.className = "host-group";
        const legend = document.createElement("legend");
        legend.textContent = title;
        group.append(legend, ...hosts.map((value) => {
          const label = document.createElement("label");
          label.className = "host-option";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.value = value;
          input.checked = customHosts.includes(value);
          const text = document.createElement("span");
          text.textContent = value;
          label.append(input, text);
          return label;
        }));
        return group;
      }));
      $("manual-hosts").replaceChildren(...customHosts.filter((value) => !KNOWN_HOSTS.includes(value)).map((value) => {
        const row = document.createElement("div");
        row.className = "manual-host";
        const text = document.createElement("span");
        text.textContent = value;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.dataset.remove = value;
        remove.textContent = "×";
        remove.setAttribute("aria-label", `删除 ${value}`);
        row.append(text, remove);
        return row;
      }));
    }

    function setCustomHosts(next) {
      customHosts = next;
      renderHosts();
      save({ customHosts });
    }

    function render(settings) {
      showTheme(settings.theme);
      enabled.checked = settings.enabled;
      for (const radio of shadow.querySelectorAll('input[name="takeover"]')) radio.checked = radio.value === settings.takeover;
      autoConcurrency.checked = settings.autoConcurrency === true;
      setSlider(settings.concurrency);
      concurrency.disabled = autoConcurrency.checked;
      concurrency.closest(".controls").classList.toggle("auto", autoConcurrency.checked);
      setMode(settings.mode);
      customHosts = settings.customHosts;
      renderHosts();
      liveEnabled.checked = settings.liveEnabled !== false;
      floatingButton.checked = settings.floatingButton !== false;
      errorNotices.checked = settings.errorNotices;
      debugNotices.checked = settings.debugNotices;
      debugFilters.hidden = !settings.debugNotices;
      for (const input of debugCategoryInputs) input.checked = settings.debugCategories[input.dataset.debugCategory] !== false;
    }

    const saveDebugCategories = () => save({ debugCategories: Object.fromEntries(debugCategoryInputs.map((input) => [input.dataset.debugCategory, input.checked])) });
    enabled.addEventListener("change", () => save({ enabled: enabled.checked }));
    // Each click goes on to the next choice: from 自动 to the colors the system is not showing,
    // then to the ones it is (now kept by hand), then back to 自动.
    theme.addEventListener("click", () => {
      const system = systemColors();
      const other = system === "dark" ? "light" : "dark";
      const current = theme.dataset.value;
      const next = current === "auto" ? other : current === other ? system : "auto";
      showTheme(next);
      save({ theme: next });
    });
    liveEnabled.addEventListener("change", () => save({ liveEnabled: liveEnabled.checked }));
    floatingButton.addEventListener("change", () => save({ floatingButton: floatingButton.checked }));
    concurrency.addEventListener("input", () => {
      const threads = THREAD_OPTIONS[Number(concurrency.value)];
      setSlider(threads);
      save({ concurrency: threads });
    });
    autoConcurrency.addEventListener("change", () => save({ autoConcurrency: autoConcurrency.checked }));
    for (const radio of shadow.querySelectorAll('input[name="mode"]')) {
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        setMode(radio.value);
        save({ mode: radio.value });
      });
    }
    for (const radio of shadow.querySelectorAll('input[name="takeover"]')) {
      radio.addEventListener("change", () => { if (radio.checked) save({ takeover: radio.value }); });
    }
    $("known-hosts").addEventListener("change", (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || !KNOWN_HOSTS.includes(input.value)) return;
      if (input.checked && customHosts.length >= MAX_CUSTOM_HOSTS) {
        input.checked = false;
        hostError.textContent = `最多选 ${MAX_CUSTOM_HOSTS} 个服务器。`;
        return;
      }
      hostError.textContent = "";
      setCustomHosts(input.checked ? [...customHosts.filter((value) => value !== input.value), input.value] : customHosts.filter((value) => value !== input.value));
    });
    $("manual-hosts").addEventListener("click", (event) => {
      const value = event.target instanceof HTMLElement ? event.target.dataset.remove : "";
      if (value) setCustomHosts(customHosts.filter((item) => item !== value));
    });
    $("host-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const value = core.normalizeCdnHost(hostInput.value);
      if (!value) hostError.textContent = "这不是 B 站的视频服务器地址。";
      else if (customHosts.includes(value)) hostError.textContent = "这个服务器已经在列表里了。";
      else if (customHosts.length >= MAX_CUSTOM_HOSTS) hostError.textContent = `最多选 ${MAX_CUSTOM_HOSTS} 个服务器。`;
      else {
        hostError.textContent = "";
        hostInput.value = "";
        setCustomHosts([...customHosts, value]);
      }
    });
    errorNotices.addEventListener("change", () => save({ errorNotices: errorNotices.checked }));
    debugNotices.addEventListener("change", () => {
      debugFilters.hidden = !debugNotices.checked;
      save({ debugNotices: debugNotices.checked });
    });
    for (const input of debugCategoryInputs) input.addEventListener("change", saveDebugCategories);
    $("debug-select-all").addEventListener("click", () => { for (const input of debugCategoryInputs) input.checked = true; saveDebugCategories(); });
    $("debug-select-none").addEventListener("click", () => { for (const input of debugCategoryInputs) input.checked = false; saveDebugCategories(); });
    const copyStatus = $("debug-copy-status");
    const copyText = $("debug-copy-text");
    let copyStatusTimer = null;
    $("debug-copy").addEventListener("click", async () => {
      const text = diagnostics();
      let copied = false;
      try { await navigator.clipboard.writeText(text); copied = true; } catch (_error) {}
      if (!copied) {
        // Without the clipboard API (or its permission): select the text for the viewer.
        copyText.hidden = false;
        copyText.value = text;
        copyText.focus();
        copyText.select();
        try { copied = document.execCommand("copy"); } catch (_error) {}
      }
      copyStatus.classList.toggle("failed", !copied);
      copyStatus.textContent = copied ? "已复制" : "没能自动复制，请手动复制下面的内容";
      clearTimeout(copyStatusTimer);
      if (copied) copyStatusTimer = setTimeout(() => { copyStatus.textContent = ""; }, 2500);
    });

    // Keys typed into the panel belong to it. The shadow root hides the input from the page,
    // so the player's shortcuts (space, F, arrows) would otherwise react to them.
    const keepKeys = (event) => { if (event.key !== "Escape") event.stopPropagation(); };
    for (const type of ["keydown", "keyup", "keypress"]) panel.addEventListener(type, keepKeys);

    // The live thread count: asking for stats makes the page send fresh ones.
    const refresh = () => {
      activeCount.textContent = String(Math.max(0, Math.trunc(Number(latestStats?.activeThreads) || 0)));
      post("get-stats");
    };
    const timer = setInterval(refresh, 400);
    const onKey = (event) => { if (event.key === "Escape") close(); };
    const close = () => {
      if (current?.host !== host) return;
      current = null;
      clearInterval(timer);
      systemTheme.removeEventListener("change", applyTheme);
      launcher?.apply();
      document.removeEventListener("keydown", onKey, true);
      dialog.remove();
    };
    // Changes made elsewhere (the gear menu, another tab) arrive as new settings.
    current = { host, close, render };
    launcher?.apply();
    backdrop.addEventListener("click", close);
    closeButton.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
    // Esc on a modal dialog closes it natively; clean up the same way as the button.
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    (document.body || document.documentElement).append(dialog);
    try { dialog.showModal(); }
    catch (_error) { dialog.setAttribute("open", ""); }
    render(latestSettings || core.normalizeSettings({}));
    post("get-settings");
    refresh();
    panel.focus();
  }

  const toggle = () => (current ? current.close() : open());

  // The button in the corner of every bilibili page. The userscript manager's menu is not
  // obvious (and on the home page people do not find it at all), so the panel needs a way in
  // that is always visible.
  // It hides while the video is fullscreen and while the panel itself is open.
  const launcher = (() => {
    if (root.top !== root) return null;
    const MARGIN = 12;
    // How far a press has to travel before it counts as dragging rather than a click.
    const DRAG_SLOP = 4;
    // Let go this close to the left or right edge and it snaps flush to it; let go anywhere
    // else and it simply stays where it was put.
    const SNAP_MS = 72;
    let host = null;
    let button = null;
    let wanted = true;
    // Where the viewer left it, as shares of the window: 0 means stuck to the left edge, 1 to
    // the right edge, anything between is a free spot. null: never moved.
    let leftRatio = null;
    let topRatio = null;
    let dragging = null;

    // Bilibili fills the screen in two ways: the browser fullscreen API, and its own 网页全屏,
    // which only resizes the player inside the page. Rather than follow Bilibili class names,
    // this asks the picture itself: a video that covers the window is a video being watched
    // full screen, whichever way it got there.
    const fullscreen = () => {
      if (document.fullscreenElement || document.webkitFullscreenElement || document.webkitIsFullScreen) return true;
      const width = root.innerWidth, height = root.innerHeight;
      if (!width || !height) return false;
      for (const video of document.querySelectorAll("video")) {
        const box = video.getBoundingClientRect();
        if (box.width >= width * 0.92 && box.height >= height * 0.92) return true;
      }
      return false;
    };

    const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

    // Puts it back where it was left. Without a saved spot it sits where it always did: to the
    // left of Bilibili's own column of round buttons, near the bottom.
    function place() {
      if (!button) return;
      const size = button.offsetHeight || 44;
      const width = root.innerWidth || 0, height = root.innerHeight || 0;
      if (leftRatio === null || topRatio === null) {
        button.style.top = `${Math.round(Math.max(MARGIN, height - size - 116))}px`;
        button.style.right = "76px";
        button.style.left = "auto";
        button.style.bottom = "auto";
        return;
      }
      button.style.top = `${Math.round(clamp(topRatio * height, MARGIN, Math.max(MARGIN, height - size - MARGIN)))}px`;
      button.style.bottom = "auto";
      if (leftRatio >= 1) {
        button.style.right = `${MARGIN}px`;
        button.style.left = "auto";
        return;
      }
      button.style.left = `${Math.round(clamp(leftRatio * width, MARGIN, Math.max(MARGIN, width - size - MARGIN)))}px`;
      button.style.right = "auto";
    }

    function startDrag(event) {
      if (event.button !== undefined && event.button !== 0) return;
      const box = button.getBoundingClientRect();
      dragging = {
        pointerId: event.pointerId,
        grabX: event.clientX - box.left,
        grabY: event.clientY - box.top,
        fromX: event.clientX,
        fromY: event.clientY,
        moved: false
      };
      try { button.setPointerCapture(event.pointerId); } catch (_error) {}
    }

    function moveDrag(event) {
      if (!dragging || event.pointerId !== dragging.pointerId) return;
      if (!dragging.moved && Math.hypot(event.clientX - dragging.fromX, event.clientY - dragging.fromY) < DRAG_SLOP) return;
      dragging.moved = true;
      button.classList.add("dragging");
      const size = button.offsetHeight || 44;
      const width = root.innerWidth, height = root.innerHeight;
      // Kept as numbers: where it lands is decided from these, not from a fresh layout
      // read, which the browser is free to postpone until the pointer is already up.
      dragging.left = Math.round(clamp(event.clientX - dragging.grabX, MARGIN, width - size - MARGIN));
      dragging.top = Math.round(clamp(event.clientY - dragging.grabY, MARGIN, height - size - MARGIN));
      dragging.size = size;
      button.style.left = `${dragging.left}px`;
      button.style.top = `${dragging.top}px`;
      button.style.right = "auto";
      event.preventDefault();
    }

    function endDrag(event) {
      if (!dragging || event.pointerId !== dragging.pointerId) return;
      const { moved, left = 0, top = 0, size = 44 } = dragging;
      try { button.releasePointerCapture(dragging.pointerId); } catch (_error) {}
      dragging = null;
      button.classList.remove("dragging");
      if (!moved) return;
      // Dropped within reach of the left or right edge: snap flush to it, and remember the
      // edge rather than the pixel, so it stays there whatever the window size. Dropped
      // anywhere else: it stays exactly where it was put.
      const width = root.innerWidth || 1;
      if (left <= SNAP_MS) leftRatio = 0;
      else if (left + size >= width - SNAP_MS) leftRatio = 1;
      else leftRatio = clamp(left / width, 0, 1);
      topRatio = clamp(top / (root.innerHeight || 1), 0, 1);
      place();
      post("settings-update", { floatingButtonLeft: leftRatio, floatingButtonTop: topRatio });
    }

    function mount() {
      if (host?.isConnected) return;
      host = document.createElement("div");
      host.id = LAUNCHER_ID;
      host.style.cssText = "all:initial!important;position:fixed!important;right:0!important;bottom:0!important;width:0!important;height:0!important;z-index:2147483645!important;";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = LAUNCHER_CSS;
      button = document.createElement("button");
      button.type = "button";
      button.className = "btr-launcher";
      button.title = "线程撕裂者设置（可以拖动）";
      button.setAttribute("aria-label", "线程撕裂者设置");
      button.textContent = "BTR";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // A drag that ended on the button itself must not also open the panel.
        if (button.dataset.dragged === "true") {
          button.dataset.dragged = "";
          return;
        }
        toggle();
      });
      button.addEventListener("pointerdown", startDrag);
      button.addEventListener("pointermove", moveDrag);
      for (const type of ["pointerup", "pointercancel"]) {
        button.addEventListener(type, (event) => {
          const moved = Boolean(dragging?.moved);
          endDrag(event);
          if (moved) button.dataset.dragged = "true";
        });
      }
      shadow.append(style, button);
      (document.body || document.documentElement).append(host);
      place();
    }

    function apply() {
      const show = wanted && !fullscreen() && !current;
      if (!show) {
        host?.remove();
        return;
      }
      mount();
      // Bilibili replaces large parts of the page when you navigate; put it back if it went.
      if (!host.isConnected) (document.body || document.documentElement).append(host);
      if (!dragging) place();
    }

    const update = (settings) => {
      wanted = settings?.floatingButton !== false;
      // null (never dragged) must stay null: Number(null) is 0, which would pin it to a corner.
      const ratio = (value) => (value != null && Number(value) >= 0 && Number(value) <= 1 ? Number(value) : null);
      leftRatio = ratio(settings?.floatingButtonLeft);
      topRatio = ratio(settings?.floatingButtonTop);
      apply();
    };
    for (const type of ["fullscreenchange", "webkitfullscreenchange"]) document.addEventListener(type, apply, true);
    root.addEventListener("resize", apply);
    // A page that swaps its body (the SPA navigations) drops the button with it.
    setInterval(apply, 2000);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
    // The button is on by default, so it is there before the stored settings arrive.
    apply();
    return { update, apply };
  })();

  root.addEventListener("message", (event) => {
    if (event.source !== root || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "settings") {
      latestSettings = core.normalizeSettings(event.data.payload);
      launcher?.update(latestSettings);
      current?.render(latestSettings);
    } else if (event.data.type === "stats") {
      latestStats = event.data.payload;
    } else if (event.data.type === "debug-notices") {
      for (const item of [].concat(event.data.payload || [])) {
        noticeHistory.push({ at: Number(item?.at) || Date.now(), level: String(item?.level || "info"), category: String(item?.category || "other"), title: String(item?.title || ""), detail: String(item?.detail || ""), count: Number(item?.count) || 1 });
        if (noticeHistory.length > 100) noticeHistory.shift();
      }
    } else if (event.data.type === "open-settings" && root.top === root) {
      // "自定义" in the gear menu.
      open();
    }
  });
  // The userscript manager's menu entry.
  document.addEventListener("btr-userscript-open-settings", () => { if (root.top === root) toggle(); });

  root.__BTR_SETTINGS_PANEL__ = Object.freeze({ open, close: () => current?.close(), toggle, isOpen: () => Boolean(current) });
})(globalThis);
