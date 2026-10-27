const { contextBridge, ipcRenderer } = require('electron')
const ok = ['log', 'state', 'meter', 'locked', 'remote', 'settings', 'caught']
contextBridge.exposeInMainWorld('af', {
  init: () => ipcRenderer.invoke('init'),
  activate: (k) => ipcRenderer.invoke('activate', k),
  set: (s) => ipcRenderer.send('set', s),
  start: () => ipcRenderer.send('start'),
  stop: () => ipcRenderer.send('stop'),
  test: () => ipcRenderer.send('test'),
  remote: () => ipcRenderer.invoke('remote'),
  adminLogin: (pw) => ipcRenderer.invoke('adminLogin', pw),
  admin: (p, b) => ipcRenderer.invoke('admin', p, b),
  link: () => ipcRenderer.invoke('link'),
  dashboard: () => ipcRenderer.invoke('dashboard'),
  fastquit: () => ipcRenderer.send('fastquit'),
  win: (a) => ipcRenderer.send('win', a),
  on: (c, cb) => ok.includes(c) && ipcRenderer.on(c, (_e, d) => cb(d))
})
