'use strict';
// electron-builder 配置。
// 注意：sign 是「win.sign」子项（根级没有 sign 属性），用 no-op 覆盖默认 Authenticode 签名，
// 从而彻底跳过 winCodeSign 工具链（本机无代码签名证书，未签名 exe 本地/个人使用无碍）。
// electronDist 指向本地已下载的 electron 运行时，避免联网下载。
const path = require('path');

module.exports = {
  appId: 'com.traymetrics.app',
  productName: 'TrayMetrics',
  copyright: 'Copyright © 2026',
  icon: 'assets/icon.ico',
  electronDist: path.join(__dirname, 'node_modules/electron/dist'),
  files: [
    'src/**/*',
    'assets/**/*',
    'package.json'
  ],
  win: {
    // 一次构建同时产出 NSIS 安装包和免安装便携版，二者复用同一份 win-unpacked。
    // 注：若从注入了 ELECTRON_RUN_AS_NODE=1 的终端（如 WorkBuddy 会话）直接启动产物，
    // Electron 会被当成纯 Node 运行，表现为「退出码 0、main.js 未加载」——与打包无关，
    // 去掉该环境变量后即可正常运行；用户双击启动不受影响。
    target: ['nsis', 'portable'],
    // 无证书：用空操作覆盖默认签名流程；并关闭「写回 exe / DLL 签名」，
    // 从而彻底不拉取 winCodeSign 工具链（本机无代码签名证书）
    sign: async () => { /* no-op: do not sign */ },
    signAndEditExecutable: false,
    signDlls: false
  },
  portable: {
    artifactName: 'TrayMetrics-${version}-Portable.${ext}'
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'TrayMetrics',
    artifactName: 'TrayMetrics-${version}-Setup.${ext}'
  }
};
