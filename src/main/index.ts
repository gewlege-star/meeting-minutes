import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { dirname, join } from 'path'
import { createReadStream } from 'fs'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'

import icon from '../../resources/icon.png?asset'
import type { SaveSettingsInput, CustomTab, ProviderId } from '../shared/contracts'
import { AppDatabase, type ProviderConfig } from './database'
import { createAIProvider } from './ai-provider'
import { createAudioChunks, ensureNormalizedAudio } from './media'
import { applyGlossary } from './text-utils'
import {
  appendRecordingChunk,
  beginRecording,
  buildExportMarkdown,
  cancelRecording,
  clearJobArtifacts,
  copyImportedMedia,
  ensureAppDirectories,
  finishRecording,
  toSafeFileBaseName,
  type AppDirectories
} from './storage'

let mainWindow: BrowserWindow | null = null
let directories: AppDirectories | null = null
let database: AppDatabase | null = null
let mediaServerPort = 0

const MEDIA_MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  flac: 'audio/flac',
  aac: 'audio/aac'
}

function startMediaServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      // CORS headers for all responses
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'Range')
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length')

      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
      }

      // Decode path using base64url to avoid Windows backslash / URL normalization issues
      const encoded = (req.url ?? '/').slice(1)
      const filePath = Buffer.from(encoded, 'base64url').toString('utf8')
      try {
        const fileStat = await stat(filePath)
        const fileSize = fileStat.size
        const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
        const contentType = MEDIA_MIME_TYPES[ext] ?? 'application/octet-stream'

        const range = req.headers.range
        if (range) {
          const match = range.match(/bytes=(\d+)-(\d*)/)
          if (match) {
            const start = parseInt(match[1], 10)
            const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
            const chunkSize = end - start + 1
            res.writeHead(206, {
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': chunkSize,
              'Content-Type': contentType
            })
            createReadStream(filePath, { start, end }).pipe(res)
            return
          }
        }

        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes'
        })
        createReadStream(filePath).pipe(res)
      } catch {
        res.writeHead(404)
        res.end('Not found')
      }
    })

    server.listen(0, '127.0.0.1', () => {
      mediaServerPort = (server.address() as AddressInfo).port
      resolve()
    })
    server.on('error', reject)
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1200,
    minHeight: 760,
    show: false,
    title: 'Meeting Minutes',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app
  .whenReady()
  .then(async () => {
    app.setAppUserModelId('com.meetingminutes.app')

    await startMediaServer()

    directories = await ensureAppDirectories()
    database = new AppDatabase(directories.dbPath)

    registerIpcHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
  .catch((error) => {
    console.error('Failed to initialize Meeting Minutes.', error)
    app.quit()
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  database?.close()
})

function registerIpcHandlers(): void {
  ipcMain.handle('app:get-state', async () => {
    const db = requireDatabase()
    return {
      settings: db.getSettingsView(getAllEncryptedApiKeys(db)),
      jobs: db.getJobs(),
      lastJobId: db.getRawSetting('lastJobId') || null,
      customTabs: db.getCustomTabs(),
      customTabResults: db.getCustomTabResults()
    }
  })

  ipcMain.handle('settings:save', async (_, input: SaveSettingsInput) => {
    persistSettings(input)
    const db = requireDatabase()
    return db.getSettingsView(getAllEncryptedApiKeys(db))
  })

  ipcMain.handle('settings:clear-api-key', async (_, provider: ProviderId) => {
    const db = requireDatabase()
    db.deleteEncryptedApiKey(provider || db.getCurrentProvider())
    return db.getSettingsView(getAllEncryptedApiKeys(db))
  })

  ipcMain.handle(
    'settings:fetch-models',
    async (_, provider: ProviderId, apiKey: string, baseUrl: string) => {
      if (!apiKey) {
        throw new Error('請提供 API 密鑰以獲取可用模型。')
      }
      try {
        if (provider === 'gemini') {
          const { GoogleGenAI } = require('@google/genai')
          const client = new GoogleGenAI({ apiKey })
          const response = await client.models.list()
          const list = Array.isArray(response)
            ? response
            : response &&
                typeof response === 'object' &&
                'models' in response &&
                Array.isArray(response.models)
              ? response.models
              : []
          return list.map((m: any) => m.name || m.id).filter(Boolean)
        } else {
          const { OpenAI } = require('openai')
          const client = new OpenAI({ apiKey: apiKey, baseURL: baseUrl || undefined })
          const response = await client.models.list()
          return response.data.map((m: any) => m.id)
        }
      } catch (e: any) {
        throw new Error(`獲取模型列表失敗: ${e.message}`)
      }
    }
  )

  ipcMain.handle('media:import', async () => {
    const currentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = await dialog.showOpenDialog(currentWindow!, {
      properties: ['openFile'],
      filters: [
        {
          name: 'Audio / video',
          extensions: [
            'mp3',
            'wav',
            'm4a',
            'aac',
            'flac',
            'ogg',
            'opus',
            'webm',
            'mp4',
            'mov',
            'mkv',
            'avi',
            'm4v',
            'wmv',
            'mpeg',
            'mpg'
          ]
        }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const imported = await copyImportedMedia(result.filePaths[0], requireDirectories())
    return requireDatabase().createJob(imported)
  })

  ipcMain.handle('recording:begin', async () => beginRecording(requireDirectories()))

  ipcMain.handle('recording:append', async (_, recordingId: string, chunk: ArrayBuffer) => {
    appendRecordingChunk(recordingId, new Uint8Array(chunk))
  })

  ipcMain.handle('recording:finish', async (_, recordingId: string, mimeType: string) => {
    void mimeType
    const completedRecording = await finishRecording(recordingId)
    return requireDatabase().createJob(completedRecording)
  })

  ipcMain.handle('recording:cancel', async (_, recordingId: string) => {
    await cancelRecording(recordingId)
  })

  ipcMain.handle('job:process', async (_, jobId: string) => {
    const db = requireDatabase()
    db.updateJobStatus(jobId, 'transcribing')

    try {
      const job = db.getJob(jobId)
      if (!job) {
        throw new Error('Job not found.')
      }

      const normalizedPath = await ensureNormalizedAudio(job, requireDirectories())
      db.saveNormalizedPath(jobId, normalizedPath)

      const txConfig = loadProviderConfig('transcription')
      const glossaryForPrompt = db.getGlossary()
      txConfig.glossaryTerms = glossaryForPrompt.map((e) => e.sourceTerm)
      const txProvider = createAIProvider(txConfig)
      const chunkPaths = await createAudioChunks(jobId, normalizedPath, requireDirectories())
      const transcript = await txProvider.transcribeAudio(chunkPaths)

      // Apply glossary replacements to transcript
      const glossary = db.getGlossary()
      transcript.text = applyGlossary(transcript.text, glossary)
      for (const segment of transcript.segments) {
        segment.text = applyGlossary(segment.text, glossary)
      }

      db.saveTranscript(jobId, transcript)
      db.updateJobStatus(jobId, 'transcribed')

      db.updateJobStatus(jobId, 'summarizing')
      const sumProvider = createAIProvider(loadProviderConfig('summary'))
      const summary = await sumProvider.summarizeTranscript(transcript.text, transcript.segments)

      // Apply glossary replacements to summary fields
      const processedSummary = {
        plainSummary: applyGlossary(summary.plainSummary, glossary),
        meetingMinutes: applyGlossary(summary.meetingMinutes, glossary),
        actionItems: applyGlossary(summary.actionItems, glossary),
        keyDecisions: applyGlossary(summary.keyDecisions, glossary),
        nextSteps: applyGlossary(summary.nextSteps, glossary)
      }

      db.saveSummary(jobId, processedSummary)
      db.updateJobStatus(jobId, 'complete')

      return db.getJob(jobId)!
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown processing error.'
      db.updateJobStatus(jobId, 'failed', message)
      throw error
    }
  })

  ipcMain.handle('job:summarize', async (_, jobId: string) => {
    const db = requireDatabase()
    const job = db.getJob(jobId)
    if (!job) {
      throw new Error('Job not found.')
    }
    if (!job.transcriptText.trim()) {
      throw new Error('Generate a transcript before requesting a summary.')
    }

    db.updateJobStatus(jobId, 'summarizing')

    try {
      const provider = createAIProvider(loadProviderConfig('summary'))
      const summary = await provider.summarizeTranscript(job.transcriptText, job.transcriptSegments)

      // Apply glossary replacements to summary fields
      const glossary = db.getGlossary()
      const processedSummary = {
        plainSummary: applyGlossary(summary.plainSummary, glossary),
        meetingMinutes: applyGlossary(summary.meetingMinutes, glossary),
        actionItems: applyGlossary(summary.actionItems, glossary),
        keyDecisions: applyGlossary(summary.keyDecisions, glossary),
        nextSteps: applyGlossary(summary.nextSteps, glossary)
      }

      db.saveSummary(jobId, processedSummary)
      db.updateJobStatus(jobId, 'complete')
      return db.getJob(jobId)!
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown summarization error.'
      db.updateJobStatus(jobId, 'failed', message)
      throw error
    }
  })

  ipcMain.handle('job:export', async (_, jobId: string) => {
    const db = requireDatabase()
    const job = db.getJob(jobId)
    if (!job) {
      throw new Error('Job not found.')
    }

    const exportDir = db.getRawSetting('exportDir')?.trim() || requireDirectories().exportsDir
    const defaultPath = join(
      exportDir,
      `${toSafeFileBaseName(job.sourceName.replace(/\.[^.]+$/, ''))}.md`
    )
    const currentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = await dialog.showSaveDialog(currentWindow!, {
      defaultPath,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })

    if (result.canceled || !result.filePath) {
      return null
    }

    await mkdir(dirname(result.filePath), { recursive: true })
    await writeFile(result.filePath, buildExportMarkdown(job), 'utf8')
    return result.filePath
  })

  ipcMain.handle('job:delete', async (_, jobId: string) => {
    const db = requireDatabase()
    const job = db.getJob(jobId)
    if (!job) {
      return
    }

    await clearJobArtifacts(job, requireDirectories())
    db.deleteJob(jobId)
  })

  ipcMain.handle('job:rename', async (_, jobId: string, newName: string) => {
    return requireDatabase().renameJob(jobId, newName.trim())
  })

  ipcMain.handle('job:get-audio-url', async (_, jobId: string) => {
    const job = requireDatabase().getJob(jobId)
    if (!job) return null
    const filePath = job.normalizedPath || job.sourcePath
    return `http://127.0.0.1:${mediaServerPort}/${Buffer.from(filePath).toString('base64url')}`
  })

  ipcMain.handle(
    'job:update-transcript',
    async (_, jobId: string, transcriptText: string, segments: any[]) => {
      const db = requireDatabase()
      const job = db.getJob(jobId)
      if (!job) {
        throw new Error('Job not found.')
      }
      db.saveTranscript(jobId, { text: transcriptText, segments })
      return db.getJob(jobId)!
    }
  )

  ipcMain.handle(
    'job:update-trimming',
    async (_, jobId: string, trimStart: number | null, trimEnd: number | null) => {
      const db = requireDatabase()
      const job = db.getJob(jobId)
      if (!job) {
        throw new Error('Job not found.')
      }
      // If the trimming bounds changed, make sure we clear the previously normalized audio path so it gets regenerated!
      if (job.normalizedPath) {
        // By changing trimming, ensure_normalized will run Ffmpeg again to cut the correct part of the original sourcePath
        db.saveNormalizedPath(jobId, null)
      }
      const updatedJob = db.saveTrimming(jobId, trimStart, trimEnd)
      return updatedJob
    }
  )

  ipcMain.handle('job:correct-transcript', async (_, jobId: string) => {
    const db = requireDatabase()
    const job = db.getJob(jobId)
    if (!job) {
      throw new Error('Job not found.')
    }
    if (!job.transcriptText.trim()) {
      throw new Error('No transcript text to correct.')
    }

    db.updateJobStatus(jobId, 'transcribing')

    try {
      const provider = createAIProvider(loadProviderConfig('summary'))
      const corrected = await provider.correctTranscript(job.transcriptText, job.transcriptSegments)

      // Apply glossary replacements to the corrected output too
      const glossary = db.getGlossary()
      corrected.text = applyGlossary(corrected.text, glossary)
      for (const segment of corrected.segments) {
        segment.text = applyGlossary(segment.text, glossary)
      }

      db.saveTranscript(jobId, corrected)
      db.updateJobStatus(jobId, 'complete')
      return db.getJob(jobId)!
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown correction error.'
      db.updateJobStatus(jobId, 'failed', message)
      throw error
    }
  })

  ipcMain.handle('app:save-last-job', async (_, jobId: string | null) => {
    const db = requireDatabase()
    db.setRawSetting('lastJobId', jobId ?? '')
  })

  // Glossary IPC handlers
  ipcMain.handle('glossary:get', async () => {
    return requireDatabase().getGlossary()
  })

  ipcMain.handle('glossary:add', async (_, sourceTerm: string, targetTerm: string) => {
    const id = crypto.randomUUID()
    return requireDatabase().addGlossaryEntry(id, sourceTerm, targetTerm)
  })

  ipcMain.handle(
    'glossary:update',
    async (_, id: string, sourceTerm: string, targetTerm: string) => {
      return requireDatabase().updateGlossaryEntry(id, sourceTerm, targetTerm)
    }
  )

  ipcMain.handle('glossary:delete', async (_, id: string) => {
    requireDatabase().deleteGlossaryEntry(id)
  })

  ipcMain.handle('glossary:import-csv', async () => {
    const currentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = await dialog.showOpenDialog(currentWindow!, {
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })

    if (result.canceled || result.filePaths.length === 0) {
      return requireDatabase().getGlossary()
    }

    const csvContent = (await readFile(result.filePaths[0], 'utf8')).replace(/^\uFEFF/, '')
    const entries = parseCsvGlossary(csvContent)
    if (entries.length > 0) {
      requireDatabase().importGlossary(entries)
    }
    return requireDatabase().getGlossary()
  })

  ipcMain.handle('glossary:export-csv', async () => {
    const db = requireDatabase()
    const glossary = db.getGlossary()
    if (glossary.length === 0) {
      return null
    }

    const csvLines = ['source_term,target_term']
    for (const entry of glossary) {
      csvLines.push(`${escapeCsvField(entry.sourceTerm)},${escapeCsvField(entry.targetTerm)}`)
    }

    const currentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = await dialog.showSaveDialog(currentWindow!, {
      defaultPath: join(requireDirectories().exportsDir, 'glossary.csv'),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })

    if (result.canceled || !result.filePath) {
      return null
    }

    await mkdir(dirname(result.filePath), { recursive: true })
    await writeFile(result.filePath, '\uFEFF' + csvLines.join('\n'), 'utf8')
    return result.filePath
  })

  ipcMain.handle('custom-tab:save', async (_, tabs: CustomTab[]) => {
    requireDatabase().saveCustomTabs(tabs)
  })

  ipcMain.handle('custom-tab:get-results', async () => {
    return requireDatabase().getCustomTabResults()
  })

  ipcMain.handle('custom-tab:save-results', async (_, results: Record<string, string>) => {
    requireDatabase().saveCustomTabResults(results)
  })

  ipcMain.handle('custom-tab:analyze', async (_, jobId: string, prompt: string) => {
    const db = requireDatabase()
    const job = db.getJob(jobId)
    if (!job) throw new Error('Job not found.')
    if (!job.transcriptText.trim()) throw new Error('請先產生逐字稿。')

    const glossary = db.getGlossary()
    const transcriptWithGlossary = applyGlossary(job.transcriptText, glossary)

    const provider = createAIProvider(loadProviderConfig('summary'))
    const result = await provider.analyzeWithPrompt(transcriptWithGlossary, prompt)
    return applyGlossary(result, glossary)
  })

  ipcMain.handle('clipboard:write', (_, text: string) => {
    clipboard.writeText(text)
  })
}

function persistSettings(input: SaveSettingsInput): void {
  const db = requireDatabase()
  db.saveProviderSettings({
    transcriptionProvider: input.transcriptionProvider,
    summaryProvider: input.summaryProvider,
    openaiBaseUrl: input.openaiBaseUrl,
    groqBaseUrl: input.groqBaseUrl,
    geminiBaseUrl: input.geminiBaseUrl,
    openaiTranscriptionModel: input.openaiTranscriptionModel.trim(),
    groqTranscriptionModel: input.groqTranscriptionModel.trim(),
    geminiTranscriptionModel: input.geminiTranscriptionModel.trim(),
    openaiSummaryModel: input.openaiSummaryModel.trim(),
    groqSummaryModel: input.groqSummaryModel.trim(),
    geminiSummaryModel: input.geminiSummaryModel.trim(),
    outputLanguage: input.outputLanguage,
    showTimestamps: input.showTimestamps,
    identifySpeakers: input.identifySpeakers,
    sectionPrompts: input.sectionPrompts,
    exportDir: input.exportDir.trim()
  })

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable on this system.')
  }

  if (input.openaiApiKey && input.openaiApiKey.trim()) {
    const encrypted = safeStorage.encryptString(input.openaiApiKey.trim()).toString('base64')
    db.setEncryptedApiKey('openai', encrypted)
  }
  if (input.groqApiKey && input.groqApiKey.trim()) {
    const encrypted = safeStorage.encryptString(input.groqApiKey.trim()).toString('base64')
    db.setEncryptedApiKey('groq', encrypted)
  }
  if (input.geminiApiKey && input.geminiApiKey.trim()) {
    const encrypted = safeStorage.encryptString(input.geminiApiKey.trim()).toString('base64')
    db.setEncryptedApiKey('gemini', encrypted)
  }
}

function loadProviderConfig(purpose: 'transcription' | 'summary'): ProviderConfig {
  const db = requireDatabase()
  const provider =
    purpose === 'transcription'
      ? (db.getRawSetting('transcriptionProvider') as ProviderId) ||
        (db.getRawSetting('provider') as ProviderId) ||
        'openai'
      : (db.getRawSetting('summaryProvider') as ProviderId) ||
        (db.getRawSetting('provider') as ProviderId) ||
        'openai'

  const encryptedApiKey = db.getEncryptedApiKey(provider)

  if (encryptedApiKey && !safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable on this system.')
  }

  const apiKey = encryptedApiKey
    ? safeStorage.decryptString(Buffer.from(encryptedApiKey, 'base64'))
    : null

  return db.getProviderConfig(apiKey, provider)
}

function getAllEncryptedApiKeys(db: AppDatabase): Record<ProviderId, boolean> {
  return {
    openai: Boolean(db.getEncryptedApiKey('openai')),
    groq: Boolean(db.getEncryptedApiKey('groq')),
    gemini: Boolean(db.getEncryptedApiKey('gemini'))
  }
}

function requireDatabase(): AppDatabase {
  if (!database) {
    throw new Error('Database is not initialized yet.')
  }

  return database
}

function requireDirectories(): AppDirectories {
  if (!directories) {
    throw new Error('Application directories are not initialized yet.')
  }

  return directories
}

function parseCsvGlossary(csv: string): Array<{ sourceTerm: string; targetTerm: string }> {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim())
  const entries: Array<{ sourceTerm: string; targetTerm: string }> = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Skip header row
    if (i === 0 && /^source[_\s]?term/i.test(line)) {
      continue
    }

    const parts = parseCsvLine(line)
    if (parts.length >= 2 && parts[0].trim() && parts[1].trim()) {
      entries.push({ sourceTerm: parts[0].trim(), targetTerm: parts[1].trim() })
    }
  }

  return entries
}

function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"'
        i++
      } else if (char === '"') {
        inQuotes = false
      } else {
        current += char
      }
    } else {
      if (char === '"') {
        inQuotes = true
      } else if (char === ',') {
        result.push(current)
        current = ''
      } else {
        current += char
      }
    }
  }
  result.push(current)
  return result
}

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
