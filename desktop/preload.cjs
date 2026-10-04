const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('InnerGameDesktop', {
  captureHand: () => ipcRenderer.invoke('innergame:capture-hand')
});
