# GitHub 仓库介绍与上架清单

本文件是「推送之后在 GitHub 网页上要填什么」的现成文案，可直接复制粘贴。仓库内的 `README.md` 是完整项目说明，`docs/index.html` 是可开启 GitHub Pages 的单页介绍站。

## 1. 仓库基本信息（Settings → General → About）

**Description（≤ 350 字，直接复制）**

```
Windows 托盘实时系统监控：网速 / 整机功率 / CPU / 内存 / 磁盘 / 温度 / GPU，右键切换类型，左键弹出详情面板。Electron + 纯 Node 采集，零原生依赖，完全本地运行不上传数据。
```

**Website**：推送并开启 Pages 后填 `https://<用户名>.github.io/<仓库名>/`

**Topics（建议 10 个）**

```
electron, windows, tray, system-monitor, desktop-app, nodejs,
network-speed, power-monitoring, hardware-monitor, open-source
```

**勾选**：`Releases`、`Packages`（可选）、`Discussions`（可选）。

## 2. 首个 Release 说明（v1.0.0）

标题：`v1.0.0 — 托盘实时系统监控`

正文：

```
TrayMetrics 首个正式版本。托盘图标一次显示一种指标，右键切换，左键弹出详情面板。

包含
- 7 类指标：网速 / 整机功率 / CPU / 内存 / 磁盘 / 温度 / GPU
- 整机功率实测优先（RAPL / Power Meter / nvidia-smi），无传感器时估算并自动校准
- 高 DPI 清晰字体图标、任务栏深浅色自适应、开机自启、单实例
- 完全本地运行，不联网、不上传任何数据

下载
- TrayMetrics-1.0.0-Portable.exe：免安装单文件版，双击即用
- TrayMetrics-1.0.0-Setup.exe：NSIS 安装包，带开始菜单 / 桌面快捷方式 / 卸载

说明
- 仅 Windows 10/11 x64
- 未做商业代码签名，首次运行 SmartScreen 提示「未知发布者」时选「更多信息 → 仍要运行」
- 温度 / GPU 明细需要可选的 LibreHardwareMonitor（Web Server :8085）或 NVIDIA 驱动，其余指标开箱即用
- 打 v* 标签会由 GitHub Actions 自动构建并附加这两个 exe 到 Release
```

## 3. 开启介绍页（Settings → Pages）

- Source：`Deploy from a branch`
- Branch：`main` → 目录选 `/docs` → Save
- 几秒后即可访问 `https://<用户名>.github.io/<仓库名>/`

`docs/index.html` 里的 `OWNER/REPO` 占位符会在执行 `push-to-github.ps1` 时自动替换成真实仓库地址；若是手动推送，全局替换一次即可。

## 4. 推送步骤（本机一键）

1. GitHub 新建**空仓库**（不要勾 Add a README / .gitignore / License）。
2. 生成 Fine-grained PAT：仅授权该仓库，权限 `Contents: Read & Write`（classic token 用 `repo`）。
3. 在项目根目录执行：

```powershell
$env:GITHUB_TOKEN = 'github_pat_xxx'
.\push-to-github.ps1 -RepoUrl 'https://github.com/<用户名>/<仓库名>.git'
```

脚本会自动：把 `docs/index.html` 的仓库占位符替换成真实地址 → 提交 → 本地分支改名为 `main` → 设置 remote → 用一次性 HTTP header 推送（Token 不写入 `.git/config`）。

4. 发布带 exe 的 Release：

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions 会自动在 windows-latest 上 `npm ci && npm run dist`，把两个 exe 附加到 Release。

## 5. 上传后自检

- [ ] README 里 3 张图片正常显示（`icon-preview.png`、`docs/screenshot-*.png`）
- [ ] About 的 Description / Website / Topics 已填
- [ ] Pages 介绍页可访问，下载按钮指向正确的 Releases 地址
- [ ] `v1.0.0` 的 Actions 构建通过，Release 里有两个 exe
- [ ] License 被识别为 MIT
