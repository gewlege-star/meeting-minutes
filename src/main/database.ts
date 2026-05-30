import Database from 'better-sqlite3'

import {
  EMPTY_SUMMARY,
  PROVIDER_DEFAULTS,
  DEFAULT_SECTION_PROMPTS,
  type AppSettingsView,
  type CustomTab,
  type GlossaryEntry,
  type MediaSourceKind,
  type OutputLanguage,
  type ProcessingJob,
  type ProcessingStatus,
  type ProviderId,
  type SectionPrompts,
  type SummaryBundle,
  type TranscriptSegment
} from '../shared/contracts'

interface JobRow {
  id: string
  source_kind: MediaSourceKind
  source_name: string
  source_path: string
  normalized_path: string | null
  source_size_bytes: number
  status: ProcessingStatus
  transcript_text: string
  transcript_segments_json: string
  summary_json: string
  error_message: string | null
  trim_start: number | null
  trim_end: number | null
  created_at: string
  updated_at: string
}

export interface CreateJobInput {
  id: string
  sourceKind: MediaSourceKind
  sourceName: string
  sourcePath: string
  sourceSizeBytes: number
}

export interface ProviderConfig {
  provider: ProviderId
  apiKey: string | null
  baseUrl: string
  transcriptionModel: string
  summaryModel: string
  outputLanguage: OutputLanguage
  showTimestamps: boolean
  identifySpeakers: boolean
  sectionPrompts: SectionPrompts
}

export interface TranscriptPayload {
  text: string
  segments: TranscriptSegment[]
}

