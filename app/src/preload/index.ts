import { contextBridge, ipcRenderer } from 'electron'
import type { BubbleApi, DeskatApi } from '../shared/types'

const api: DeskatApi = {
  getInit: () => ipcRenderer.invoke('overlay:init'),
  setClickThrough: (through) => ipcRenderer.send('overlay:click-through', through),
  moveBy: (dx) => ipcRenderer.send('overlay:move-by', dx),
  moved: () => ipcRenderer.send('overlay:moved'),
  getRoom: () => ipcRenderer.invoke('overlay:room'),
  showMenu: (items) => ipcRenderer.send('overlay:menu', items),
  onMenuAction: (cb) => {
    ipcRenderer.on('overlay:menu-action', (_e, id: string) => cb(id))
  },
  onSettingsChanged: (cb) => {
    ipcRenderer.on('overlay:settings', (_e, s) => cb(s))
  },
  onQuiet: (cb) => {
    ipcRenderer.on('overlay:quiet', (_e, q: boolean) => cb(q))
  },
  getSettingsData: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  connStatus: () => ipcRenderer.invoke('conn:status'),
  googleLoadClientFile: () => ipcRenderer.invoke('conn:google-client-file'),
  googleSetClient: (id, secret) => ipcRenderer.invoke('conn:google-client', id, secret),
  googleConnect: () => ipcRenderer.invoke('conn:google-connect'),
  googleDisconnect: () => ipcRenderer.invoke('conn:google-disconnect'),
  claudeSetKey: (key) => ipcRenderer.invoke('conn:claude-key', key),
  claudeTest: () => ipcRenderer.invoke('conn:claude-test'),
  testReminder: () => ipcRenderer.invoke('conn:test-reminder')
}

const bubble: BubbleApi = {
  onState: (cb) => {
    ipcRenderer.on('bubble:state', (_e, s) => cb(s))
  },
  ready: () => ipcRenderer.send('bubble:ready'),
  resize: (h) => ipcRenderer.send('bubble:resize', h),
  dismiss: (id) => ipcRenderer.send('bubble:dismiss', id),
  noticeAction: (id, a) => ipcRenderer.send('bubble:notice-action', id, a),
  send: (text) => ipcRenderer.send('bubble:send', text),
  attachClipboard: () => ipcRenderer.send('bubble:clip'),
  clipAction: (kind) => ipcRenderer.send('bubble:clip-action', kind),
  copy: (text) => ipcRenderer.send('bubble:copy', text),
  clearClip: () => ipcRenderer.send('bubble:clear-clip'),
  closeChat: () => ipcRenderer.send('bubble:close-chat'),
  newChat: () => ipcRenderer.send('bubble:new-chat')
}

contextBridge.exposeInMainWorld('deskat', api)
contextBridge.exposeInMainWorld('bubble', bubble)
