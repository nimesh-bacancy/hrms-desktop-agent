import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  onForceStop: (callback: () => void) => {
    require('electron').ipcRenderer.on('force-stop-tracking', callback)
  },
  offForceStop: (callback: () => void) => {
    require('electron').ipcRenderer.removeListener('force-stop-tracking', callback)
  },
  setLaunchAtStartup: (openAtLogin: boolean) => 
    require('electron').ipcRenderer.send('set-launch-at-startup', openAtLogin),
  getLaunchAtStartup: () => 
    require('electron').ipcRenderer.invoke('get-launch-at-startup'),
  toggleMini: (isMini: boolean) => 
    require('electron').ipcRenderer.send('toggle-mini', isMini)
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