export class AppDatabase {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.initialize()
  }

  close(): void {
    this.db.close()
  }

  createJob(input: CreateJobInput): ProcessingJob {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO jobs (
          id,
          source_kind,
          source_name,
          source_path,
          normalized_path,
          source_size_bytes,
          status,
          transcript_text,
          transcript_segments_json,
          summary_json,
          error_message,
          created_at,
          updated_at
        ) VALUES (
          @id,
          @source_kind,
          @source_name,
          @source_path,
          NULL,
          @source_size_bytes,
          'ready',
          '',
          '[]',
          @summary_json,
          NULL,
          @created_at,
          @updated_at
        )`
      )
      .run({
        id: input.id,
        source_kind: input.sourceKind,
        source_name: input.sourceName,
        source_path: input.sourcePath,
        source_size_bytes: input.sourceSizeBytes,
        summary_json: JSON.stringify(EMPTY_SUMMARY),
        created_at: now,
        updated_at: now
      })

    return this.getJob(input.id)!
  }

  getJob(jobId: string): ProcessingJob | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined
    return row ? mapJobRow(row) : null
  }

  getJobs(): ProcessingJob[] {
    const rows = this.db
      .prepare('SELECT * FROM jobs ORDER BY datetime(created_at) DESC')
      .all() as JobRow[]
    return rows.map(mapJobRow)
  }

  updateJobStatus(
    jobId: string,
    status: ProcessingStatus,
    errorMessage: string | null = null
  ): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET status = @status,
             error_message = @error_message,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id: jobId,
        status,
        error_message: errorMessage,
        updated_at: new Date().toISOString()
      })
  }

  saveNormalizedPath(jobId: string, normalizedPath: string | null): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET normalized_path = @normalized_path,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id: jobId,
        normalized_path: normalizedPath,
        updated_at: new Date().toISOString()
      })
  }

  saveTranscript(jobId: string, transcript: TranscriptPayload): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET transcript_text = @transcript_text,
             transcript_segments_json = @transcript_segments_json,
             error_message = NULL,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id: jobId,
        transcript_text: transcript.text,
        transcript_segments_json: JSON.stringify(transcript.segments),
        updated_at: new Date().toISOString()
      })
  }

  saveTrimming(jobId: string, trimStart: number | null, trimEnd: number | null): ProcessingJob {
    this.db
      .prepare(
        `UPDATE jobs
         SET trim_start = @trim_start,
             trim_end = @trim_end,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id: jobId,
        trim_start: trimStart,
        trim_end: trimEnd,
        updated_at: new Date().toISOString()
      })
    return this.getJob(jobId)!
  }

  saveSummary(jobId: string, summary: SummaryBundle): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET summary_json = @summary_json,
             error_message = NULL,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id: jobId,
        summary_json: JSON.stringify(summary),
        updated_at: new Date().toISOString()
      })
  }

  deleteJob(jobId: string): void {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId)
  }

  renameJob(jobId: string, newName: string): ProcessingJob {
    this.db
      .prepare(
        `UPDATE jobs SET source_name = @source_name, updated_at = @updated_at WHERE id = @id`
      )
      .run({ id: jobId, source_name: newName, updated_at: new Date().toISOString() })
    return this.getJob(jobId)!
  }

  getCurrentProvider(): ProviderId {
    const value = this.getRawSetting('provider')
    if (value === 'groq' || value === 'gemini' || value === 'openai') {
      return value
    }

    return 'openai'
  }

  getSettingsView(apiKeysConfigured: Record<ProviderId, boolean>): AppSettingsView {
    const defaultOpenai = PROVIDER_DEFAULTS.openai
    const defaultGroq = PROVIDER_DEFAULTS.groq
    const defaultGemini = PROVIDER_DEFAULTS.gemini

    return {
      transcriptionProvider: (this.getRawSetting('transcriptionProvider') as ProviderId) || (this.getRawSetting('provider') as ProviderId) || 'openai',
      summaryProvider: (this.getRawSetting('summaryProvider') as ProviderId) || (this.getRawSetting('provider') as ProviderId) || 'openai',
      apiKeysConfigured,
      openaiBaseUrl: this.getRawSetting(settingKey('openai', 'baseUrl')) ?? defaultOpenai.baseUrl,
      groqBaseUrl: this.getRawSetting(settingKey('groq', 'baseUrl')) ?? defaultGroq.baseUrl,
      geminiBaseUrl: this.getRawSetting(settingKey('gemini', 'baseUrl')) ?? defaultGemini.baseUrl,
      openaiTranscriptionModel: this.getRawSetting(settingKey('openai', 'transcriptionModel')) ?? defaultOpenai.transcriptionModel,
      groqTranscriptionModel: this.getRawSetting(settingKey('groq', 'transcriptionModel')) ?? defaultGroq.transcriptionModel,
      geminiTranscriptionModel: this.getRawSetting(settingKey('gemini', 'transcriptionModel')) ?? defaultGemini.transcriptionModel,
      openaiSummaryModel: this.getRawSetting(settingKey('openai', 'summaryModel')) ?? defaultOpenai.summaryModel,
      groqSummaryModel: this.getRawSetting(settingKey('groq', 'summaryModel')) ?? defaultGroq.summaryModel,
      geminiSummaryModel: this.getRawSetting(settingKey('gemini', 'summaryModel')) ?? defaultGemini.summaryModel,
      outputLanguage: this.getOutputLanguage(),
      showTimestamps: this.getShowTimestamps(),
      identifySpeakers: this.getIdentifySpeakers(),
      sectionPrompts: this.getSectionPrompts(),
      exportDir: this.getRawSetting('exportDir') ?? ''
    }
  }

  getProviderConfig(apiKey: string | null, providerOverride?: ProviderId): ProviderConfig {
    const provider = providerOverride || this.getCurrentProvider()
    const defaults = PROVIDER_DEFAULTS[provider]

    return {
      provider,
      apiKey,
      baseUrl: this.getRawSetting(settingKey(provider, 'baseUrl')) ?? defaults.baseUrl,
      transcriptionModel:
        this.getRawSetting(settingKey(provider, 'transcriptionModel')) ??
        defaults.transcriptionModel,
      summaryModel:
        this.getRawSetting(settingKey(provider, 'summaryModel')) ?? defaults.summaryModel,
      outputLanguage: this.getOutputLanguage(),
      showTimestamps: this.getShowTimestamps(),
      identifySpeakers: this.getIdentifySpeakers(),
      sectionPrompts: this.getSectionPrompts()
    }
  }

  saveProviderSettings(input: {
    transcriptionProvider: ProviderId
    summaryProvider: ProviderId
    openaiBaseUrl: string
    groqBaseUrl: string
    geminiBaseUrl: string
    openaiTranscriptionModel: string
    groqTranscriptionModel: string
    geminiTranscriptionModel: string
    openaiSummaryModel: string
    groqSummaryModel: string
    geminiSummaryModel: string
    outputLanguage: OutputLanguage
    showTimestamps: boolean
    identifySpeakers: boolean
    sectionPrompts: SectionPrompts
    exportDir: string
  }): void {
    this.setRawSetting('transcriptionProvider', input.transcriptionProvider)
    this.setRawSetting('summaryProvider', input.summaryProvider)
    // Save individually for legacy backward-compatible calls if any
    this.setRawSetting('provider', input.transcriptionProvider)

    this.setRawSetting(settingKey('openai', 'baseUrl'), input.openaiBaseUrl)
    this.setRawSetting(settingKey('groq', 'baseUrl'), input.groqBaseUrl)
    this.setRawSetting(settingKey('gemini', 'baseUrl'), input.geminiBaseUrl)

    this.setRawSetting(settingKey('openai', 'transcriptionModel'), input.openaiTranscriptionModel)
    this.setRawSetting(settingKey('groq', 'transcriptionModel'), input.groqTranscriptionModel)
    this.setRawSetting(settingKey('gemini', 'transcriptionModel'), input.geminiTranscriptionModel)

    this.setRawSetting(settingKey('openai', 'summaryModel'), input.openaiSummaryModel)
    this.setRawSetting(settingKey('groq', 'summaryModel'), input.groqSummaryModel)
    this.setRawSetting(settingKey('gemini', 'summaryModel'), input.geminiSummaryModel)

    this.setRawSetting('outputLanguage', input.outputLanguage)
    this.setRawSetting('showTimestamps', input.showTimestamps ? 'true' : 'false')
    this.setRawSetting('identifySpeakers', input.identifySpeakers ? 'true' : 'false')
    this.setRawSetting('sectionPrompts', JSON.stringify(input.sectionPrompts))
    this.setRawSetting('exportDir', input.exportDir)
  }

  getEncryptedApiKey(provider: ProviderId): string | null {
    return this.getRawSetting(settingKey(provider, 'apiKey'))
  }

  setEncryptedApiKey(provider: ProviderId, encryptedValue: string): void {
    this.setRawSetting(settingKey(provider, 'apiKey'), encryptedValue)
  }

  deleteEncryptedApiKey(provider: ProviderId): void {
    this.deleteSetting(settingKey(provider, 'apiKey'))
  }

  getOutputLanguage(): OutputLanguage {
    const value = this.getRawSetting('outputLanguage')
    if (
      value === 'auto' ||
      value === 'zh-TW' ||
      value === 'zh-CN' ||
      value === 'en' ||
      value === 'ja' ||
      value === 'ko'
    ) {
      return value
    }
    return 'auto'
  }

  getShowTimestamps(): boolean {
    const value = this.getRawSetting('showTimestamps')
    if (value === 'false') return false
    return true // default to true
  }

  getIdentifySpeakers(): boolean {
    return this.getRawSetting('identifySpeakers') === 'true'
  }

  getSectionPrompts(): SectionPrompts {
    const raw = this.getRawSetting('sectionPrompts')
    if (!raw) return { ...DEFAULT_SECTION_PROMPTS }
    try {
      const parsed = JSON.parse(raw) as Partial<SectionPrompts>
      return {
        plainSummary: parsed.plainSummary || DEFAULT_SECTION_PROMPTS.plainSummary,
        meetingMinutes: parsed.meetingMinutes || DEFAULT_SECTION_PROMPTS.meetingMinutes,
        actionItems: parsed.actionItems || DEFAULT_SECTION_PROMPTS.actionItems,
        keyDecisions: parsed.keyDecisions || DEFAULT_SECTION_PROMPTS.keyDecisions,
        nextSteps: parsed.nextSteps || DEFAULT_SECTION_PROMPTS.nextSteps
      }
    } catch {
      return { ...DEFAULT_SECTION_PROMPTS }
    }
  }

  getGlossary(): GlossaryEntry[] {
    const rows = this.db
      .prepare('SELECT id, source_term, target_term, created_at FROM glossary ORDER BY created_at')
      .all() as Array<{ id: string; source_term: string; target_term: string; created_at: string }>
    return rows.map((row) => ({
      id: row.id,
      sourceTerm: row.source_term,
      targetTerm: row.target_term,
      createdAt: row.created_at
    }))
  }

  addGlossaryEntry(id: string, sourceTerm: string, targetTerm: string): GlossaryEntry {
    const now = new Date().toISOString()
    this.db
      .prepare(
        'INSERT INTO glossary (id, source_term, target_term, created_at) VALUES (@id, @source_term, @target_term, @created_at)'
      )
      .run({ id, source_term: sourceTerm, target_term: targetTerm, created_at: now })
    return { id, sourceTerm, targetTerm, createdAt: now }
  }

  updateGlossaryEntry(id: string, sourceTerm: string, targetTerm: string): GlossaryEntry {
    this.db
      .prepare('UPDATE glossary SET source_term = @source_term, target_term = @target_term WHERE id = @id')
      .run({ id, source_term: sourceTerm, target_term: targetTerm })
    const row = this.db.prepare('SELECT created_at FROM glossary WHERE id = ?').get(id) as
      | { created_at: string }
      | undefined
    return { id, sourceTerm, targetTerm, createdAt: row?.created_at ?? '' }
  }

  deleteGlossaryEntry(id: string): void {
    this.db.prepare('DELETE FROM glossary WHERE id = ?').run(id)
  }

  importGlossary(entries: Array<{ sourceTerm: string; targetTerm: string }>): GlossaryEntry[] {
    const now = new Date().toISOString()
    const insert = this.db.prepare(
      'INSERT INTO glossary (id, source_term, target_term, created_at) VALUES (@id, @source_term, @target_term, @created_at)'
    )
    const results: GlossaryEntry[] = []

    const runImport = this.db.transaction(() => {
      for (const entry of entries) {
        const id = crypto.randomUUID()
        insert.run({ id, source_term: entry.sourceTerm, target_term: entry.targetTerm, created_at: now })
        results.push({ id, sourceTerm: entry.sourceTerm, targetTerm: entry.targetTerm, createdAt: now })
      }
    })
    runImport()
    return results
  }

  getCustomTabs(): CustomTab[] {
    const raw = this.getRawSetting('customTabs')
    if (!raw) return []
    try {
      return JSON.parse(raw) as CustomTab[]
    } catch {
      return []
    }
  }

  saveCustomTabs(tabs: CustomTab[]): void {
    this.setRawSetting('customTabs', JSON.stringify(tabs))
  }

  getCustomTabResults(): Record<string, string> {
    const raw = this.getRawSetting('customTabResults')
    if (!raw) return {}
    try {
      return JSON.parse(raw) as Record<string, string>
    } catch {
      return {}
    }
  }

  saveCustomTabResults(results: Record<string, string>): void {
    this.setRawSetting('customTabResults', JSON.stringify(results))
  }

  getRawSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setRawSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value)
         VALUES (@key, @value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run({ key, value })
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        source_name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        normalized_path TEXT,
        source_size_bytes INTEGER NOT NULL,
        status TEXT NOT NULL,
        transcript_text TEXT NOT NULL DEFAULT '',
        transcript_segments_json TEXT NOT NULL DEFAULT '[]',
        summary_json TEXT NOT NULL DEFAULT '{}',
        error_message TEXT,
        trim_start REAL,
        trim_end REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS glossary (
        id TEXT PRIMARY KEY,
        source_term TEXT NOT NULL,
        target_term TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)

    try {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN trim_start REAL;`)
    } catch (_) {}
    try {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN trim_end REAL;`)
    } catch (_) {}
  }
}

function settingKey(
  provider: ProviderId,
  field: 'apiKey' | 'baseUrl' | 'transcriptionModel' | 'summaryModel'
): string {
  return `${provider}.${field}`
}

function mapJobRow(row: JobRow): ProcessingJob {
  const transcriptSegments = JSON.parse(row.transcript_segments_json) as TranscriptSegment[]
  const summary = {
    ...EMPTY_SUMMARY,
    ...(JSON.parse(row.summary_json) as Partial<SummaryBundle>)
  }

  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceName: row.source_name,
    sourcePath: row.source_path,
    normalizedPath: row.normalized_path,
    sourceSizeBytes: row.source_size_bytes,
    status: row.status,
    transcriptText: row.transcript_text,
    transcriptSegments,
    summary,
    errorMessage: row.error_message,
    trimStart: row.trim_start !== undefined && row.trim_start !== null ? Number(row.trim_start) : null,
    trimEnd: row.trim_end !== undefined && row.trim_end !== null ? Number(row.trim_end) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
