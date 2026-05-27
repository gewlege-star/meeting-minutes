export type ProviderId = 'openai' | 'groq' | 'gemini'

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: 'OpenAI',
  groq: 'Groq',
  gemini: 'Gemini'
}

export type OutputLanguage = 'auto' | 'zh-TW' | 'zh-CN' | 'en' | 'ja' | 'ko'

export const OUTPUT_LANGUAGE_LABELS: Record<OutputLanguage, string> = {
  auto: '自動判斷',
  'zh-TW': '繁體中文',
  'zh-CN': '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어'
}

export interface GlossaryEntry {
  id: string
  sourceTerm: string
  targetTerm: string
  createdAt: string
}

export const PROVIDER_DEFAULTS: Record<
  ProviderId,
  {
    baseUrl: string
    transcriptionModel: string
    summaryModel: string
    baseUrlEditable: boolean
  }
> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    transcriptionModel: 'whisper-1',
    summaryModel: 'gpt-4.1-mini',
    baseUrlEditable: true
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    transcriptionModel: 'whisper-large-v3-turbo',
    summaryModel: 'llama-3.3-70b-versatile',
    baseUrlEditable: true
  },
  gemini: {
    baseUrl: '',
    transcriptionModel: 'gemini-2.5-flash',
    summaryModel: 'gemini-2.5-flash',
    baseUrlEditable: false
  }
}

export const AUDIO_CHUNK_SECONDS = 20 * 60

export type MediaSourceKind = 'recording' | 'audio-file' | 'video-file'
export type ProcessingStatus =
  | 'ready'
  | 'transcribing'
  | 'transcribed'
  | 'summarizing'
  | 'complete'
  | 'failed'

export interface TranscriptSegment {
  index: number
  startSeconds: number
  endSeconds: number
  text: string
}

export interface SummaryBundle {
  plainSummary: string
  meetingMinutes: string
  actionItems: string
  keyDecisions: string
  nextSteps: string
}

export const EMPTY_SUMMARY: SummaryBundle = {
  plainSummary: '',
  meetingMinutes: '',
  actionItems: '',
  keyDecisions: '',
  nextSteps: ''
}

export interface ProcessingJob {
  id: string
  sourceKind: MediaSourceKind
  sourceName: string
  sourcePath: string
  normalizedPath: string | null
  sourceSizeBytes: number
  status: ProcessingStatus
  transcriptText: string
  transcriptSegments: TranscriptSegment[]
  summary: SummaryBundle
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export interface SectionPrompts {
  plainSummary: string
  meetingMinutes: string
  actionItems: string
  keyDecisions: string
  nextSteps: string
}

export const DEFAULT_SECTION_PROMPTS: SectionPrompts = {
  plainSummary: 'A concise 3-5 sentence paragraph summarising the overall meeting discussion.',
  meetingMinutes: 'Detailed chronological notes of topics discussed and who said what.',
  actionItems: 'A newline-separated list of tasks and follow-ups, include owner and deadline if mentioned.',
  keyDecisions: 'A newline-separated list of important decisions made during the meeting.',
  nextSteps: 'A newline-separated list of follow-up activities and planned actions.'
}

export interface AppSettingsView {
  provider: ProviderId
  apiKeyConfigured: boolean
  baseUrl: string
  transcriptionModel: string
  summaryModel: string
  outputLanguage: OutputLanguage
  showTimestamps: boolean
  sectionPrompts: SectionPrompts
  exportDir: string
}

export interface SaveSettingsInput {
  provider: ProviderId
  apiKey: string
  baseUrl: string
  transcriptionModel: string
  summaryModel: string
  outputLanguage: OutputLanguage
  showTimestamps: boolean
  sectionPrompts: SectionPrompts
  exportDir: string
}

export interface AppState {
  settings: AppSettingsView
  jobs: ProcessingJob[]
  lastJobId: string | null
}

export interface DesktopApi {
  getAppState: () => Promise<AppState>
  saveSettings: (input: SaveSettingsInput) => Promise<AppSettingsView>
  clearStoredApiKey: () => Promise<AppSettingsView>
  importMedia: () => Promise<ProcessingJob | null>
  beginRecording: () => Promise<{ recordingId: string }>
  appendRecordingChunk: (recordingId: string, chunk: ArrayBuffer) => Promise<void>
  finishRecording: (recordingId: string, mimeType: string) => Promise<ProcessingJob>
  cancelRecording: (recordingId: string) => Promise<void>
  processJob: (jobId: string) => Promise<ProcessingJob>
  summarizeJob: (jobId: string) => Promise<ProcessingJob>
  exportJob: (jobId: string) => Promise<string | null>
  deleteJob: (jobId: string) => Promise<void>
  renameJob: (jobId: string, newName: string) => Promise<ProcessingJob>
  getAudioUrl: (jobId: string) => Promise<string | null>
  saveLastJobId: (jobId: string | null) => Promise<void>
  getGlossary: () => Promise<GlossaryEntry[]>
  addGlossaryEntry: (sourceTerm: string, targetTerm: string) => Promise<GlossaryEntry>
  updateGlossaryEntry: (id: string, sourceTerm: string, targetTerm: string) => Promise<GlossaryEntry>
  deleteGlossaryEntry: (id: string) => Promise<void>
  importGlossaryCsv: () => Promise<GlossaryEntry[]>
  exportGlossaryCsv: () => Promise<string | null>
}
