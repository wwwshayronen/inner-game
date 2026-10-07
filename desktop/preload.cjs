const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('InnerGameDesktop', {
  captureHand: () => ipcRenderer.invoke('innergame:capture-hand'),
  setAutoScreenshotEnabled: (payload) => ipcRenderer.invoke('innergame:set-auto-screenshot-enabled', payload),
  notifyHand: (payload) => ipcRenderer.invoke('innergame:notify-hand', payload)
});
