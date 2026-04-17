import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  onForceStop: (callback: () => void) => {
    ipcRenderer.on('force-stop', callback)
  },
  offForceStop: (callback: () => void) => {
    ipcRenderer.removeListener('force-stop', callback)
  },
  setLaunchAtStartup: (openAtLogin: boolean) =>
    ipcRenderer.send('set-launch-at-startup', openAtLogin),
  getLaunchAtStartup: () =>
    ipcRenderer.invoke('get-launch-at-startup'),
  toggleMini: (isMini: boolean) =>
    ipcRenderer.send('toggle-mini', isMini)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
