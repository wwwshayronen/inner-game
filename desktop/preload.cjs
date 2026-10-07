const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('InnerGameDesktop', {
  captureHand: () => ipcRenderer.invoke('innergame:capture-hand'),
  setAutoScreenshotEnabled: (payload) => ipcRenderer.invoke('innergame:set-auto-screenshot-enabled', payload),
  enqueueHandJob: (payload) => ipcRenderer.invoke('innergame:enqueue-hand-job', payload),
  ackHandJob: (payload) => ipcRenderer.invoke('innergame:ack-hand-job', payload),
  cancelHandJobs: (payload) => ipcRenderer.invoke('innergame:cancel-hand-jobs', payload),
  notifyHand: (payload) => ipcRenderer.invoke('innergame:notify-hand', payload)
});
