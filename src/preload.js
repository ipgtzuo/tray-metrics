'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  onSnapshot: cb => ipcRenderer.on('snapshot', (_e, data) => cb(data)),
  setType: key => ipcRenderer.send('set-type', key),
  close: () => ipcRenderer.send('close-panel'),
  panelHeight: h => ipcRenderer.send('panel-height', h),
  request: listMode => ipcRenderer.send('request-snapshot', listMode)
});
