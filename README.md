# DeepSeek Harness 离线安装包（Windows / macOS）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/dongdonglog/deepseek-dsh-download)](https://github.com/dongdonglog/deepseek-dsh-download/releases)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-blue)](#下载)
![安装方式](https://img.shields.io/badge/安装方式-纯离线-lightgrey)

> 有些用户无法执行 `npx @deepseek-ai/dsh web`（没有 Node、或 npm 网络不通）。
> 本仓库提供 **DeepSeek Harness (dsh) 的离线安装包**：**离线包已内置在安装包里**，
> 下载安装 → 打开应用跟着向导点几步，全程**不联网**，效果与 `npx @deepseek-ai/dsh web` 完全一致，**无需安装 Node / npm**。

---

## 📦 下载

所有安装包都发布在 **[GitHub Releases](https://github.com/dongdonglog/deepseek-dsh-download/releases/latest)**。**安装包已内置对应平台的离线包（约 100MB），装完即用、无需再下载任何东西。**

| 平台 | 架构 | 安装包 |
|---|---|---|
| macOS | Apple Silicon (M1/M2/M3/M4) | `DSH.Launcher-<版本>-arm64.dmg` |
| macOS | Intel | `DSH.Launcher-<版本>.dmg` |
| Windows | 64 位 | `DSH.Launcher.Setup.<版本>.exe`（另有免安装版 `DSH.Launcher-<版本>-win.zip`） |

> 内置：`@deepseek-ai/dsh 0.1.0-rc.6` + Node.js 24 LTS（离线包也单独发布在 Releases，供 U 盘/网盘分发）。

首次打开未签名应用的提示：

- **macOS**：右键（或按住 Control 点击）应用图标 → **打开**；若提示"无法验证开发者"，到 系统设置 → 隐私与安全性 → **仍要打开**。
- **Windows**：SmartScreen 提示时点 **更多信息 → 仍要运行**。

---

## 🚀 发布新版（维护者）

**懒人流程：打一个 tag 推送，构建 + 发布全自动**（GitHub 上常见的 tag 触发式 release 模式）。

### 方式一：一条命令（推荐）

```bash
npm run release
```

脚本一步步引导：检查登录/仓库/工作区 → 选版本号 → 确认内容 → 打 tag 推送 → 等待构建完成 → 给出发布地址。

### 方式二：手动推 tag

```bash
git tag v1.1.0
git push origin v1.1.0
```

推送后 GitHub Actions 自动完成：构建 3 个平台离线包（含冒烟测试）→ **把对应平台的离线包打进安装包** → 发布 macOS dmg / Windows exe。

> 更新 DSH 版本：改 `config.json` 的 `dshVersion` 后再发布即可；不需要动应用代码。

---

## 🚀 快速开始（跟着向导点几步）

1. 从 [Releases](https://github.com/dongdonglog/deepseek-dsh-download/releases/latest) 下载对应平台的安装包并安装。
2. 打开 **DSH Launcher**，跟着安装向导点「下一步」：
   - **欢迎** → 点「开始安装」
   - **安装离线包** → 应用自动解压内置的离线包（几秒钟）
   - **启动** → 自动启动本地服务并打开浏览器
   - **完成** → DeepSeek Harness 界面（`http://127.0.0.1:3080`）已在浏览器打开
3. 整个过程**不联网**。关闭窗口 = 最小化到托盘，服务继续运行；托盘菜单可随时退出。

### 备用：用 U 盘 / 网盘里的离线包安装

如果内置离线包不可用，可在「安装离线包」一步点 **「选择本地离线包…」**，指定
`dsh-offline-<平台>-<架构>-<版本>.zip`（离线包单独发布在 Releases），同样全程离线。

---

## ❓ 常见问题

| 问题 | 处理 |
|---|---|
| 提示"没有找到离线包" | 用最新版安装包重装；或点「选择本地离线包…」指定离线包 zip |
| 端口 3080 被占用 | 应用自动尝试 3081、3082…，也可在高级设置里改"起始端口" |
| 想换工作目录 | 高级设置 → 选择…（DSH 的会话/产物保存在工作目录下） |
| 想清理旧版本占用的磁盘 | 删除 `~/Library/Application Support/DSH Launcher/bundles/`（macOS）或 `%APPDATA%\DSH Launcher\bundles\`（Windows）里的旧目录，保留当前版本 |
| 想升级 DSH 版本 | 下载新版本的安装包重新安装即可（离线包随安装包更新） |

---

## 🛠 开发者 / 构建离线包

构建工具、CI 发布流程、本地测试见 **[DEVELOPMENT.md](DEVELOPMENT.md)**。

## 📄 许可

MIT © dongdonglog。DeepSeek Harness 本体版权归其各自作者所有。
