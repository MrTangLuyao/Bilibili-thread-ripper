# 贡献指南

我个人能力有限，本项目欢迎任何形式的贡献。

- **反馈问题** 可以到 [Issues](https://github.com/MrTangLuyao/Bilibili-thread-ripper/issues/new/choose) 中反馈你遇到的任何问题。
- **提建议**：到 [Issues](https://github.com/MrTangLuyao/Bilibili-thread-ripper/issues/new/choose) 中提建议。
- **试用 Canary 测试版**：测试最新版本的BTR
- **改进代码**：向项目提交PR

## 关于AI

本项目欢迎AI代码贡献，只需保证代码质量即可。



## Canary 测试版

[![点击测试 BTR Canary](https://img.shields.io/badge/%E7%82%B9%E5%87%BB%E6%B5%8B%E8%AF%95-BTR%20Canary-f5b301?style=for-the-badge&logo=bilibili&logoColor=white)](https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper/main/canary/bilibili-thread-ripper-canary.user.js)

Canary 是另一个脚本，跟着开发中的最新代码自动更新，给贡献者和想抢先试新改动的人用，可能不稳定。



## 项目结构

```text
Bilibili-thread-ripper/
├── src/                                脚本源码 见下表
├── user_scripts/
│   ├── adapter/
│   │   ├── meta.json                   脚本头和打包顺序（pageFiles）
│   │   ├── loader.js                   在脚本管理器一侧运行 注入页面代码 注册菜单 读写设置
│   │   └── storage-shim.js             页面一侧的设置存取 转交给 loader.js
│   └── bilibili-thread-ripper.user.js  正式版脚本 发版时生成
├── canary/                             Canary 测试版脚本 由 GitHub Actions 生成
├── scripts/                            构建 发版 Canary 贡献者头像脚本
├── dev/                                测试以及测试用的页面和本地服务器
├── .github/                            issue 模板和 GitHub Actions 工作流
├── icons/                              脚本图标
├── pics/                               README 里的图片
└── CHANGELOG.md                        更新日志
```

`src/` 下的文件

| 文件 | 职责 |
| --- | --- |
| `page-hook.js` | 入口。只在视频页接管播放，把下面各部分接起来 |
| `native-mse-player.js` | 全接管 |
| `native-range-transport.js` | 兼容模式 |
| `idm-downloader.js` | 多线程下载的调度 |
| `cdn-resolver.js` | CDN 节点的选择、测速、停用和恢复 |
| `range-core.js` | 各部分共用的基础函数 |
| `sidx.js` | 读视频的分段索引 |
| `live-core.js`、`live-hook.js` | 直播加速：前一个是纯逻辑，后一个接到直播页上 |
| `replay-hook.js` | 直播回放加速（直播剪辑页 `/web-cut/`）：并行预取回放分片，跟着直播加速开关 |
| `settings-panel.js` | 设置面板 |
| `stats-panel.js` | BTR 统计信息 |
| `diagnostic-report.js` | 诊断信息的文字 |
| `runtime-notices.js` | 记下播放器的事件和卡顿，给诊断信息用 |
| `bilibili-site.js` | 认出 B 站国际版的页面 |
| `bridge.js` | 设置的读取和保存 |

构建时，`scripts/build.mjs` 按 `user_scripts/adapter/meta.json` 里 `pageFiles` 的顺序把这些文件拼成一个脚本。新增文件要加进 `pageFiles`，被依赖的文件排在前面。

## 本地开发

### 环境

- [Node.js](https://nodejs.org/) 24（自动测试用的版本）
- Git
- 装了暴力猴或 Tampermonkey 的浏览器，用来试自己构建的脚本

项目没有任何依赖，不需要 `npm install`。

### 获取代码

先在 GitHub 上 fork 本仓库，然后：

```bash
git clone https://github.com/<你的用户名>/Bilibili-thread-ripper.git
cd Bilibili-thread-ripper
git remote add upstream https://github.com/MrTangLuyao/Bilibili-thread-ripper.git
git fetch upstream --tags
git switch -c fix/quality-switch upstream/main
```

`git fetch upstream --tags` 不能省：构建用最近一个 tag 作版本号，fork 里不一定带着 tag。分支名换成自己的，常见的是 `fix/…`、`feat/…`。

### 构建

```bash
npm run build
```

生成 `dist/bilibili-thread-ripper.user.js`。`node scripts/build.mjs --canary` 生成 Canary 版。

### 在浏览器里调试

1. 在脚本管理器里打开已安装的“Bilibili 线程撕裂者”，把内容整个替换成 `dist/bilibili-thread-ripper.user.js` 的内容并保存。没安装过就新建一个脚本粘贴进去。
2. 装了 Canary 的话先停用。两个都启用时，只有先启动的那个在运行。
3. 刷新 B 站视频页面。

自己构建的脚本和正式版是同一个脚本，下次发版时可能被自动更新覆盖。

### 测试

~~相信你也看到了，这个项目的测试就是**一坨狗屎**。我是实在不知道如何写测试，所以这些测试都是我借助AI工具来写的一些测试，虽然你看到Github Actions上有些测试，但是这基本是根据答案出题的。实际是否工作还是得亲自上手后面内容看看就好。~~

```bash
npm test
```

| 测试 | 需要 |
| --- | --- |
| 单元测试 | 只需要 Node.js |
| 浏览器测试 | [Playwright](https://playwright.dev/) 和 Chromium |
| 真实视频测试 | Chrome，并设置 `BTR_TEST_BVID` 和 `BTR_TEST_CID` |

没装 Playwright 时浏览器测试会显示 FAIL，不影响单元测试；提 PR 后自动测试会把全部测试跑一遍。

在本地安装 Playwright，方式和自动测试一样，不会改动 `package.json`：

```bash
npm install --no-save --package-lock=false playwright
npx playwright install chromium
```

仓库没有忽略 `node_modules/`，装完不要把它提交上来。Linux 上可以用 `npx playwright install --with-deps chromium` 把系统依赖一起装上。

| 环境变量 | 用途 |
| --- | --- |
| `NODE_PATH` | Playwright 装在别处时，它所在的 node_modules |
| `BTR_CHROME_PATH` | 改用已安装的 Chrome，填可执行文件的完整路径 |
| `BTR_TEST_BVID`、`BTR_TEST_CID` | 两个都设置才跑真实视频测试。必须用 Chrome，Playwright 自带的 Chromium 放不了 AAC 和 H.264。CID 可以从 `https://api.bilibili.com/x/player/pagelist?bvid=<BV 号>` 返回的 `data[0].cid` 查到 |

### 添加测试

修 bug 或加功能时，请在 `dev/` 里加上对应的测试，写法参考现有的测试：

- **单元测试**：`dev/<名字>-test.js`，不开浏览器。加进 `dev/run-tests.js` 的 `unit` 列表。
- **页面测试**：`dev/<名字>-test.html`，在本地页面上模拟 B 站播放器。页面跑完后把 JSON 结果写进一个元素（其中 `pass` 为 `true`），并给这个元素设 `data-pass="true"`。加进 `dev/regression-smoke-test.js` 的 `tests` 列表。

## 代码约定

BTR 只做一件事：把用户本来就能看的视频下得更快。以下改动不会被合并：

- 绕过会员、登录、地区、清晰度、审核状态、数字版权保护或媒体签名限制；
- 遥测，或者把用户的任何数据传到别处。

其他约定：

- **不加依赖**。运行和构建没有任何依赖。
- **不要手改生成的文件**：`user_scripts/bilibili-thread-ripper.user.js` 和 `canary/` 里的脚本。
- **不要手改版本号**：源码里写的是 `__BTR_VERSION__` 和 `__BTR_CHANNEL__`，构建时才替换成真实的值。

`src/` 里的 range-core、cdn-resolver、idm-downloader、native-range-transport、runtime-notices、diagnostic-report、settings-panel、stats-panel 这 8 个文件桌面版也在用，合并后由维护者同步过去。

改动比较大，或者不确定方向，请先开一个 issue 讨论。

## 提交 PR

1. **写更新日志**。在 `CHANGELOG.md` 的 `## [Unreleased]` 下面加一条，放在 `### 新增`、`### 变更` 或 `### 修复` 里，写用户能感觉到的变化，结尾注明 `（@你的用户名，#PR 号）`。PR 号可以在发起 PR 之后补上。
2. **自查**：
   
   - `npm test` 通过；
   - 只改了源码和测试，没有手改生成的文件；
   - 没有新增依赖。
3. **提交并推送**。commit message 写清楚改了什么即可，中英文都可以，没有格式要求。

   ```bash
   git add src dev CHANGELOG.md
   git commit -m "修复全接管下切换清晰度后进度丢失的问题"
   git push -u origin fix/quality-switch
   ```

4. **发起 PR**，目标分支是 `main`。描述里写清楚改了什么、为什么改、怎么验证的；修的是某个 issue，就写上 `Fixes #编号`。
5. **等自动测试**。GitHub Actions 会跑离线测试和真实 B 站视频的测试，结果显示在 PR 页面上。第一次提 PR 需要维护者批准后才开始跑。

## 合并之后

- main 上的测试通过后，Canary 自动更新。
- 正式版由维护者发布，你写的更新日志会出现在那一版的发布说明里。
