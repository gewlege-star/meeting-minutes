import { ElectronAPI } from '@electron-toolkit/preload'
import type { DesktopApi } from '../shared/contracts'

declare global {
  interface Window {
    electron: ElectronAPI
    api: DesktopApi
  }
}
