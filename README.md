# Codex 皮肤

给 Codex 桌面版加壁纸，并在「设置 → 外观」页追加「皮肤」面板。
常驻后台脚本跟随 Codex：Codex 启动即注入，Codex 退出不占资源，Codex 重开自动再接上。

## 安装

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

注册计划任务 `Codex Skin Host`：登录后 30 秒起一次，之后每分钟兜底拉起一次。
宿主本身常驻、单实例（互斥锁），重复触发直接退出，不会起第二个。
**再跑一次同一条命令 = 重启宿主**：它会先杀掉旧宿主再注册，因为新进程在互斥锁上会直接认输退出。
**不需要改启动方式**：开始菜单、任务栏、`codex://` 随便怎么开 Codex 都生效。

卸载：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

## 用

1. 启动 Codex（任意方式）。
2. `Ctrl+,` → 设置 → 左侧「外观」→「高级」下面就是「皮肤」（紧贴那条分割线，卡片固定 16:9，宽度占内容区 72%）。
   面板内字号跟外观页的其它行对齐（正文 13px / 字重 500 的标签、14px 的区块标题），不是另起一套。
3. 左边是壁纸槽位（2 列 × 3 行），一开始**全是空的**，没有自带壁纸：点任意槽位或它的 `+` 导入自己的图（PNG / JPG / WEBP，≤64MB），再点槽位切换当前壁纸。
   标题后紧跟的开关控制整个皮肤：关掉立刻回到原生主题，面板留灰但不会消失（不然关了就找不回来）。
4. 右边是 8 个滑杆，单列排布，实时生效并自动保存（IndexedDB 存图，localStorage 存参数）。
   键盘可用：Tab 走到槽位，Enter / 空格 切换或导入；滑杆是原生 range，方向键调值；开关是 `role="switch"`。
   导入失败（超过 64MB、格式不支持、本地存储写满）会在面板底部红字说明原因，不再静默失败。
5. 「恢复默认」只重置 8 个滑杆；槽位右上角垃圾桶删除该壁纸；删掉当前壁纸 = 回到原生主题。

## 更新

面板标题行右侧有「检查更新」按钮，点一下会：

1. 把请求写进 `localStorage`，宿主在 4 秒内读走；
2. 宿主用这台机器的 git 凭据执行 `git fetch` + `git merge --ff-only origin/main`；
3. 拉到新提交就把新的 `skin.js` 热替换进去，面板当场变成新版本，不用重启 Codex；
4. 按钮最后显示「已是最新」「已更新 x.y.z」或「更新失败」，悬停看具体原因。

几个前提：

- 仓库是私有的，面板所在的渲染进程没法匿名读它，所以真正干活的是宿主进程（`skin-host.ps1`），不是面板。
- 只有能快进才拉。本地有未提交改动、或远端被强推过，都会失败，按钮变红，原因写进 `skin-host.log`。
- **`skin-host.ps1` 自身的更新不能热生效**：拉到了也只会提醒你跑一次 `install.ps1`。
- 拉到的新 `skin.js` 若注入失败，宿主会把旧文件 checkout 回来并重新注入，面板不会消失。
- 这等于让本机自动执行远端代码。仓库目前只有你自己能推；哪天仓库被共享或转公开，这个按钮就是一条远程代码执行通道。

## 依赖与风险

- 依赖 CDP 端口 9229。它来自用户级环境变量 `BUILD_FLAVOR=dev` + `CODEX_ELECTRON_CHROMIUM_SWITCHES`
  （由 `codex任务仪表盘\standalone\setup-env.ps1` 设置，路径按你的实际目录替换）。
  变量被清掉 → Codex 不开端口 → 宿主连不上，皮肤失效（Codex 本身不受影响）。
- 这也是一个**免认证的控制口**：本机任何进程都能 `GET /json/list` 拿到 target，再在这个渲染进程里跑任意 JS。
  共用电脑或不想长期开调试口时，把 `BUILD_FLAVOR` 去掉，皮肤会一起失效。
- 注入走 CDP 往 renderer 塞脚本，不改 app.asar、不动安装目录、不杀进程。
- Codex 更新后若 Tailwind 类名变了，壁纸透出可能失效，改 `skin.js` 里 `html.codex-skin-on` 那几条选择器。
- 「透明度」是**纯 alpha**：色温=0 时 100 = 与原图逐像素一致（用 1143×766 逐像素图案图验证，无 UI 覆盖处 100% 相同），50 = 与底色 `#14121a` 各半混。
  色温不为 0 时会叠一层 `soft-light` 色罩，那时 100 呈现的是「原图 + 色罩」。
- 缩放：100 = 按窗口比例 `cover` 铺满；**低于 100 图片按比例缩小、四周露出底色** `#14121a`；高于 100 才是放大裁切。
  窗口宽高比和图片不同时，`cover` 会裁掉多出来的那一边（壁纸的固有行为）。
- 模糊：CSS 的 `blur()` 不会把像素往外延展，边缘必须靠外扩一层来接住，所以外扩只加在「模糊层」`.cs-blur` 上；
  图像层始终按**视口**手算 `cover`，第二层同图 `cover` 只填外扩环。模糊半径怎么拉，取景都不变（旧版 40px 模糊会放大约 32%）。
- 代价：透明度拉满时壁纸不再被压暗，浅色壁纸上的文字可能不好读——需要时把透明度往下调（50 大致等于原生暗色调）。
- 面板是深色卡片，浅色主题下观感偏重（当前主题为深色，未做自适应）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `skin.js` | 注入载荷：壁纸层、透明化 CSS、外观页面板（16:9 + 皮肤开关）、持久化 |
| `skin-host.ps1` | CDP 宿主：常驻等 Codex → 附着 → 注入 → 断线/重载自动重连 |
| `skin-host.vbs` | 无窗口启动器（计划任务用 `wscript //B` 拉起，避免黑框） |
| `install.ps1` | 注册 / 卸载计划任务 |
| `skin-host.log` | 宿主日志（start / attached / injected / Codex exited） |

## 调试

```powershell
# 宿主在跑吗
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  ? { $_.CommandLine -like '*skin-host.ps1*' }

# 重启宿主（会先杀掉旧宿主；只注册不杀等于没重启）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

# 跑测试：滑杆映射往返、脏值兜底、对外接口清单
node --test skin.test.mjs

# 改了 skin.js 要生效：先改里面的 VERSION，再重启宿主 + 在 Codex 里 Ctrl+R
# 不 bump VERSION 的话新载荷会让位给旧实例，改动看不到
```
