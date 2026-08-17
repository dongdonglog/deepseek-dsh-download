# Changelog

本项目所有可下载产物（离线包、安装包）均发布在 [GitHub Releases](https://github.com/dongdonglog/deepseek-dsh-download/releases)。

## [Unreleased]

### Added

- DSH Launcher 桌面引导应用（Electron）：自动下载离线包、sha256 校验、一键启动 `dsh web`。
- 离线包构建工具 `tools/build-offline.mjs`（darwin-arm64 / darwin-x64 / win32-x64）。
- GitHub Actions 发布流水线（build-offline / build-app）。
- 捆绑 Node.js 24 LTS（满足 DSH 对 `node:zlib` zstd API ≥22.19 的要求）。
- 镜像回退（GitHub 直连 / ghproxy / 自定义镜像）、断点续传、本地离线包模式。

### Known limitations

- 应用安装包未做代码签名（macOS 需右键打开、Windows SmartScreen 需放行）。
- 暂不支持 Windows ARM64。
