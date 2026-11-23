// Безопасный «мостик» между страницей и Windows.
// Странице доступна только одна вещь — открыть окно выбора папки.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liveClipper', {
  isDesktop: true,
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
});
