import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

import type { CustomTab, DesktopApi, SaveSettingsInput } from '../shared/contracts'

const api: DesktopApi = {
  getAppState: () => ipcRenderer.invoke('app:get-state'),
  saveSettings: (input: SaveSettingsInput) => ipcRenderer.invoke('settings:save', input),
  clearStoredApiKey: () => ipcRenderer.invoke('settings:clear-api-key'),
  importMedia: () => ipcRenderer.invoke('media:import'),
  beginRecording: () => ipcRenderer.invoke('recording:begin'),
  appendRecordingChunk: (recordingId, chunk) =>
    ipcRenderer.invoke('recording:append', recordingId, chunk),
  finishRecording: (recordingId, mimeType) =>
    ipcRenderer.invoke('recording:finish', recordingId, mimeType),
  cancelRecording: (recordingId) => ipcRenderer.invoke('recording:cancel', recordingId),
  processJob: (jobId) => ipcRenderer.invoke('job:process', jobId),
  summarizeJob: (jobId) => ipcRenderer.invoke('job:summarize', jobId),
  exportJob: (jobId) => ipcRenderer.invoke('job:export', jobId),
  deleteJob: (jobId) => ipcRenderer.invoke('job:delete', jobId),
  renameJob: (jobId, newName) => ipcRenderer.invoke('job:rename', jobId, newName),
  getAudioUrl: (jobId) => ipcRenderer.invoke('job:get-audio-url', jobId),
  saveLastJobId: (jobId) => ipcRenderer.invoke('app:save-last-job', jobId),
  getGlossary: () => ipcRenderer.invoke('glossary:get'),
  addGlossaryEntry: (sourceTerm, targetTerm) =>
    ipcRenderer.invoke('glossary:add', sourceTerm, targetTerm),
  updateGlossaryEntry: (id, sourceTerm, targetTerm) =>
    ipcRenderer.invoke('glossary:update', id, sourceTerm, targetTerm),
  deleteGlossaryEntry: (id) => ipcRenderer.invoke('glossary:delete', id),
  importGlossaryCsv: () => ipcRenderer.invoke('glossary:import-csv'),
  exportGlossaryCsv: () => ipcRenderer.invoke('glossary:export-csv'),
  customAnalyze: (jobId: string, prompt: string) =>
    ipcRenderer.invoke('custom-tab:analyze', jobId, prompt),
  saveCustomTabs: (tabs: CustomTab[]) => ipcRenderer.invoke('custom-tab:save', tabs)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  const target = window as Window &
    typeof globalThis & {
      electron: typeof electronAPI
      api: DesktopApi
    }

  target.electron = electronAPI
  target.api = api
}
