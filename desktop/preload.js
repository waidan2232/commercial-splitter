'use strict';
// The few things the desktop window can do that a web page can't: system file dialogs, showing a file in the file
// manager, and getting the path of a dropped file.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  openFiles: (defaultPath) => ipcRenderer.invoke('open-files', defaultPath),
  chooseFolder: (defaultPath) => ipcRenderer.invoke('choose-folder', defaultPath),
  showItemInFolder: (file) => ipcRenderer.invoke('show-item', file),
  pathForFile: (file) => webUtils.getPathForFile(file),
  initialFiles: () => ipcRenderer.invoke('initial-files'),
  onOpenFiles: (callback) => ipcRenderer.on('open-files', (e, files) => callback(files)),
});
