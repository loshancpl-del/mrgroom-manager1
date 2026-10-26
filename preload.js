'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const inv = (c, ...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld('mrg', {
  loadAllSync: () => ipcRenderer.sendSync('store:loadAll'),
  save: (k, v) => ipcRenderer.send('store:set', String(k), String(v)),
  backupNow: () => inv('backup:now'),
  chooseSecond: () => inv('backup:chooseSecond'),
  info: () => ipcRenderer.sendSync('backup:info'),
  drive: {
    status: () => inv('drive:status'), connect: e => inv('drive:connect', String(e)), disconnect: () => inv('drive:disconnect'),
    backupNow: () => inv('drive:backup'), list: () => inv('drive:list'), restore: id => inv('drive:restore', String(id))
  }
});
