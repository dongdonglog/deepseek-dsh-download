# dsh-download — DeepSeek Harness 桌面引导应用 + 离线包

> 解决「部分用户无法 `npx @deepseek-ai/dsh web`」的问题：提供一个 **Windows / macOS 桌面引导应用**，自动下载本仓库构建的 **DSH 离线包**，校验、解压后以与 npx **完全一致**的方式启动 `dsh web`（同一套 DSH 代码、同一个 `~/.dsh`、同一个浏览器界面）。

用户不需要安装 Node / npm，不需要能访问 npm registry。断网、弱网、被墙都能用。

---

## 目录

- [工作原理](#工作原理)
- [仓库结构](#仓库结构)
- [开发者指南](#开发者指南)
- [发布流程（GitHub Actions）](#发布流程github-actions)
- [用户使用指南](#用户使用指南)
- [常见问题](#常见问题)
- [已知限制](#已知限制)

---

## 工作原理

```
┌─────────────────────── DSH Launcher (Electron 桌面应用) ───────────────────────┐
│ 启动 → 镜像链拉取 latest.json → 选当前平台离线包 → 断点续传下载 → sha256 校验  │
│      → 解压到用户目录 → spawn: <node> <dsh>/lib/bin.js --profile web --port N  │
│      → 轮询 URL 就绪 → 浏览器打开 http://127.0.0.1:<port>                       │
└─────────────────────────────────────────────────────────────────────────────────┘
                              ▲ 下载（GitHub Releases / ghproxy / 自定义镜像）
        ┌─────────────────────┴──────────────────────┐
        │ 本仓库 GitHub Releases（离线包托管在这里）   │
        │  dsh-offline-darwin-arm64-<版本>.zip         │
        │  dsh-offline-darwin-x64-<版本>.zip           │
        │  dsh-offline-win32-x64-<版本>.zip            │
        └──────────────────────────────────────────────┘
```

**离线包内容**（每平台一个 zip，约 90–120MB）：

```
dsh-offline-<platform>-<arch>-<dshVersion>.zip
├── node/node 或 node/node.exe        # 捆绑的 Node 24 LTS 运行时
├── app/                             # @deepseek-ai/dsh 及其完整依赖树（按平台裁剪）
│   ├── package.json
│   └── node_modules/                # 与 npx 安装完全同构，已删去其他平台的原生包
└── manifest.json                    # 版本与校验信息
```

启动命令与 `npx @deepseek-ai/dsh web` 逐字等价：
`<bundle>/node/bin/node <bundle>/app/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port <N>`
工作目录默认用户主目录（可在应用内修改），`DSH_HOME` 保持默认 `~/.dsh` —— 已有 npx 用户的配置无缝复用。

---

## 仓库结构

```
config.json                   # 唯一配置源：owner / repo / dshVersion / nodeVersion / npmRegistry
latest.json                   # 版本清单（CI 生成并提交；应用据此下载）
tools/
  build-offline.mjs           # 构建离线包（纯 Node，无第三方依赖）
  sync-app-config.mjs         # config.json → app/local/bundle.json
  gen-latest.mjs              # 汇总各平台 zip 生成 latest.json
  smoke.mjs                   # 离线包冒烟测试（dump-config + 原生依赖加载）
  zipwriter.mjs               # 纯 Node zip 写入器（保留可执行位、UTF-8 文件名）
  test-app-local.mjs          # 应用纯 Node 模块的本地测试（下载/续传/端口/设置）
app/                          # Electron 应用（DSH Launcher）
  main.js                     # 主进程：状态机 / 下载 / 解压 / spawn / 托盘
  preload.js                  # contextBridge 白名单 IPC
  renderer/                   # 中文单页 UI
  local/                      # 纯 Node 模块：settings / downloader / launcher（可单测）
  local/bundle.json           # 生成物（由 sync-app-config.mjs 生成）
.github/workflows/
  build-offline.yml           # 矩阵构建 3 平台离线包 → GitHub Release + latest.json
  build-app.yml               # electron-builder 构建 mac/win 安装包 → 同一 Release
offline/                      # 本地构建产物输出（gitignore）
```

---

## 开发者指南

前置：Node ≥ 20（构建工具本身），npm。

```bash
# 1) 本地构建离线包（当前平台/架构）
node tools/build-offline.mjs --platform darwin --arch arm64

# 2) 冒烟测试（解压后验证）
rm -rf /tmp/bundle && mkdir -p /tmp/bundle
unzip -q offline/dsh-offline-darwin-arm64-0.1.0-rc.6.zip -d /tmp/bundle
node tools/smoke.mjs /tmp/bundle

# 3) 应用纯 Node 模块测试
node tools/test-app-local.mjs

# 4) 运行桌面应用（开发模式）
cd app && npm install && npm start

# 5) 打包安装包
cd app && npm run dist:mac   # dmg（arm64 + x64）
cd app && npm run dist:win   # NSIS exe（x64）
```

构建工具参数：`--platform darwin|win32`、`--arch arm64|x64`、`--dsh-version`、`--node-version`、`--registry <npm镜像>`（如 `https://registry.npmmirror.com`）。

> 提示：构建工具使用**项目内 npm 缓存**（`tools/.cache/`），不会触碰你的全局 `~/.npm`（避免 root 权限问题，也保证可复现）。

---

## 发布流程（GitHub Actions）

1. 在 `config.json` 里填好你的 GitHub 用户名（`owner`），确认 `repo` / `dshVersion` / `nodeVersion`。
2. 仓库 Settings → Actions → General → 勾选 **Workflow permissions: Read and write permissions**（release job 需要写 latest.json 和创建 Release）。
3. 手动运行 **build-offline** workflow：填 `dshVersion`、`nodeVersion`、`tag`（如 `v1.0.0`）。
   - 矩阵在各自平台构建离线包 → 冒烟 → 汇总生成并提交 `latest.json` → 创建 Release 并上传 3 个 zip。
4. 手动运行 **build-app** workflow：填同一个 `tag`。
   - 构建 macOS dmg / Windows exe 并追加到同一 Release。

之后用户只需安装应用，应用自动从该 Release 下载对应平台离线包。**DSH 版本升级**：改 `config.json` 的 `dshVersion`，重跑 build-offline 即可，用户下次启动应用自动发现新版本（无需重装应用）。

---

## 用户使用指南

1. 从 Release 下载安装包：
   - **macOS**：`DSH Launcher-1.0.0-arm64.dmg`（Apple Silicon）或 `-x64.dmg`（Intel）。拖入 Applications。
   - **Windows**：`DSH Launcher Setup 1.0.0.exe`（x64）。
2. 首次打开：
   - macOS 未签名应用：右键（或按住 Control 点击）图标 → **打开**；若提示"无法验证开发者"，到 系统设置 → 隐私与安全性 → 仍要打开。
   - Windows SmartScreen：点 **更多信息 → 仍要运行**。
3. 应用会自动开始下载离线包（显示进度），完成后自动打开浏览器进入 DeepSeek Harness 界面（`http://127.0.0.1:3080`）。
4. 关闭窗口 = 最小化到托盘，DSH 服务继续运行；托盘菜单里可退出。

**网络不好的用户**：
- 应用内置镜像自动回退（GitHub 直连 → ghproxy 加速）。
- 可在"设置"里手动切换镜像，或填**自定义镜像前缀**——你的镜像需要自行托管 `latest.json` 与各平台 zip（应用会从 `<前缀>/latest.json` 拉取版本清单，并按清单里的相对路径下载 zip），适合公司代理 / 校园网加速器 / 自建 CDN。
- 下载中断会自动断点续传，sha256 校验失败会自动重下。

**完全离线分发（U 盘 / 网盘 / 内网）**：
- 把对应平台的 `dsh-offline-*.zip` 拷给用户；
- 用户在应用里点 **"使用本地离线包…"** 选择该 zip，即可跳过下载直接启动。

---

## 常见问题

| 问题 | 处理 |
|---|---|
| 一直提示"所有镜像都无法获取版本清单" | 检查网络；切换镜像；或用"使用本地离线包" |
| 下载到一半断网 | 自动断点续传，重试即可 |
| sha256 校验失败 | 自动删除损坏文件重下；多次失败检查磁盘空间 |
| 端口 3080 被占用 | 应用自动尝试 3081、3082…；或改"起始端口" |
| DSH 启动即退出 | 查看日志区；确认 `~/.dsh` 配置没有损坏；可删掉 `~/.dsh` 重试（注意备份） |
| 想换工作目录 | 设置 → 选择…（DSH 的会话/产物保存在工作目录下） |
| 老版本离线包占用磁盘 | 删除 `~/Library/Application Support/DSH Launcher/bundles/` 或 `%APPDATA%/DSH Launcher/bundles/` 里的旧目录（保留当前版本） |

---

## 已知限制

- 首版目标平台：**macOS arm64 / x64 + Windows x64**（win32-arm64 未打包）。
- 应用安装包**未做代码签名**（macOS Gatekeeper、Windows SmartScreen 需用户手动放行；预留了签名配置位，有证书后可直接接入）。
- **应用自身**不提供自动更新（electron-builder autoUpdater 依赖签名）；离线包版本可自动更新。新版应用需重新下载。
- 离线包**不提交进 git**（体积大），托管于本仓库 GitHub Releases；`latest.json` 提交到 main。
- 捆绑 **Node 24 LTS**。注意：当前 DSH 依赖 `node:zlib` 的 zstd API（Node ≥22.19 才有）与 `node:sqlite`（≥22.5），因此捆绑版本不能低于 22.19；版本号集中在 `config.json`，升级 DSH 时若报缺 API 就抬 Node 版本。
