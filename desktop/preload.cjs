/* global require */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relay', {
  selectProject: () => ipcRenderer.invoke('relay:select-project'),
  command: (request) => ipcRenderer.invoke('relay:command', request),
  usage: (request) => ipcRenderer.invoke('relay:usage', request),
  dashboard: (request) => ipcRenderer.invoke('relay:dashboard', request),
  agentCatalog: (request) => ipcRenderer.invoke('relay:agent-catalog', request),
  interactive: (request) => ipcRenderer.invoke('relay:interactive', request),
  terminalInput: (data) => ipcRenderer.send('relay:terminal-input', data),
  resizeTerminal: (size) => ipcRenderer.send('relay:terminal-resize', size),
  stopTerminal: () => ipcRenderer.invoke('relay:terminal-stop'),
  onTerminalData: (callback) =>
    ipcRenderer.on('relay:terminal-data', (_event, data) => callback(data)),
  onTerminalExit: (callback) =>
    ipcRenderer.on('relay:terminal-exit', (_event, result) => callback(result)),
});
