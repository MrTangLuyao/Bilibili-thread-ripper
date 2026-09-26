# 油猴脚本

装好 [Tampermonkey](https://www.tampermonkey.net/)，然后点：[**安装线程撕裂者**](https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper/main/user_scripts/bilibili-thread-ripper.user.js)

设置：点油猴图标 → 线程撕裂者设置

- `bilibili-thread-ripper.user.js`：脚本本体，发版时由 `scripts/release.mjs` 生成，别手改
- `adapter/`：`storage-shim.js` 把设置存到脚本管理器里（所有 B 站子域共用），`loader.js` 负责启动，`meta.json` 是脚本头和打包顺序
