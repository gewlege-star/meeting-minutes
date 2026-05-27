import { app } from 'electron'
import { copyFile, mkdir, rm, stat, unlink, writeFile } from 'fs/promises'
import { appendFileSync, existsSync } from 'fs'
import { extname, join } from 'path'
import { randomUUID } from 'crypto'

import type { MediaSourceKind, ProcessingJob } from '../shared/contracts'

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.opus',
  '.webm'
])
const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.mkv',
  '.avi',
  '.m4v',
  '.wmv',
  '.webm',
  '.mpeg',
  '.mpg'
])

interface RecordingSession {
  filePath: string
}

interface CompletedRecording {
  id: string
  sourceKind: MediaSourceKind
  sourceName: string
  sourcePath: string
  sourceSizeBytes: number
}

export interface AppDirectories {
  rootDir: string
  originalsDir: string
  normalizedDir: string
  chunksDir: string
  exportsDir: string
  dbPath: string
}

const activeRecordings = new Map<string, RecordingSession>()

export async function ensureAppDirectories(): Promise<AppDirectories> {
  const rootDir = join(app.getPath('userData'), 'data')
  const originalsDir = join(rootDir, 'originals')
  const normalizedDir = join(rootDir, 'normalized')
  const chunksDir = join(rootDir, 'chunks')
  const exportsDir = join(rootDir, 'exports')

  await Promise.all([
    mkdir(rootDir, { recursive: true }),
    mkdir(originalsDir, { recursive: true }),
    mkdir(normalizedDir, { recursive: true }),
    mkdir(chunksDir, { recursive: true }),
    mkdir(exportsDir, { recursive: true })
  ])

  return {
    rootDir,
    originalsDir,
    normalizedDir,
    chunksDir,
    exportsDir,
    dbPath: join(rootDir, 'meetingminutes.db')
  }
}

export async function copyImportedMedia(
  sourceFilePath: string,
  directories: AppDirectories
): Promise<{
  id: string
  sourceKind: MediaSourceKind
  sourceName: string
  sourcePath: string
  sourceSizeBytes: number
}> {
  const extension = extname(sourceFilePath).toLowerCase()
  const sourceKind = detectSourceKind(extension)
  const id = randomUUID()
  const targetPath = join(directories.originalsDir, `${id}${extension || '.bin'}`)
  await copyFile(sourceFilePath, targetPath)
  const fileStat = await stat(targetPath)

  return {
    id,
    sourceKind,
    sourceName: sourceFilePath.split(/[\\/]/).pop() ?? `import-${id}${extension}`,
    sourcePath: targetPath,
    sourceSizeBytes: fileStat.size
  }
}

export async function beginRecording(
  directories: AppDirectories
): Promise<{ recordingId: string }> {
  const recordingId = randomUUID()
  const filePath = join(directories.originalsDir, `${recordingId}.webm`)
  await writeFile(filePath, new Uint8Array())
  activeRecordings.set(recordingId, { filePath })
  return { recordingId }
}

export function appendRecordingChunk(recordingId: string, chunk: Uint8Array): void {
  const session = activeRecordings.get(recordingId)
  if (!session) {
    throw new Error('Recording session not found.')
  }

  appendFileSync(session.filePath, chunk)
}

export async function finishRecording(recordingId: string): Promise<CompletedRecording> {
  const session = activeRecordings.get(recordingId)
  if (!session) {
    throw new Error('Recording session not found.')
  }

  activeRecordings.delete(recordingId)
  const fileStat = await stat(session.filePath)

  return {
    id: recordingId,
    sourceKind: 'recording',
    sourceName: `recording-${formatTimestampForFileName(new Date())}.webm`,
    sourcePath: session.filePath,
    sourceSizeBytes: fileStat.size
  }
}

export async function cancelRecording(recordingId: string): Promise<void> {
  const session = activeRecordings.get(recordingId)
  if (!session) {
    return
  }

  activeRecordings.delete(recordingId)
  if (existsSync(session.filePath)) {
    await unlink(session.filePath)
  }
}

export async function clearJobArtifacts(
  job: ProcessingJob,
  directories: AppDirectories
): Promise<void> {
  const chunkDir = join(directories.chunksDir, job.id)
  await Promise.allSettled([
    safeRemove(job.sourcePath),
    safeRemove(job.normalizedPath),
    rm(chunkDir, { recursive: true, force: true })
  ])
}

export function buildExportMarkdown(job: ProcessingJob): string {
  return [
    `# ${job.sourceName}`,
    '',
    `- Status: ${job.status}`,
    `- Created: ${job.createdAt}`,
    '',
    '## Plain summary',
    '',
    job.summary.plainSummary || '_Not generated yet._',
    '',
    '## Meeting minutes',
    '',
    job.summary.meetingMinutes || '_Not generated yet._',
    '',
    '## Action items',
    '',
    job.summary.actionItems || '_Not generated yet._',
    '',
    '## Key decisions',
    '',
    job.summary.keyDecisions || '_Not generated yet._',
    '',
    '## Next steps',
    '',
    job.summary.nextSteps || '_Not generated yet._',
    '',
    '## Transcript',
    '',
    job.transcriptText || '_Not generated yet._',
    ''
  ].join('\n')
}

export function toSafeFileBaseName(value: string): string {
  const sanitized = Array.from(value, (character) => {
    if (character <= '\u001f' || '<>:"/\\|?*'.includes(character)) {
      return '-'
    }

    return character
  }).join('')

  return sanitized.trim() || 'meeting-minutes'
}

function detectSourceKind(extension: string): MediaSourceKind {
  if (VIDEO_EXTENSIONS.has(extension)) {
    return 'video-file'
  }

  if (AUDIO_EXTENSIONS.has(extension)) {
    return 'audio-file'
  }

  throw new Error(`Unsupported file type: ${extension || '(no extension)'}.`)
}

async function safeRemove(filePath: string | null): Promise<void> {
  if (!filePath || !existsSync(filePath)) {
    return
  }

  await unlink(filePath)
}

function formatTimestampForFileName(value: Date): string {
  return value.toISOString().replace(/[:]/g, '-').replace(/\..+$/, '')
}
