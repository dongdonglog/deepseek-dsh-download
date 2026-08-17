# DeepSeek Harness 离线下载包 & 桌面引导应用

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/dongdonglog/deepseek-dsh-download)](https://github.com/dongdonglog/deepseek-dsh-download/releases)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-blue)](#下载)
![离线包](https://img.shields.io/badge/离线包-约100MB-lightgrey)

> 有些用户无法执行 `npx @deepseek-ai/dsh web`（没有 Node、或 npm 网络不通）。
> 本仓库提供 **DeepSeek Harness (dsh) 的离线下载包** 和 **Windows / macOS 桌面引导应用**：
> 安装应用后自动下载对应平台的离线包，一键启动，效果与 `npx @deepseek-ai/dsh web` 完全一致，**无需安装 Node / npm**。

---

## 📦 下载

所有安装包与离线包都发布在 **[GitHub Releases](https://github.com/dongdonglog/deepseek-dsh-download/releases/latest)**。

### 桌面应用（推荐，普通用户用这个）

| 平台 | 架构 | 安装包 |
|---|---|---|
| macOS | Apple Silicon (M1/M2/M3/M4) | `DSH Launcher-<版本>-arm64.dmg` |
| macOS | Intel | `DSH Launcher-<版本>-x64.dmg` |
| Windows | 64 位 | `DSH Launcher Setup <版本>.exe` |

首次打开未签名应用的提示：

- **macOS**：右键（或按住 Control 点击）应用图标 → **打开**；若提示"无法验证开发者"，到 系统设置 → 隐私与安全性 → **仍要打开**。
- **Windows**：SmartScreen 提示时点 **更多信息 → 仍要运行**。

### 离线包（给引导应用用的数据包，一般不需要手动下载）

| 平台 | 架构 | 文件 |
|---|---|---|
| macOS | Apple Silicon | `dsh-offline-darwin-arm64-<dsh版本>.zip` |
| macOS | Intel | `dsh-offline-darwin-x64-<dsh版本>.zip`（需先运行 build-offline-x64 workflow 追加） |
| Windows | 64 位 | `dsh-offline-win32-x64-<dsh版本>.zip` |

> 当前捆绑：`@deepseek-ai/dsh 0.1.0-rc.6` + Node.js 24 LTS，包体约 100MB。

---

## 🚀 快速开始

1. 从 [Releases](https://github.com/dongdonglog/deepseek-dsh-download/releases/latest) 下载对应平台的安装包并安装。
2. 打开应用，会自动开始下载离线包并显示进度。
3. 下载完成后自动启动，浏览器会打开 DeepSeek Harness 界面（`http://127.0.0.1:3080`）。
4. 关闭窗口 = 最小化到托盘，服务继续运行；托盘菜单可退出。

网络不好？应用内置镜像自动回退（GitHub 直连 → ghproxy 加速），下载中断自动断点续传、sha256 自动校验。

### 完全离线分发（U 盘 / 网盘 / 内网）

把对应平台的 `dsh-offline-*.zip` 拷给用户，在应用里点 **"使用本地离线包…"** 选择该文件，即可跳过下载直接启动。

---

## ❓ 常见问题

| 问题 | 处理 |
|---|---|
| 提示"所有镜像都无法获取版本清单" | 检查网络；应用设置里切换镜像；或用"使用本地离线包" |
| 下载到一半断网 | 自动断点续传，重试即可 |
| 端口 3080 被占用 | 应用自动尝试 3081、3082…，也可在设置里改"起始端口" |
| 想换工作目录 | 应用设置 → 选择…（DSH 的会话/产物保存在工作目录下） |
| 想清理旧版本占用的磁盘 | 删除 `~/Library/Application Support/DSH Launcher/bundles/`（macOS）或 `%APPDATA%\DSH Launcher\bundles\`（Windows）里的旧目录，保留当前版本 |

---

## 🛠 开发者 / 构建离线包

构建工具、CI 发布流程、本地测试见 **[DEVELOPMENT.md](DEVELOPMENT.md)**。

## 📄 许可

MIT © dongdonglog。DeepSeek Harness 本体版权归其各自作者所有。
