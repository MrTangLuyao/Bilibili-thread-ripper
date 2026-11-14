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
  // The desktop app opens this same panel. It names what the client has no use for and adds
  // its own block (its src/panel-bridge.js); the userscript sets none of this.
  const hostApp = root.__BTR_PANEL_HOST__;

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  // Which script this is: the released one, or the Canary built from main.
  const SCRIPT_CHANNEL = "__BTR_CHANNEL__" === "canary" ? "canary" : "stable";
  const CHANNEL_NAMES = { stable: "正式版", canary: "Canary" };
  // Set by the other of the two scripts when both are switched on (see loader.js).
  const otherScript = () => document.documentElement?.getAttribute("data-btr-also-running") || "";
  const HOST_ID = "__bilibili_thread_ripper_settings__";
  const DIALOG_ID = "__bilibili_thread_ripper_settings_dialog__";
  const LAUNCHER_ID = "__bilibili_thread_ripper_launcher__";
  const GUIDE_ID = "__bilibili_thread_ripper_guide__";
  // The switches of 高级设置: the control's id, the setting it keeps, and whether that setting
  // is on until someone switches it off.
  const SWITCHES = [["auto-concurrency", "autoConcurrency", false], ["secondary-buffer", "secondaryBuffer", false],
    ["audio-acceleration", "audioAcceleration", true], ["episode-enabled", "episodeEnabled", true], ["live-enabled", "liveEnabled", false],
    ["block-international", "blockInternational", false], ["floating-button", "floatingButton", true]];
  // 自动清晰度的最高档; 0 is no limit.
  const QUALITY_NAMES = { 32: "480P", 64: "720P", 80: "1080P", 116: "1080P 60 帧", 120: "4K", 0: "不限" };
  // The sliders of 高级设置, by the setting each keeps: the control's id, its stops from left to
  // right, the default among them, and how a stop reads.
  const SLIDERS = {
    concurrency: { id: "concurrency", stops: [4, 8, 16, 32, 64, 128], usual: 8, text: String },
    bufferAheadSeconds: { id: "buffer-ahead", stops: [30, 45, 90, 180], usual: 45, text: (seconds) => `${seconds} 秒` },
    autoQualityMax: { id: "auto-quality-max", stops: [32, 64, 80, 116, 120, 0], usual: 0, text: (quality) => QUALITY_NAMES[quality] }
  };
  const MAX_CUSTOM_HOSTS = 32;
  const HOST_GROUPS = [["大陆节点", cdn.MAINLAND_HOSTS], ["海外节点", cdn.OVERSEAS_HOSTS]];
  const PROJECT_URL = "https://github.com/MrTangLuyao/Bilibili-thread-ripper";
  // GitHub's mark.
  const GITHUB_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>`;
  // The script's own icon, icons/icon-128.png (dev/userscript-test.js checks the two stay the same).
  const ICON_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAACXBIWXMAAAsTAAALEwEAmpwYAAAHzklEQVR4nO2d248VNRjA58HLuySi0UcV/xoDMZHoEw8Gjcil3WVFjUIUb1FcNhC23x7kohFwTbyh4opGAVHuKBBhXcALBCTrgnAWzp6208909pAYg7LrtNPOnO+XfG9sOPN9v2k7baeTJARBEARBEARBEARBEAThEuxceZtm8JDi0CM5DCguhiSD85KDVBywHUNykDYHWS6ynECP5r0P2lxVwj6cs2KKZDBPcdgbOtmlCyb2SC7m2hwmZQO7+u5UTCyXHC4HT2TJQzIxqjh0I+u9I4kdnA03Sg7zJYd66MRVLaS9mRgswbk9NycxMjZ/1TTF4fvQiap+iINjvO+eJCYUg/vprofiWgMmLinWNyOJgSbvmyUZqPB3RnuF5ELLBeLRoMWXDB4JnYh2D8nF3IDNvtChE9DuIcdrML3Q4jdY7S7J4WLoi6eAlgRQH+NwbyHFx8X9N9FoH+KTj8EB+xjuXQDJYVHwi6XAa3cH0Om1+HY2qjUzRUXgcXYFuABu9yaAnd4NfZEUcL2uYJm/hR2a28fYBbQttJcFpNaqXvALpIAJdAVijnMBaEkXyiTfbqfFtwMLyYWJ4MIo+IRaAIPzalOdCdDayUPJ5+XJgeZipjMB7Fal0BdEAZPNQbczAVr71agIvDw5kEx86kwAxeFE6AuigEnmQAw5E0ByMUIFgFJJKBkMuxOAiWboC6KAyQnAYcyZAJR8KKWAJEAERVAkQPhEtGskVesCCqfRRLwyhubcBTQnzqI5MITpZ/tQv7kV9dINwfNBAoTmz1E0ewdRrxlA9cQbwQtOLUBIGk1Mtx9G/dKm4IW/GtQFhCA1mO4ZRPX82yRA6ccAeWgqTD/ejaqjj1qAthSghfnxV1RPraUuoF0FsJhTw6ieXkdjgHYVwGJ+PYdqUbFPCjQIjAxz4DgJ0K4twFX0W19QC9DOAuCfo4V1BeG6gIU1TLfsRXNmBPF8fUJh/639G/u3lRYAEdP3dlZbgPSzvRMu/D/D/q0vAa7727tWo3pmPeqX30G9biumXxxE8/sFdI1dW1AdFRZgMnf+tVqCYALwa4de/n62GOQS/eq7JEBZBFA2OgDTT3YjGif1H58lrGoLUNougE/g2gb2ORHAfH+iugLEOgh0ktiFNTRnR/ILcPZ8hQXwFFEIwAHT93fm/i1Yb5AAZRVAv9KfXwClSYCyCqCeXJNfgKYiAUorwFNr3cwIeu4yaQwQcRdgTg+TAGVtAdIPvs39W9JdR0mAUgqw0M1jYNq/jQQoowCpi4kgY1A993aFxgD/Y+KndBNBHe6mgs3gae/FL1SAPFO/ZZgK1j1uF4P0us+rJUCeOz+qxaCu1aieXY/6FX/LwdnewAKWgkmAGDEG9YoPCyk+dQERkn6+v7DiFypAWQaBITHHTqHqrFVUgIKirJiTZ7P1g6LzRQJEgDl0MkjxSYDQ6BTTzbsKG/GTABFhBk9nC0ahu0zqAkIJcGoY9YavUHWGezWcBIgAc+4CaviEBHBldFkxdgfwM+upBWhXASxm5FLh5weFGwNEui08OPUrqLvfq74Asb4YEgVXxlC/uKnaAsT6bmAsGPtyaAHnBpEAEWP2/VRdAagLmAAGUa/8sJoCxDoInPDv71qNaslb2WyeXr8V022HnGwEvebpYR1VFMBT5CXv/69XfpQt67pEr9pMApRFAHV1c+i727N3+1xg9g+RAKUSgLdag3Vbsy1e+X+U9vZEQF2ARwGUHex+edBNN+BpvYAE8CyAsi+J1hu5BbAvm5AAJesC1NVWYMeR3L/LHP2NBCirALq2Jb8A/zH7SV1A7AIs3RDtWQE0BihAALXojWiPiyEBihDgSQfHxZAAE0t2lF3ACxvzCzDq58QwagHKMgj84yIJUNYWIP3mSLTnBVALUJaJoB1H4hYgls/H5yXWqeB009dxfz5ecjESuvixCaDXDGQfiXSBj49MSgbDzgRQDI6HLn5ll4PP+JkFVFwMORNAchgIXfyqbghJP/jWS64kE586E0Bx6GkrAbqK2RKGUvn8oGS3MwE0732wCgLERvrlQW+50gv6HnAmAM6rTZVcGBLAIfUr3nYC2VrZmiUuUUzsIQHcYZ8i/OVTfJe4RnIxlwRwQ7rjsNeuUjJ4zLkAOGfFFMnEKI0B8mGO/PKf7z7kL74YtbVKfGBHliRAzq1f9gnD492vOLyW+AJZ7x0hW4Eyk9rvA3i881t3/yXsXHlb4hPJxBMkwCRoNDHd+FUhN4hk0JH4BmfDjYrBAWoBroNBND+cLOS7AK3Yb2uTFEGD1e6SHC5SF/AvhR88lR0xX1R+JIf62PxV05IiUaxvhuRCFylB1NQb2bq+PWq+yJy0anBfEgLZIWa3rQCpyV7vtusE2Ru+Ac4EtDN+TQ4PJyFp8r5ZkoGqnACNZnaejz3dy/z8O5rDP2fFTvu3jx/sEOj837/f+ZLBI0kMKA7T7SNIyIS0U8jx8VeYZv/fGFvYe3eop4M2i/12EJ7ECC5efIPkMJ9aA/Bx119WDJbg4v6bktjBBXC7YuL10GsHVQhpc8hgmfcZPh+MLyDB44rBrhj2E5QlZJYr8Z3kYg6y2i1JFcCOVbdqLmbaBSXJYYvicMzuNo5ly7kKUWgmmq0d18daOem2ObK5Cl0vgiAIgiAIgiAIgiAIomL8Bc0CR4+jT4wjAAAAAElFTkSuQmCC";
  // The theme button shows the choice in use: a sun for 浅色, a moon for 深色, and for 自动 a
  // half sun, half moon with a small A in the corner.
  const THEME_ICONS = `<svg class="icon-light" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"></path></svg>`
    + `<svg class="icon-dark" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20.5 13.8A8.5 8.5 0 1 1 10.2 3.5a6.6 6.6 0 0 0 10.3 10.3z"></path></svg>`
    + `<svg class="icon-auto" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="4"></circle><path d="M10 6a4 4 0 0 1 0 8z" fill="currentColor" stroke="none"></path><path d="M10 1.7v1.8M10 16.5v1.8M1.7 10h1.8M16.5 10h1.8M4.1 4.1l1.3 1.3M15.9 4.1l-1.3 1.3M4.1 15.9l1.3-1.3"></path><path d="M14.6 22.8l4.1-9 4.1 9M16 19.6h5.4"></path></svg>`;
  const THEME_LABELS = { auto: "自动（跟随系统）", light: "浅色", dark: "深色" };
  const CHEVRON_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>`;
  // The question mark beside a setting's name; the setting's explanation is a bubble over it.
  const HELP_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.8 2.1c-.9.6-1.4 1.1-1.4 2.1"/><path d="M12 16.7v.1"/></svg>`;
  const KNOWN_HOSTS = HOST_GROUPS.flatMap(([, hosts]) => hosts);

  // The ripple on everything that can be pressed, the same one as on louie1.com: a circle that
  // grows from where the press landed and fades out. A timer removes each circle after its run,
  // not only animationend: an animation does not run while its element is hidden (a page or
  // tab of the panel not shown, the floating button taken off the page while the panel is
  // open), so animationend would never come, and the leftover circle would play again as
  // soon as the element showed up.
  const RIPPLE_MS = 600;
  const RIPPLE_CSS = `
    .btr-ripple-host { overflow: hidden; }
    .btr-ripple { position: absolute; display: block; border-radius: 50%; transform: scale(0); background: var(--ripple, rgba(255, 255, 255, .15)); pointer-events: none; animation: btr-ripple ${RIPPLE_MS}ms linear forwards; }
    @keyframes btr-ripple { to { transform: scale(4); opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .btr-ripple { display: none; } }
  `;

  function ripple(surface, event) {
    if (!surface) return;
    if (root.getComputedStyle(surface).position === "static") surface.style.position = "relative";
    surface.classList.add("btr-ripple-host");
    clearRipples(surface);
    const box = surface.getBoundingClientRect();
    const size = Math.max(surface.clientWidth, surface.clientHeight);
    // Its own element rather than a span, which the panel's span rules (the switches, the
    // choices) would restyle.
    const circle = document.createElement("btr-ripple");
    circle.className = "btr-ripple";
    circle.style.width = circle.style.height = `${size}px`;
    circle.style.left = `${event.clientX - box.left - size / 2}px`;
    circle.style.top = `${event.clientY - box.top - size / 2}px`;
    surface.append(circle);
    const timer = setTimeout(() => circle.remove(), RIPPLE_MS + 50);
    circle.addEventListener("animationend", () => {
      clearTimeout(timer);
      circle.remove();
    }, { once: true });
  }

  function clearRipples(scope) {
    for (const circle of scope?.querySelectorAll(".btr-ripple") || []) circle.remove();
  }

  // 运行状态's speed: KB/s, MB/s from one megabyte a second up.
  function formatSpeed(bps) {
    const value = Math.max(0, Number(bps) || 0);
    if (value >= 1048576) return `${(value / 1048576).toFixed(value >= 10 * 1048576 ? 0 : 1)} MB/s`;
    return `${Math.round(value / 1024)} KB/s`;
  }

  // One row of a settings list: a name (the label of its control, `id`), a question mark
  // beside it where the setting has an explanation (`tip`, the bubble over the mark, which
  // keeps the line breaks of the text), the control on the right, and what belongs under
  // that line.
  const settingRow = ({ name, id = "", tip = "", control, under = "" }) => `
                <div class="row">
                  <div class="row-line">
                    <span class="row-title">${id ? `<label class="row-name" for="${id}">${name}</label>` : `<span class="row-name">${name}</span>`}${tip ? `<button class="row-help" type="button" aria-label="${tip}">${HELP_ICON}</button>` : ""}</span>
                    ${control}
                  </div>${under}
                </div>`;
  const switchRow = (name, id, tip) => settingRow({ name, id, tip, control: `<label class="switch"><input id="${id}" type="checkbox"><span></span></label>` });
  // A slider with a few stops (SLIDERS), its value on the right; the mark on it is the default.
  const sliderRow = (name, key, value, tip) => settingRow({ name, id: SLIDERS[key].id, tip, control: `<output id="${value}" for="${SLIDERS[key].id}"></output>`, under: `
                  <div class="slider"><i class="slider-fill" aria-hidden="true"></i><i class="slider-tick" aria-hidden="true"></i><input id="${SLIDERS[key].id}" type="range" min="0" max="${SLIDERS[key].stops.length - 1}" step="1"></div>` });

  const PANEL_HTML = `
    <main>
      <header>
        <img class="logo" src="${ICON_URI}" alt="" width="42" height="42">
        <div class="title">
          <div class="name">
            <h1>线程撕裂者</h1>
            <span class="version">v__BTR_VERSION__${SCRIPT_CHANNEL === "canary" ? '<b class="canary">Canary</b>' : ""}</span>
          </div>
          <a id="github-link" class="github-link" href="${PROJECT_URL}" target="_blank" rel="noopener noreferrer" title="在 GitHub 上查看项目" aria-label="在 GitHub 上查看项目">${GITHUB_ICON}</a>
          <button id="theme" class="theme-toggle" type="button" data-value="auto">${THEME_ICONS}</button>
        </div>
        <label class="switch" title="启用或停用">
          <input id="enabled" type="checkbox">
          <span></span>
        </label>
      </header>
      <p id="also-running" class="also-running" role="alert" hidden></p>
      <p id="disabled-note" class="disabled-note" role="status" hidden>线程撕裂者已关闭，打开右上角的开关即可启用。</p>

      <div class="view-main">
        <div class="block" data-needs-enabled>
          <h2 class="block-title">接管方式</h2>
          <section class="takeover-select" aria-label="接管方式">
            <label><input type="radio" name="takeover" value="full"><span>全接管</span></label>
            <label><input type="radio" name="takeover" value="compat"><span>兼容模式</span></label>
          </section>
          <p class="takeover-note"><span class="safari-note" hidden>Safari 用户建议使用兼容模式。<br><br></span>全接管：速度最快，几乎不兼容所有的第三方插件。<br>安装第三方增强插件，或遇到任何的问题，请使用兼容模式。</p>
        </div>
        <div class="block" data-needs-enabled>
          <h2 class="block-title">运行状态</h2>
          <section class="run-state" aria-label="运行状态">
            <span><b id="active-count">0</b> 条线程</span>
            <b class="run-speed">0 KB/s</b>
          </section>
        </div>
      </div>

      <details id="advanced" class="advanced">
        <summary>
          <span class="advanced-title">高级设置${CHEVRON_ICON}</span>
          <small>默认设置在绝大多数场景就是表现最优的。如果你遇到了问题，修改这里的一些设置可能有帮助。</small>
        </summary>
        <div class="advanced-page">
          <div class="page-bar">
            <button id="advanced-back" class="page-back" type="button" aria-label="返回">${CHEVRON_ICON}</button>
            <span class="page-title">高级设置</span>
          </div>
          <div class="tabs" role="tablist" aria-label="高级设置">
            <button id="tab-network" type="button" role="tab" data-tab="network" aria-controls="panel-network" aria-selected="true">网络</button>
            <button id="tab-buffer" type="button" role="tab" data-tab="buffer" aria-controls="panel-buffer" aria-selected="false" tabindex="-1">缓冲</button>
            <button id="tab-features" type="button" role="tab" data-tab="features" aria-controls="panel-features" aria-selected="false" tabindex="-1">功能</button>
            <button id="tab-interface" type="button" role="tab" data-tab="interface" aria-controls="panel-interface" aria-selected="false" tabindex="-1">界面</button>
          </div>
          <div id="panel-network" class="tab-panel" role="tabpanel" aria-labelledby="tab-network" data-tab-panel="network">
            <div class="block" data-needs-enabled>
              <h2 class="block-title">CDN 模式</h2>
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
                    <button class="link" type="submit">添加</button>
                  </form>
                  <p id="host-error" class="host-error" role="alert"></p>
                </fieldset>
                <p class="custom-note">只能填 B 站的视频服务器（bilivideo.com、akamaized.net 等），视频的下载地址不会发给别的网站。</p>
              </section>
            </div>
            <div class="block" data-needs-enabled>
              <h2 class="block-title">线程</h2>
              <section class="controls list">${switchRow("自动线程数", "auto-concurrency", "按网络情况自动选择线程数，推荐打开。")}${sliderRow("线程数", "concurrency", "thread-value", "同时下载的连接数。\n打开自动线程数时不适用。")}
              </section>
            </div>
          </div>
          <div id="panel-buffer" class="tab-panel" role="tabpanel" aria-labelledby="tab-buffer" data-tab-panel="buffer" hidden>
            <div class="block" data-needs-enabled>
              <section class="controls buffer-controls list" aria-label="缓冲">${sliderRow("预缓冲时长", "bufferAheadSeconds", "buffer-value", "全接管下往前缓冲多久。\n可能受浏览器 150 MiB 的限制。")}${switchRow("二级缓冲（实验性）", "secondary-buffer", "尝试绕过浏览器的视频缓冲容量限制。")}
              </section>
            </div>
          </div>
          <div id="panel-features" class="tab-panel" role="tabpanel" aria-labelledby="tab-features" data-tab-panel="features" hidden>
            <div class="block">
              <h2 class="block-title">调试</h2>
              <section class="notice-controls list" aria-label="调试">${settingRow({ name: "诊断信息", tip: "反馈问题时点一下，把内容贴到 issue 里。\n里面没有 Cookie、账号信息和下载地址。", control: '<span class="row-action"><span id="debug-copy-status" class="debug-copy-status" role="status"></span><button id="debug-copy" class="link" type="button">复制</button></span>', under: `
                  <textarea id="debug-copy-text" class="debug-copy-text" readonly hidden aria-label="诊断信息"></textarea>` })}
              </section>
            </div>
            <div class="block" data-needs-enabled>
              <h2 class="block-title">加速范围</h2>
              <section class="accel-controls list" aria-label="加速范围">${switchRow("音频加速", "audio-acceleration", "关掉后只加速视频，音频照常下载。")}${switchRow("剧集加速", "episode-enabled", "加速番剧、电影、纪录片等剧集，\n使用兼容模式。")}${switchRow("直播加速（实验性）", "live-enabled")}
              </section>
            </div>
            <div class="block" data-needs-enabled>
              <h2 class="block-title">自动清晰度</h2>
              <section class="quality-controls list" aria-label="自动清晰度">${sliderRow("最高", "autoQualityMax", "quality-value", "菜单选“自动”时最高选到哪一档，\n只在全接管下生效。")}
              </section>
            </div>
            <div class="block" data-needs-enabled>
              <h2 class="block-title">网页版本</h2>
              <section class="site-controls list" aria-label="网页版本">${switchRow("阻止使用国际版", "block-international", "把 B 站重定向到国内版网页。")}
              </section>
            </div>
          </div>
          <div id="panel-interface" class="tab-panel" role="tabpanel" aria-labelledby="tab-interface" data-tab-panel="interface" hidden>
            <div class="block">
              <section class="interface-controls list" aria-label="界面">${switchRow("悬浮按钮", "floating-button", "页面角落里打开这个面板的圆形按钮。")}
              </section>
            </div>
          </div>
        </div>
      </details>
    </main>
    <footer class="btr-footer">
      <button id="reset-settings" class="reset-settings" type="button">恢复默认设置</button>
    </footer>`;

  const PANEL_CSS = `
    .btr-popup {
      --scheme: dark; --bg: #17191f; --surface: #20232a; --hover: #292d35;
      --divider: #343943; --control-border: #444b57;
      --text: #f5f7fb; --label: #c9ced9; --button-text: #d9dee8;
      --muted: #949baa; --subtle: #8a93a6; --switch: #313a4c; --track: #3a3e47;
      --error: #f28b85; --success: #9fd9a8; --focus: #fff; --tab: #343943; --tip: #464d5b;
      --shadow: 0 24px 60px rgba(0, 0, 0, .5), 0 2px 10px rgba(0, 0, 0, .3);
    }
    .btr-popup[data-theme="light"] {
      --scheme: light; --bg: #fff; --surface: #f4f5f8; --hover: #e8ebf0;
      --divider: #d6dae2; --control-border: #aeb6c4;
      --text: #202532; --label: #363f50; --button-text: #363f50;
      --muted: #596579; --subtle: #596579; --switch: #758197; --track: #d6dae2;
      --error: #b42318; --success: #227536; --focus: #244e9b; --tab: #fff; --tip: #30353f;
      --shadow: 0 24px 60px rgba(15, 23, 42, .18), 0 2px 10px rgba(15, 23, 42, .08);
    }
    * { box-sizing: border-box; }
    .btr-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); }
    .btr-popup { position: fixed; top: 72px; right: 24px; width: 360px; max-width: calc(100vw - 32px); max-height: calc(100vh - 96px); overflow: auto; border: 0; border-radius: 16px; box-shadow: var(--shadow); color-scheme: var(--scheme); font-family: Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; background: var(--bg); color: var(--text); font-size: 14px; line-height: normal; text-align: left; user-select: none; -webkit-user-select: none; }
    input, textarea { user-select: text; -webkit-user-select: text; }
    /* The panel takes the focus when it opens, for the keyboard; it is no control to outline. */
    .btr-popup:focus { outline: none; }
    main { padding: 18px 18px 14px; }
    header { display: grid; grid-template-columns: 42px 1fr auto; align-items: center; gap: 11px; margin-bottom: 18px; }
    .logo { display: block; width: 42px; height: 42px; }
    h1 { margin: 0; font-size: 17px; letter-spacing: .2px; }
    .name { display: grid; gap: 2px; min-width: 0; }
    .version { color: var(--muted); font-size: 11px; line-height: 1.2; font-variant-numeric: tabular-nums; }
    .version .canary { margin-left: 6px; padding: 0 5px; border-radius: 4px; background: #f5b301; color: #1d1d1f; font-size: 10px; font-weight: 700; }
    /* With the master switch off the panel says so, and what only works with BTR on fades out
       and cannot be used: not 调试 (the diagnostic copy) or the floating button,
       which still apply. */
    .disabled-note { margin: -10px 0 14px; padding: 8px 10px; border-radius: 8px; background: rgba(251, 114, 153, .16); color: var(--text); font-size: 12px; line-height: 1.55; }
    [data-needs-enabled] { transition: opacity .2s ease, filter .2s ease; }
    main.is-off [data-needs-enabled] { opacity: .38; filter: grayscale(1); pointer-events: none; user-select: none; }
    .also-running { margin: -10px 0 14px; padding: 8px 10px; border-radius: 8px; background: rgba(245, 179, 1, .16); color: var(--text); font-size: 12px; line-height: 1.55; }
    .title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .github-link, .theme-toggle { display: grid; flex: none; place-items: center; width: 26px; height: 26px; border-radius: 6px; color: var(--muted); transition: color 160ms ease, background 160ms ease; }
    .github-link:hover, .theme-toggle:hover { color: var(--text); background: var(--hover); }
    .github-link:focus-visible, .theme-toggle:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .github-link svg, .theme-toggle svg { width: 18px; height: 18px; }
    .theme-toggle { margin-left: -6px; padding: 0; border: 0; background: transparent; cursor: pointer; }
    .theme-toggle svg { display: none; }
    .theme-toggle[data-value="auto"] .icon-auto, .theme-toggle[data-value="light"] .icon-light, .theme-toggle[data-value="dark"] .icon-dark { display: block; }
    .switch { position: relative; display: block; width: 42px; height: 24px; }
    .switch input { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
    .switch span { position: absolute; inset: 0; border-radius: 999px; background: var(--switch); cursor: pointer; transition: 160ms ease; }
    .switch span::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: 160ms ease; }
    .switch input:checked + span { background: #fb7299; }
    .switch input:checked + span::after { transform: translateX(18px); }
    .switch input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: 3px; }
    .mode-select { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; padding: 3px; border-radius: 10px; background: var(--surface); }
    .mode-select label { position: relative; }
    .mode-select input { position: absolute; opacity: 0; }
    .mode-select span { display: block; padding: 8px 6px; border-radius: 7px; color: var(--muted); background: transparent; font-size: 12px; text-align: center; cursor: pointer; transition: background 180ms ease, color 180ms ease; }
    .mode-select input:not(:checked) + span:hover { color: var(--text); }
    .mode-select input:checked + span { color: #fff; background: #fb7299; }
    .mode-select input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: -3px; }
    .takeover-select { display: grid; grid-template-columns: repeat(2, 1fr); gap: 3px; margin-bottom: 8px; padding: 3px; border-radius: 10px; background: var(--surface); }
    .takeover-select label { position: relative; }
    .takeover-select input { position: absolute; opacity: 0; }
    .takeover-select span { display: block; padding: 8px 6px; border-radius: 7px; color: var(--muted); background: transparent; font-size: 12px; text-align: center; cursor: pointer; transition: background 180ms ease, color 180ms ease; }
    .takeover-select input:not(:checked) + span:hover { color: var(--text); }
    .takeover-select input:checked + span { color: #fff; background: #fb7299; }
    .takeover-select input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: -3px; }
    .takeover-note { margin: 0; padding: 0 2px; color: var(--subtle); font-size: 11px; line-height: 1.6; }
    .custom-hosts { margin-top: 8px; padding: 14px 16px; border-radius: 12px; background: var(--surface); }
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
    .manual-host button { flex: none; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--muted); font: inherit; line-height: 22px; cursor: pointer; transition: background 160ms ease, color 160ms ease; }
    .host-form { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
    .host-form input { flex: 1; min-width: 0; padding: 7px 10px; border: 0; border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; font-size: 12px; }
    .host-error { min-height: 0; margin: 6px 0 0; color: var(--error); font-size: 11px; }
    .host-error:empty { display: none; }
    .host-form input:focus-visible, .host-form button:focus-visible, .manual-host button:focus-visible, .host-option input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    /* One kind of list for every setting: a card of rows, each a name with its control on the
       right and a slider under it where there is one. */
    .list { border-radius: 12px; background: var(--surface); }
    .row { padding: 11px 16px 12px; }
    .row + .row { border-top: 1px solid var(--divider); }
    .row-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 24px; }
    .row-title { display: flex; align-items: center; min-width: 0; }
    .row-name { min-width: 0; color: var(--label); font-size: 13px; }
    label.row-name { cursor: pointer; }
    .row .switch { flex: none; }
    output { flex: none; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .row.is-changed output { color: #fb7299; font-weight: 600; }
    .row.is-off .slider { opacity: .4; pointer-events: none; }
    /* The question mark beside a name, larger to the pointer than it looks. The explanation is
       its label, drawn as a bubble over it while the pointer or the keyboard is on it: it
       takes no room in the row and is gone the moment the pointer leaves. Where there is no
       room over the mark the bubble opens under it (.is-low). */
    .row-help { position: relative; display: grid; flex: none; place-items: center; width: 32px; height: 32px; margin: -4px 0 -4px -3px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--subtle); cursor: help; transition: color 160ms ease; }
    .row-help svg { width: 15px; height: 15px; }
    .row-help:hover, .row-help:focus-visible { color: var(--text); }
    .row-help:focus-visible { outline: 2px solid var(--focus); outline-offset: -7px; }
    .row-help::before, .row-help::after { position: absolute; z-index: 3; display: none; pointer-events: none; animation: btr-tip 140ms ease-out; }
    /* The tail: a triangle from the bubble's edge down to the mark, drawn over that edge and
       over the bubble's shadow so the two read as one shape. */
    .row-help::before { content: ""; bottom: calc(100% - 4px); left: 10px; z-index: 4; border: 6px solid transparent; border-bottom: 0; border-top-color: var(--tip); }
    .row-help::after { content: attr(aria-label); bottom: calc(100% + 1px); left: -44px; box-sizing: border-box; background: var(--tip); width: max-content; max-width: 260px; padding: 8px 11px; border-radius: 9px; box-shadow: 0 6px 18px rgba(0, 0, 0, .28); color: #fff; font-size: 11.5px; line-height: 1.6; text-align: left; white-space: pre-line; }
    .row-help.is-low::before { top: calc(100% - 4px); bottom: auto; border-top: 0; border-bottom: 6px solid var(--tip); }
    .row-help.is-low::after { top: calc(100% + 1px); bottom: auto; }
    .row-help:hover::before, .row-help:hover::after, .row-help:focus-visible::before, .row-help:focus-visible::after { display: block; }
    @keyframes btr-tip { from { opacity: 0; } }
    /* A slider: the mark (--mark) is the default, the colored part runs from it to the thumb (--at). */
    .slider { position: relative; height: 18px; margin-top: 5px; }
    .slider::before { content: ""; position: absolute; top: 7px; right: 0; left: 0; height: 4px; border-radius: 2px; background: var(--track); }
    .slider-fill { position: absolute; top: 7px; left: calc(7px + (100% - 14px) * min(var(--at, 0), var(--mark, 0))); width: calc((100% - 14px) * (max(var(--at, 0), var(--mark, 0)) - min(var(--at, 0), var(--mark, 0)))); height: 4px; border-radius: 2px; background: #fb7299; pointer-events: none; }
    .slider-tick { position: absolute; top: 4px; left: calc(7px + (100% - 14px) * var(--mark, 0)); width: 2px; height: 10px; margin-left: -1px; border-radius: 1px; background: var(--muted); opacity: .55; pointer-events: none; }
    input[type="range"] { position: absolute; inset: 0; width: 100%; height: 18px; margin: 0; appearance: none; -webkit-appearance: none; border: 0; outline: 0; background: transparent; cursor: pointer; }
    input[type="range"]::-webkit-slider-runnable-track { height: 18px; background: transparent; }
    input[type="range"]::-webkit-slider-thumb { width: 14px; height: 14px; margin-top: 2px; appearance: none; -webkit-appearance: none; border: 0; border-radius: 50%; background: #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, .14), 0 1px 3px rgba(0, 0, 0, .32); }
    input[type="range"]::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, .14), 0 1px 3px rgba(0, 0, 0, .32); }
    input[type="range"]:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 2px #fb7299, 0 1px 3px rgba(0, 0, 0, .32); }
    /* A quiet button: the one kind for what a row or a form does. */
    .link { flex: none; padding: 4px 8px; border: 0; border-radius: 6px; background: transparent; color: #fb7299; font: inherit; font-size: 12px; cursor: pointer; transition: background 160ms ease; }
    .link:hover { background: var(--hover); }
    .link:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .row-action { display: flex; flex: none; align-items: center; gap: 6px; min-width: 0; }
    .manual-host button:hover { background: var(--hover); color: var(--text); }
    .debug-copy-status { color: var(--success); font-size: 11px; }
    .debug-copy-status.failed { color: var(--error); }
    /* 恢复默认设置 and 关闭: the two buttons of the panel, side by side and of one shape. */
    .reset-settings, .btr-close { min-width: 0; margin: 0; padding: 11px 8px; border: 0; border-radius: 12px; font: inherit; font-size: 13px; text-align: center; cursor: pointer; transition: background 160ms ease, color 160ms ease; }
    .reset-settings { background: var(--surface); color: var(--label); }
    .reset-settings:hover { background: var(--hover); }
    .reset-settings[data-asking] { color: var(--error); font-weight: 600; }
    .reset-settings:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .debug-copy-text { width: 100%; height: 120px; margin-top: 10px; padding: 6px; border: 1px solid var(--control-border); border-radius: 6px; background: var(--bg); color: var(--button-text); font: 11px/1.4 Consolas, monospace; resize: vertical; }
    .debug-copy-text[hidden] { display: none; }
    .run-state { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 12px 16px; border-radius: 12px; background: var(--surface); color: var(--label); font-size: 13px; }
    .run-state b { color: var(--text); font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
    /* 恢复默认设置 and 关闭 stay at the bottom of every page of the panel, solid for the content
       scrolling under them. */
    .btr-footer { position: sticky; bottom: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 8px 18px 16px; background: var(--bg); box-shadow: 0 -10px 12px var(--bg); }
    .btr-close { background: #4a515e; color: #fff; font-weight: 600; }
    .btr-close:hover { background: #565e6c; }
    .btr-popup[data-theme="light"] .btr-close { background: #dde1e8; color: #1f2329; }
    .btr-popup[data-theme="light"] .btr-close:hover { background: #d0d5de; }
    .btr-close:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .advanced > summary { display: block; padding: 14px 16px; border-radius: 12px; background: var(--surface); list-style: none; cursor: pointer; transition: background 160ms ease; }
    .advanced > summary::-webkit-details-marker { display: none; }
    .advanced > summary:hover { background: var(--hover); }
    .advanced > summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .advanced-title { display: flex; align-items: center; justify-content: space-between; color: var(--label); font-size: 13px; }
    .advanced-title svg { flex: none; width: 16px; height: 16px; color: var(--muted); }
    .advanced > summary small { display: block; margin-top: 6px; color: var(--subtle); font-size: 11px; line-height: 1.6; }
    .view-main, .tab-panel { display: grid; gap: 14px; align-content: start; min-width: 0; }
    .view-main { margin-bottom: 14px; }
    .tab-panel[hidden], [data-host-hidden] { display: none !important; }
    .block { min-width: 0; }
    .block-title { margin: 0 0 6px 2px; color: var(--subtle); font-size: 11px; font-weight: 600; line-height: 1.4; }
    /* 高级设置 is a page of its own: its entry leads in, its bar back, and its tabs keep each
       part short enough for one screen. */
    main.is-advanced .view-main, main.is-advanced .advanced > summary { display: none; }
    .advanced > summary .advanced-title svg { transform: rotate(-90deg); }
    .page-bar { display: flex; align-items: center; gap: 4px; margin: -4px 0 12px -6px; }
    .page-back { display: grid; flex: none; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--muted); cursor: pointer; transition: background 160ms ease, color 160ms ease; }
    .page-back:hover { background: var(--hover); color: var(--text); }
    .page-back:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .page-back svg { width: 18px; height: 18px; transform: rotate(90deg); }
    .page-title { color: var(--text); font-size: 15px; font-weight: 600; }
    /* Further from what is under it than the blocks are from each other, so the tabs do not
       read as one more block of the page they switch. */
    .tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; margin-bottom: 24px; padding: 3px; border-radius: 10px; background: var(--surface); }
    .tabs button { padding: 7px 4px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; transition: background 180ms ease, color 180ms ease; }
    .tabs button:hover { color: var(--text); }
    .tabs button[aria-selected="true"] { background: var(--tab); color: var(--text); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, .12); }
    .tabs button:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
    .host-option { border-radius: 4px; }
    .btr-popup { --ripple: rgba(251, 114, 153, .35); }
    .btr-popup[data-theme="light"] { --ripple: rgba(251, 114, 153, .3); }
    .mode-select input:checked + span, .takeover-select input:checked + span, .switch input:checked + span { --ripple: rgba(255, 255, 255, .35); }
    ${RIPPLE_CSS}
  `;

  const LAUNCHER_CSS = `
    .btr-launcher { position: fixed; right: 76px; bottom: 116px; display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; background: #fb7299; color: #fff; font: 700 13px/1 Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; letter-spacing: .3px; cursor: grab; opacity: .6; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; box-shadow: 0 4px 14px rgba(0, 0, 0, .25); transition: opacity 160ms ease, transform 160ms ease, left 180ms ease, right 180ms ease; }
    .btr-launcher:hover, .btr-launcher:focus-visible { opacity: 1; transform: scale(1.06); }
    .btr-launcher:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .btr-launcher.dragging { cursor: grabbing; opacity: 1; transform: scale(1.1); transition: opacity 160ms ease, transform 160ms ease; }
    @media (max-width: 700px) { .btr-launcher { width: 40px; height: 40px; font-size: 12px; } }
    .btr-launcher { --ripple: rgba(255, 255, 255, .35); }
    .btr-launcher.guiding { opacity: 1; animation: btr-guide-pulse 1.6s ease-in-out infinite; }
    @keyframes btr-guide-pulse { 50% { transform: scale(1.14); } }
    @media (prefers-reduced-motion: reduce) { .btr-launcher.guiding { animation: none; } }
    ${RIPPLE_CSS}
  `;
  const GUIDE_CSS = `
    .btr-guide { position: fixed; inset: 0; background: rgba(0, 0, 0, .72); cursor: pointer; font: 16px/1.5 Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
    .btr-guide p { position: absolute; left: 50%; top: 42%; margin: 0; color: #fff; font-size: 22px; white-space: nowrap; transform: translate(-50%, -50%); }
    .btr-guide b { color: #fb7299; font-weight: 700; }
    .btr-guide svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    .btr-guide path { fill: none; stroke: #fff; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
    @media (max-width: 480px) { .btr-guide p { font-size: 17px; } }
  `;
  // The guide used to come back on every Bilibili subdomain: its record was in that site's
  // localStorage (#26). It is now in the stored settings (the script manager's, shared by all
  // subdomains), with a cookie on .bilibili.com for when those fall back to localStorage. Both
  // reach every subdomain, so 恢复默认设置 can take the record back everywhere.
  // The desktop client is one site, and it brings its cookies back by itself each time it
  // starts: there a cookie has nothing to do and could not be cleared.
  const GUIDE_COOKIE = "BTR.guideDone";
  function writeGuideCookie(value, seconds) {
    if (hostApp) return;
    try { document.cookie = `${GUIDE_COOKIE}=${value}; domain=.bilibili.com; path=/; max-age=${seconds}; SameSite=Lax; Secure`; } catch (_error) {}
  }
  function guideMarked() {
    if (hostApp) return false;
    try { return document.cookie.split("; ").includes(`${GUIDE_COOKIE}=1`); } catch (_error) { return false; }
  }
  const markGuide = () => writeGuideCookie("1", 315360000);
  const forgetGuide = () => writeGuideCookie("", 0);

  let current = null;
  // bridge.js sends the stored settings when they load or change, and the page its stats.
  let latestSettings = null;
  let latestStats = null;

  // Everything needed to look into a report, as English text to paste into an issue. This only
  // gathers the facts; diagnostic-report.js lays them out (and translates what is left in
  // Chinese, such as BTR's own error messages). The facts carry no cookie values, no account
  // and no download address: only the derived site choices, whether someone is signed in, and
  // node names. A source that cannot be read leaves its part empty and says why in readErrors.
  function diagnostics() {
    const readErrors = [];
    const errorText = (error) => String(error?.message || error?.name || error || "unknown error").slice(0, 160);
    const read = (name, fact, fallback = null) => {
      try { return fact(); } catch (error) {
        readErrors.push(`${name}: ${errorText(error)}`);
        return fallback;
      }
    };
    const cookie = (name) => {
      const value = (new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(document.cookie) || [])[1];
      if (value === undefined) return undefined;
      try { return decodeURIComponent(value); } catch (_error) { return value; }
    };
    const snapshot = {
      capturedAt: Date.now(),
      timeOrigin: performance.timeOrigin,
      now: performance.now(),
      btr: read("btr", () => ({
        version: "__BTR_VERSION__",
        channel: SCRIPT_CHANNEL,
        otherBuild: ["stable", "canary"].includes(otherScript()) ? otherScript() : "",
        scriptManager: document.documentElement?.getAttribute("data-btr-userscript-manager") || "",
        host: hostApp ? "desktop" : "userscript"
      })),
      env: read("env", () => ({ userAgent: navigator.userAgent, language: navigator.language, viewport: `${root.innerWidth}x${root.innerHeight}`, page: `${location.origin}${location.pathname}` })),
      settings: latestSettings ? { ...latestSettings } : null,
      // Which site Bilibili shows and why (#68). The site cookies only as the choices they
      // stand for; signed in or not, never who.
      site: read("site", () => {
        const marks = document.documentElement?.dataset || {};
        const userSite = String(cookie("user_site") ?? "").toUpperCase();
        let accountSites = null;
        try {
          const sites = JSON.parse(cookie("default_sites") ?? "null");
          if (Array.isArray(sites)) accountSites = sites.map((item) => (["CN", "OVERSEAS"].includes(String(item).toUpperCase()) ? String(item).toUpperCase() : "other"));
        } catch (_error) {}
        const lang = cookie("lang") ?? "";
        return {
          international: Boolean(root.__BTR_BILIBILI_SITE__?.domesticAddress(location.href)),
          signedIn: /(?:^|;\s*)DedeUserID=/.test(document.cookie),
          userSite: ["", "CN", "OVERSEAS"].includes(userSite) ? userSite : "other",
          accountSites,
          lang: /^[A-Za-z]{1,8}(?:[-_][A-Za-z0-9]{1,8}){0,3}$/.test(lang) || !lang ? lang : "other",
          // bridge.js marks the page once it watches for the trips to the international site.
          guard: marks.btrSiteGuard === "on" ? "on" : typeof root.navigation?.addEventListener === "function" ? "off" : "unsupported",
          redirectsBlocked: Number(marks.btrSiteRedirectsBlocked) || 0,
          gaveUp: marks.btrSiteGaveUp === "true"
        };
      }),
      // The video takeover runs on the www and m pages only (page-hook.js).
      video: read("video", () => {
        const api = root.__biliThreadRipperDebug;
        return typeof api?.report === "function" ? JSON.parse(api.report()) : null;
      }),
      stats: read("stats", () => root.__biliThreadRipperDebug?.getStats?.() ?? null),
      autoThreads: read("autoThreads", () => root.__BILI_IDM_DOWNLOADER_FACTORY__?.autoConcurrency?.status?.() ?? null),
      media: read("media", () => root.__BTR_RUNTIME_NOTICES__?.history?.() ?? [], []),
      live: read("live", () => {
        // The live player often sits in a live.bilibili.com iframe, where its module runs with
        // its own clock. Another site's frame cannot be read, and is no module of ours.
        const modules = [];
        const views = [root];
        for (const frame of document.querySelectorAll("iframe")) {
          try { if (frame.contentWindow) views.push(frame.contentWindow); } catch (_error) {}
        }
        let frames = 0;
        for (const view of views) {
          let api = null;
          try { api = view.__biliThreadRipperLiveDebug; } catch (_error) {}
          if (!api || typeof api.getStats !== "function") continue;
          const frame = view === root ? "top" : `iframe ${++frames}`;
          read(`live ${frame}`, () => modules.push({
            frame,
            timeOriginDelta: Math.round((Number(view.performance?.timeOrigin) || performance.timeOrigin) - performance.timeOrigin),
            stats: api.getStats(),
            context: api.getContext?.() ?? null,
            events: api.getEvents?.() ?? []
          }));
        }
        return modules;
      }, []),
      readErrors
    };
    try {
      const formatter = root.__BTR_DIAGNOSTIC_REPORT__;
      if (typeof formatter?.render !== "function") throw new Error("the formatter is not loaded");
      return String(formatter.render(snapshot));
    } catch (error) {
      // The facts as they are, still without any address's query or text in Chinese.
      const text = `BTR diagnostics: formatter failed: ${errorText(error)}\n${JSON.stringify(snapshot, null, 1)}`;
      return text.replace(/((?:https?:)?\/\/[^\s"'?#]+)[?#][^\s"']*/gi, "$1").replace(/[^\x00-\x7f]/g, "?");
    }
  }
  const post = (type, payload) => root.postMessage({ channel: CHANNEL, type, payload }, "*");

  function open(options = {}) {
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
    style.textContent = PANEL_CSS + (hostApp?.css || "");
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
    panel.querySelector(".btr-footer").append(closeButton);
    shadow.append(style, backdrop, panel);
    // The line for Safari users only where it applies: Safari, and every browser on iOS
    // (all of them WebKit underneath).
    panel.querySelector(".safari-note").hidden = !/apple/i.test(navigator.vendor || "");

    const $ = (id) => shadow.getElementById(id);
    // The released script and the Canary are both switched on: only this one runs.
    const other = otherScript();
    if (other) {
      const alsoRunning = $("also-running");
      alsoRunning.textContent = `正式版和 Canary 同时启用了。现在生效的是${CHANNEL_NAMES[SCRIPT_CHANNEL]}，${CHANNEL_NAMES[other] || other}没有运行。请在脚本管理器里只启用一个。`;
      alsoRunning.hidden = false;
    }
    for (const selector of hostApp?.hide || []) {
      for (const node of panel.querySelectorAll(selector)) (node.closest(".block") || node).dataset.hostHidden = "";
    }
    if (hostApp?.projectUrl) $("github-link").href = hostApp.projectUrl;
    hostApp?.mount?.(panel);
    const advanced = $("advanced");
    const panelMain = panel.querySelector("main");
    const tabs = [...panel.querySelectorAll('[role="tab"]:not([data-host-hidden])')];
    const tabPanels = [...panel.querySelectorAll("[data-tab-panel]")];
    const still = () => root.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const EASE = "cubic-bezier(.2, .8, .2, 1)";
    // The panel's height glides to what it shows next instead of jumping there.
    const resize = (change) => {
      const from = panel.offsetHeight;
      change();
      const to = panel.offsetHeight;
      if (still() || Math.abs(to - from) < 2) return;
      panel.style.overflow = "hidden";
      panel.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 240, easing: EASE }).finished
        .finally(() => { panel.style.overflow = ""; }).catch(() => {});
    };
    const enter = (node, from) => {
      if (node && !still()) node.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: "none" }], { duration: 240, easing: EASE });
    };
    let advancedTab = "network";
    const selectTab = (name) => {
      advancedTab = name;
      for (const tab of tabs) {
        tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
        tab.tabIndex = tab.dataset.tab === name ? 0 : -1;
      }
      for (const part of tabPanels) part.hidden = part.dataset.tabPanel !== name;
    };
    const showAdvanced = (show, animate = true) => {
      const change = () => {
        advanced.open = show;
        panelMain.classList.toggle("is-advanced", show);
      };
      if (!animate) return change();
      clearRipples(panel);
      resize(change);
      enter(panel.querySelector(show ? ".advanced-page" : ".view-main"), show ? "translateX(18px)" : "translateX(-18px)");
    };
    // The panel always opens on its first page; "自定义" in the gear menu opens it on the
    // custom servers, under 网络.
    selectTab("network");
    showAdvanced(options.advanced === true, false);
    advanced.querySelector("summary").addEventListener("click", (event) => {
      event.preventDefault();
      showAdvanced(true);
      // From the keyboard, the focus follows to the page's way back.
      if (event.detail === 0) $("advanced-back").focus();
    });
    $("advanced-back").addEventListener("click", (event) => {
      showAdvanced(false);
      if (event.detail === 0) advanced.querySelector("summary").focus();
    });
    for (const tab of tabs) {
      tab.addEventListener("click", () => {
        if (tab.dataset.tab === advancedTab) return;
        resize(() => selectTab(tab.dataset.tab));
        enter(tabPanels.find((part) => !part.hidden), "translateY(6px)");
      });
    }
    // The arrow keys go from tab to tab, as in any tab list.
    panel.querySelector(".tabs").addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = tabs[(tabs.findIndex((tab) => tab.dataset.tab === advancedTab) + step + tabs.length) % tabs.length];
      next.focus();
      next.click();
    });
    // A press ripples over the colored part of a switch or of a choice, otherwise over the
    // control itself; not over a question mark, whose bubble the ripple would cut off.
    panel.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const target = event.target.closest("button:not(.row-help), a[href], summary, .switch, .mode-select label, .takeover-select label, .host-option");
      if (!target || target.matches(":disabled")) return;
      ripple(target.matches(".switch, .mode-select label, .takeover-select label") ? target.querySelector("span") : target, event);
    });
    const enabled = $("enabled");
    const disabledNote = $("disabled-note");
    const needsEnabled = [...panel.querySelectorAll("[data-needs-enabled]")];
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
    const resetSettings = $("reset-settings");
    const customSection = $("custom-hosts");
    const hostInput = $("host-input");
    const hostError = $("host-error");
    const activeCount = $("active-count");
    const totalSpeed = panel.querySelector(".run-speed");
    let customHosts = [];

    const save = (update) => post("settings-update", update);

    // A slider at the stop of `value`: the mark stays on the default, the colored part runs
    // from it to the thumb, and the value turns pink once it is not the default. With 自动线程数
    // on, the slider of the threads is out of use and says so; it keeps the viewer's own count.
    function showSlider(key, value) {
      const { id, stops, usual, text } = SLIDERS[key];
      const input = $(id), row = input.closest(".row"), top = stops.length - 1;
      const index = stops.indexOf(stops.includes(Number(value)) ? Number(value) : usual);
      const off = key === "concurrency" && $("auto-concurrency").checked;
      input.value = String(index);
      input.disabled = off;
      input.setAttribute("aria-valuetext", text(stops[index]));
      input.parentElement.style.setProperty("--mark", String(stops.indexOf(usual) / top));
      input.parentElement.style.setProperty("--at", String(index / top));
      row.querySelector("output").value = off ? "自动" : text(stops[index]);
      row.classList.toggle("is-off", off);
      row.classList.toggle("is-changed", !off && stops[index] !== usual);
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
      disabledNote.hidden = settings.enabled !== false;
      panelMain.classList.toggle("is-off", settings.enabled === false);
      for (const node of needsEnabled) node.inert = settings.enabled === false;
      for (const radio of shadow.querySelectorAll('input[name="takeover"]')) radio.checked = radio.value === settings.takeover;
      for (const [id, key, usual] of SWITCHES) $(id).checked = usual ? settings[key] !== false : settings[key] === true;
      for (const key of Object.keys(SLIDERS)) showSlider(key, settings[key]);
      setMode(settings.mode);
      customHosts = settings.customHosts;
      renderHosts();
    }

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
    for (const [id, key] of SWITCHES) $(id).addEventListener("change", (event) => save({ [key]: event.target.checked }));
    for (const [key, { id, stops }] of Object.entries(SLIDERS)) {
      $(id).addEventListener("input", (event) => {
        const value = stops[Number(event.target.value)];
        showSlider(key, value);
        save({ [key]: value });
      });
    }
    // A bubble that would leave the top of the panel opens under its question mark instead.
    const placeBubble = (event) => {
      const help = event.target instanceof Element ? event.target.closest(".row-help") : null;
      if (help) help.classList.toggle("is-low", help.getBoundingClientRect().top - panel.getBoundingClientRect().top < 96);
    };
    panel.addEventListener("pointerover", placeBubble);
    panel.addEventListener("focusin", placeBubble);
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
    // It asks in place: the second click is the answer, and going elsewhere takes the question back.
    let resetAsked = 0;
    const stopAsking = () => {
      root.clearTimeout(resetAsked);
      delete resetSettings.dataset.asking;
      resetSettings.textContent = "恢复默认设置";
    };
    resetSettings.addEventListener("click", () => {
      if (resetSettings.dataset.asking) {
        stopAsking();
        // Back to first use: the guide comes up again as soon as the panel is out of the way.
        forgetGuide();
        post("settings-reset");
        current?.close();
        return;
      }
      resetSettings.dataset.asking = "true";
      resetSettings.textContent = "确认？";
      resetAsked = root.setTimeout(stopAsking, 4000);
    });
    resetSettings.addEventListener("blur", stopAsking);
    const copyStatus = $("debug-copy-status");
    const copyText = $("debug-copy-text");
    const copyButton = $("debug-copy");
    let copyDoneTimer = 0;
    copyButton.addEventListener("click", async () => {
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
      // Done, the button says so in place for a moment, keeping its width; otherwise the note
      // next to it points to the text to copy by hand.
      root.clearTimeout(copyDoneTimer);
      copyStatus.classList.toggle("failed", !copied);
      copyStatus.textContent = copied ? "" : "没能自动复制，请手动复制下面的内容";
      if (!copied) return;
      if (!copyButton.style.minWidth) copyButton.style.minWidth = `${copyButton.offsetWidth}px`;
      copyButton.textContent = "已复制";
      copyDoneTimer = root.setTimeout(() => { copyButton.textContent = "复制"; }, 2500);
    });

    // Keys typed into the panel belong to it. The shadow root hides the input from the page,
    // so the player's shortcuts (space, F, arrows) would otherwise react to them.
    const keepKeys = (event) => { if (event.key !== "Escape") event.stopPropagation(); };
    for (const type of ["keydown", "keyup", "keypress"]) panel.addEventListener(type, keepKeys);

    // The threads and the speed now: asking for stats makes the page send fresh ones. The
    // numbers run to their new values instead of jumping there.
    const shown = { threads: 0, speed: 0 };
    let rollFrame = 0;
    const showRunState = (threads, speed) => {
      activeCount.textContent = String(Math.round(threads));
      totalSpeed.textContent = formatSpeed(speed);
    };
    const refresh = () => {
      const from = { ...shown };
      shown.threads = Math.max(0, Math.trunc(Number(latestStats?.activeThreads) || 0));
      shown.speed = Math.max(0, Number(latestStats?.totalSpeedBps) || 0);
      root.cancelAnimationFrame(rollFrame);
      if (still() || (from.threads === shown.threads && from.speed === shown.speed)) showRunState(shown.threads, shown.speed);
      else {
        const startedAt = performance.now();
        const roll = (now) => {
          if (current?.host !== host) return;
          const progress = Math.min(1, (now - startedAt) / 360);
          const eased = 1 - (1 - progress) ** 3;
          showRunState(from.threads + (shown.threads - from.threads) * eased, from.speed + (shown.speed - from.speed) * eased);
          if (progress < 1) rollFrame = root.requestAnimationFrame(roll);
        };
        rollFrame = root.requestAnimationFrame(roll);
      }
      post("get-stats");
    };
    const timer = setInterval(refresh, 400);
    const onKey = (event) => { if (event.key === "Escape") close(); };
    // However the panel was found, the viewer has found it.
    launcher?.finishGuide();
    const close = () => {
      if (current?.host !== host) return;
      current = null;
      clearInterval(timer);
      root.cancelAnimationFrame(rollFrame);
      systemTheme.removeEventListener("change", applyTheme);
      launcher?.apply();
      document.removeEventListener("keydown", onKey, true);
      clearRipples(panel);
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
    // Until bridge.js sends the stored settings, its defaults: 自动线程数 is on there, while
    // normalizeSettings on its own leaves it off.
    render(latestSettings || core.normalizeSettings({ autoConcurrency: true }));
    post("get-settings");
    refresh();
    panel.focus();
  }

  const toggle = () => (current ? current.close() : open());

  // The button in the corner of every bilibili page. The userscript manager's menu is not
  // obvious (and on the home page people do not find it at all), so the panel needs a way in
  // that is always visible.
  // It hides while the video is fullscreen, while the panel itself is open, and when 悬浮按钮
  // is switched off.
  const launcher = (() => {
    if (root.top !== root) return null;
    const MARGIN = 12;
    // How far a press has to travel before it counts as dragging rather than a click.
    const DRAG_SLOP = 4;
    // Let go this close to the left or right edge and it snaps flush to it; let go anywhere
    // else and it simply stays where it was put.
    const SNAP_PX = 72;
    let host = null;
    let button = null;
    let wanted = true;
    // Where the viewer left it, as shares of the window: 0 means stuck to the left edge, 1 to
    // the right edge, anything between is a free spot. null: never moved.
    let leftRatio = null;
    let topRatio = null;
    let dragging = null;
    // The first-run guide waits for the stored settings: before they arrive nobody knows
    // whether it was answered already.
    let guide = null;
    let guideAnswered = null;

    function finishGuide() {
      if (guideAnswered === true && !guide) return;
      guideAnswered = true;
      markGuide();
      post("settings-update", { guideDone: true });
      hideGuide();
    }

    function hideGuide() {
      if (!guide) return;
      root.cancelAnimationFrame(guide.frame);
      guide.host.remove();
      guide = null;
      button?.classList.remove("guiding");
    }

    // The arrow is drawn again on every frame, so it stays on the button however the button
    // or the window moves: from the edge of the text, curving, to just short of the button.
    function drawGuide() {
      if (!guide || !button?.isConnected) return;
      guide.frame = root.requestAnimationFrame(drawGuide);
      const target = button.getBoundingClientRect(), text = guide.text.getBoundingClientRect();
      const toX = target.left + target.width / 2, toY = target.top + target.height / 2;
      const fromX = text.left + text.width / 2, fromY = text.top + text.height / 2;
      const distance = Math.hypot(toX - fromX, toY - fromY) || 1;
      const unitX = (toX - fromX) / distance, unitY = (toY - fromY) / distance;
      // Where the line from the text's middle leaves its box.
      const leave = Math.min(unitX ? (text.width / 2 + 14) / Math.abs(unitX) : Infinity, unitY ? (text.height / 2 + 14) / Math.abs(unitY) : Infinity);
      const stop = target.width / 2 + 16;
      if (distance - leave - stop < 24) { guide.arrow.setAttribute("d", ""); return; }
      const startX = fromX + unitX * leave, startY = fromY + unitY * leave;
      const endX = toX - unitX * stop, endY = toY - unitY * stop;
      const bend = (distance - leave - stop) * .18;
      const bendX = (startX + endX) / 2 - unitY * bend, bendY = (startY + endY) / 2 + unitX * bend;
      const angle = Math.atan2(endY - bendY, endX - bendX);
      const barb = (side) => `${(endX - 15 * Math.cos(angle + side)).toFixed(1)} ${(endY - 15 * Math.sin(angle + side)).toFixed(1)}`;
      guide.arrow.setAttribute("d", `M${startX.toFixed(1)} ${startY.toFixed(1)} Q${bendX.toFixed(1)} ${bendY.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)} M${barb(.5)} L${endX.toFixed(1)} ${endY.toFixed(1)} L${barb(-.5)}`);
    }

    function showGuide() {
      const guideHost = document.createElement("div");
      guideHost.id = GUIDE_ID;
      guideHost.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483644!important;";
      const shadow = guideHost.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = GUIDE_CSS;
      const cover = document.createElement("div");
      cover.className = "btr-guide";
      cover.innerHTML = '<p>点这里打开全新 <b>线程撕裂者</b> 设置</p><svg aria-hidden="true"><path></path></svg>';
      // A click anywhere on it counts: it is the only thing on the screen that can be clicked.
      cover.addEventListener("click", () => open());
      shadow.append(style, cover);
      (document.body || document.documentElement).append(guideHost);
      guide = { host: guideHost, text: cover.querySelector("p"), arrow: cover.querySelector("path"), frame: 0 };
      button.classList.add("guiding");
      drawGuide();
    }

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
      if (left <= SNAP_PX) leftRatio = 0;
      else if (left + size >= width - SNAP_PX) leftRatio = 1;
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
      button.addEventListener("pointerdown", (event) => {
        if (event.button === 0) ripple(button, event);
        startDrag(event);
      });
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
        hideGuide();
        host?.remove();
        return;
      }
      // Bilibili replaces large parts of the page when you navigate; mount puts it back if it went.
      mount();
      if (!dragging) place();
      if (guide && !(guide.host.isConnected && button.isConnected)) hideGuide();
      if (guideAnswered === false && !guide) showGuide();
    }

    const update = (settings) => {
      wanted = settings?.floatingButton !== false;
      // null (never dragged) must stay null: Number(null) is 0, which would pin it to a corner.
      const ratio = (value) => (value != null && Number(value) >= 0 && Number(value) <= 1 ? Number(value) : null);
      leftRatio = ratio(settings?.floatingButtonLeft);
      topRatio = ratio(settings?.floatingButtonTop);
      if (settings?.guideDone === true) {
        guideAnswered = true;
        markGuide();
        hideGuide();
      } else if (guideMarked()) {
        // Answered on another subdomain or before the stored settings could take it.
        guideAnswered = false;
        finishGuide();
      } else guideAnswered = false;
      apply();
    };
    for (const type of ["fullscreenchange", "webkitfullscreenchange"]) document.addEventListener(type, apply, true);
    root.addEventListener("resize", apply);
    // A page that swaps its body (the SPA navigations) drops the button with it.
    setInterval(apply, 2000);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
    // The button is on by default, so it is there before the stored settings arrive.
    apply();
    return { update, apply, finishGuide };
  })();

  root.addEventListener("message", (event) => {
    if (event.source !== root || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "settings") {
      latestSettings = core.normalizeSettings(event.data.payload);
      launcher?.update(latestSettings);
      current?.render(latestSettings);
    } else if (event.data.type === "stats") {
      latestStats = event.data.payload;
    } else if (event.data.type === "open-settings" && root.top === root) {
      // "自定义" in the gear menu: the custom servers are under 高级设置.
      open({ advanced: true });
    }
  });
  // The userscript manager's menu entry.
  document.addEventListener("btr-userscript-open-settings", () => { if (root.top === root) toggle(); });

  // Settings sent before this file ran went unheard.
  post("get-settings");

  root.__BTR_SETTINGS_PANEL__ = Object.freeze({ open, close: () => current?.close(), toggle, isOpen: () => Boolean(current) });
})(globalThis);
