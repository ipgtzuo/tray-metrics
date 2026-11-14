'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  onSnapshot: cb => ipcRenderer.on('snapshot', (_e, data) => cb(data)),
  setType: key => ipcRenderer.send('set-type', key),
  close: () => ipcRenderer.send('close-panel'),
  panelHeight: h => ipcRenderer.send('panel-height', h),
  request: listMode => ipcRenderer.send('request-snapshot', listMode)
});
// 系统信息窗口专用通道：先拿缓存秒开，再由主进程推送后台重新采集的结果
contextBridge.exposeInMainWorld('sysinfo', {
  get: force => ipcRenderer.invoke('sysinfo:get', !!force),
  onData: cb => ipcRenderer.on('sysinfo:data', (_e, data) => cb(data)),
  onLive: cb => ipcRenderer.on('sysinfo:live', (_e, data) => cb(data)),
  close: () => ipcRenderer.send('sysinfo:close')
});
