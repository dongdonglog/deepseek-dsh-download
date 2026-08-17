# 开发者文档（构建离线包 / 打包应用 / 发布）

> 普通用户请直接看 [README.md](README.md) 的「下载」与「快速开始」，不需要本文件。

## 目录结构

```
config.json                   # 唯一配置源：owner / repo / dshVersion / nodeVersion / npmRegistry
tools/
  build-offline.mjs           # 构建离线包（纯 Node，无第三方依赖）
  sync-app-config.mjs         # config.json → app/local/bundle.json
  gen-latest.mjs              # 汇总各平台 zip 生成 latest.json
  smoke.mjs                   # 离线包冒烟测试（dump-config + 原生依赖加载）
  zipwriter.mjs               # 纯 Node zip 写入器（保留可执行位、UTF-8 文件名）
  test-app-local.mjs          # 应用纯 Node 模块的本地测试
  test-app-e2e.mjs            # 端到端测试（真实离线包：下载→校验→解压→启动→就绪）
app/                          # Electron 桌面应用（DSH Launcher）
  main.js                     # 主进程：窗口 / 托盘 / IPC
  preload.js                  # contextBridge 白名单
  renderer/                   # 中文单页 UI
  local/                      # 纯 Node 模块：settings / downloader / launcher / runner
.github/workflows/
  build-offline.yml           # 矩阵构建 3 平台离线包 → GitHub Release + latest.json
  build-app.yml               # electron-builder 构建 mac/win 安装包 → 同一 Release
offline/                      # 本地构建产物输出（gitignore）
```

## 离线包内容

```
dsh-offline-<platform>-<arch>-<dshVersion>.zip
├── node/node 或 node/node.exe        # 捆绑的 Node 24 LTS 运行时
├── app/                             # @deepseek-ai/dsh 及完整依赖树（按平台裁剪）
│   ├── package.json
│   └── node_modules/                # 与 npx 安装同构，已删去其他平台原生包
└── manifest.json                    # 版本与校验信息
```

启动命令与 `npx @deepseek-ai/dsh web` 逐字等价：
`<bundle>/node/node <bundle>/app/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port <N>`

**注意 Node 版本下限**：当前 DSH 依赖 `node:zlib` 的 zstd API（Node ≥22.19）与 `node:sqlite`（≥22.5），捆绑版本不能低于 22.19；升级 DSH 若报缺 API，抬 `config.json` 的 `nodeVersion` 即可。

## 本地构建与测试

前置：Node ≥ 20（构建工具本身）。

```bash
# 构建离线包（当前平台/架构，默认用 config.json 里的 registry）
node tools/build-offline.mjs --platform darwin --arch arm64

# 冒烟测试（解压后验证 node / dsh boot / 原生模块）
rm -rf /tmp/bundle && mkdir -p /tmp/bundle
unzip -q offline/dsh-offline-darwin-arm64-0.1.0-rc.6.zip -d /tmp/bundle
node tools/smoke.mjs /tmp/bundle

# 应用纯 Node 模块单元测试
node tools/test-app-local.mjs

# 端到端测试（真实离线包，spawn 真 dsh web）
node tools/test-app-e2e.mjs --bundle-zip offline/dsh-offline-darwin-arm64-0.1.0-rc.6.zip

# 运行桌面应用（开发模式）
cd app && npm install && npm start

# 打包安装包
cd app && npm run dist:mac   # dmg（arm64 + x64）
cd app && npm run dist:win   # NSIS exe（x64）
```

构建工具参数：`--platform darwin|win32`、`--arch arm64|x64`、`--dsh-version`、`--node-version`、`--registry <npm镜像>`（如 `https://registry.npmmirror.com`）。

> 构建工具使用**项目内 npm 缓存**（`tools/.cache/`），不触碰全局 `~/.npm`；Node 运行时下载有 nodejs.org → npmmirror 自动回退。

## 发布流程（GitHub Actions）

1. `config.json` 填好 `owner` / `repo`，确认 `dshVersion` / `nodeVersion`。
2. 仓库 Settings → Actions → General → 勾选 **Workflow permissions: Read and write**（release job 需要写 `latest.json` 和创建 Release）。
3. 手动运行 **build-offline** workflow：填 `dshVersion`、`nodeVersion`、`tag`（如 `v1.0.0`）→ 矩阵在各平台构建离线包 → 冒烟 → 汇总生成并提交 `latest.json` → 创建 Release 上传 3 个 zip。
4. 手动运行 **build-app** workflow：填同一个 `tag` → 构建 macOS dmg / Windows exe 追加到同一 Release。

**DSH 版本升级**：改 `config.json` 的 `dshVersion` 重跑 build-offline 即可，用户下次启动应用自动发现新版本（无需重装应用）。

## 已知限制

- 首版平台：macOS arm64 / x64 + Windows x64（win32-arm64 未打包）。
- 应用安装包**未做代码签名**（macOS Gatekeeper、Windows SmartScreen 需用户手动放行）。
- 应用自身无自动更新（依赖签名）；离线包版本可自动更新。
- 离线包**不提交进 git**（体积大），托管于本仓库 GitHub Releases；`latest.json` 提交到 main。
