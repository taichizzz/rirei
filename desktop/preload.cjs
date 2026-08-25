/* global require */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relay', {
  selectProject: () => ipcRenderer.invoke('relay:select-project'),
  command: (request) => ipcRenderer.invoke('relay:command', request),
  usage: (request) => ipcRenderer.invoke('relay:usage', request),
  setActiveProject: (project) =>
    ipcRenderer.send('relay:set-active-project', project),
  dashboard: (request) => ipcRenderer.invoke('relay:dashboard', request),
  history: (request) => ipcRenderer.invoke('relay:history', request),
  checkpoints: (request) => ipcRenderer.invoke('relay:checkpoints', request),
  checkpointDiff: (request) =>
    ipcRenderer.invoke('relay:checkpoint-diff', request),
  agentCatalog: (request) => ipcRenderer.invoke('relay:agent-catalog', request),
  interactive: (request) => ipcRenderer.invoke('relay:interactive', request),
  openShell: (request) => ipcRenderer.invoke('relay:shell', request),
  workspaceList: (request) =>
    ipcRenderer.invoke('relay:workspace-list', request),
  workspaceCreate: (request) =>
    ipcRenderer.invoke('relay:workspace-create', request),
  terminalInput: (terminalId, data) =>
    ipcRenderer.send('relay:terminal-input', { terminalId, data }),
  terminalAttention: (terminalId) =>
    ipcRenderer.send('relay:terminal-attention', { terminalId }),
  resizeTerminal: (terminalId, size) =>
    ipcRenderer.send('relay:terminal-resize', { terminalId, size }),
  stopTerminal: (terminalId) =>
    ipcRenderer.invoke('relay:terminal-stop', { terminalId }),
  interruptTerminal: (terminalId) =>
    ipcRenderer.invoke('relay:terminal-interrupt', { terminalId }),
  closeTerminal: (terminalId) =>
    ipcRenderer.invoke('relay:terminal-close', { terminalId }),
  hideTerminal: (terminalId) =>
    ipcRenderer.invoke('relay:terminal-hide', { terminalId }),
  showTerminalTab: (terminalId) =>
    ipcRenderer.invoke('relay:terminal-show', { terminalId }),
  acknowledgeTerminalOutput: (terminalId, cursor) =>
    ipcRenderer.send('relay:terminal-output-ack', { terminalId, cursor }),
  terminalInventory: () => ipcRenderer.invoke('relay:terminal-inventory'),
  rendererReady: () => ipcRenderer.send('relay:renderer-ready'),
  onTerminalData: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('relay:terminal-data', listener);
    return () => ipcRenderer.removeListener('relay:terminal-data', listener);
  },
  onTerminalStatus: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('relay:terminal-status', listener);
    return () => ipcRenderer.removeListener('relay:terminal-status', listener);
  },
  onTerminalExit: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('relay:terminal-exit', listener);
    return () => ipcRenderer.removeListener('relay:terminal-exit', listener);
  },
  onUsageUpdate: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('relay:usage-update', listener);
    return () => ipcRenderer.removeListener('relay:usage-update', listener);
  },
  onDeepLink: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('relay:deep-link', listener);
    return () => ipcRenderer.removeListener('relay:deep-link', listener);
  },
  activity: (request) => ipcRenderer.invoke('relay:activity', request),
});
