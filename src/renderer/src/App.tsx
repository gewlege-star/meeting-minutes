import { useEffect, useMemo, useRef, useState } from 'react'

import {
  DEFAULT_SECTION_PROMPTS,
  EMPTY_SUMMARY,
  OUTPUT_LANGUAGE_LABELS,
  PROVIDER_DEFAULTS,
  PROVIDER_LABELS,
  type AppState,
  type GlossaryEntry,
  type OutputLanguage,
  type ProcessingJob,
  type ProviderId,
  type SaveSettingsInput,
  type SectionPrompts,
  type SummaryBundle
} from '../../shared/contracts'

function App(): React.JSX.Element {
  const [appState, setAppState] = useState<AppState | null>(null)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [settingsForm, setSettingsForm] = useState<SaveSettingsInput>({
    provider: 'openai',
    apiKey: '',
    baseUrl: PROVIDER_DEFAULTS.openai.baseUrl,
    transcriptionModel: PROVIDER_DEFAULTS.openai.transcriptionModel,
    summaryModel: PROVIDER_DEFAULTS.openai.summaryModel,
    outputLanguage: 'auto',
    showTimestamps: true,
    sectionPrompts: { ...DEFAULT_SECTION_PROMPTS },
    exportDir: ''
  })
  const [loading, setLoading] = useState(true)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [infoMessage, setInfoMessage] = useState<string | null>(null)
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([])
  const [glossaryEditId, setGlossaryEditId] = useState<string | null>(null)
  const [glossarySource, setGlossarySource] = useState('')
  const [glossaryTarget, setGlossaryTarget] = useState('')
  const [selectionPopup, setSelectionPopup] = useState<{ text: string; x: number; y: number } | null>(null)
  const [hideTimestamps, setHideTimestamps] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<string>('plainSummary')
  const [currentAudioTime, setCurrentAudioTime] = useState(0)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingIdRef = useRef<string | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const pendingChunkWritesRef = useRef<Promise<void>[]>([])
  const settingsDialogRef = useRef<HTMLDialogElement>(null)
  const glossaryDialogRef = useRef<HTMLDialogElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const tabContentRef = useRef<HTMLDivElement>(null)

  const jobs = useMemo(() => {
    const raw = appState?.jobs ?? []
    return [...raw].sort((a, b) => b.sourceName.localeCompare(a.sourceName))
  }, [appState?.jobs])
  const selectedJob = selectedJobId ? (jobs.find((job) => job.id === selectedJobId) ?? null) : null
  const currentProvider = settingsForm.provider
  const currentProviderDefaults = PROVIDER_DEFAULTS[currentProvider]

  const summarySections = useMemo(
    () => buildSummarySections(selectedJob?.summary ?? EMPTY_SUMMARY),
    [selectedJob]
  )

  useEffect(() => {
    void loadAppState()
  }, [])

  useEffect(() => {
    if (!selectionPopup) return
    const dismiss = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (target.closest('.selection-popup')) return
      setSelectionPopup(null)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [selectionPopup])

  useEffect(() => {
    if (!selectedJobId) {
      setAudioUrl(null)
      return
    }
    window.api.getAudioUrl(selectedJobId).then(setAudioUrl).catch(() => setAudioUrl(null))
    void window.api.saveLastJobId(selectedJobId)
  }, [selectedJobId])

  // Auto-scroll active line into view during playback
  useEffect(() => {
    const container = tabContentRef.current
    if (!container) return
    const activeLine = container.querySelector('.active-line') as HTMLElement | null
    if (activeLine) {
      activeLine.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [currentAudioTime])

  async function loadAppState(preferredJobId?: string): Promise<void> {
    try {
      setLoading(true)
      const nextState = await window.api.getAppState()
      setAppState(nextState)
      setSettingsForm({
        provider: nextState.settings.provider,
        apiKey: '',
        baseUrl: nextState.settings.baseUrl,
        transcriptionModel: nextState.settings.transcriptionModel,
        summaryModel: nextState.settings.summaryModel,
        outputLanguage: nextState.settings.outputLanguage,
        showTimestamps: nextState.settings.showTimestamps,
        sectionPrompts: nextState.settings.sectionPrompts,
        exportDir: nextState.settings.exportDir
      })
      setSelectedJobId((current) => {
        if (preferredJobId && nextState.jobs.some((job) => job.id === preferredJobId)) {
          return preferredJobId
        }

        if (current && nextState.jobs.some((job) => job.id === current)) {
          return current
        }

        // Auto-open last viewed job on initial load
        if (nextState.lastJobId && nextState.jobs.some((job) => job.id === nextState.lastJobId)) {
          return nextState.lastJobId
        }

        return null
      })
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setLoading(false)
    }
  }

  async function saveSettings(): Promise<void> {
    await runAction('Saving settings...', async () => {
      await window.api.saveSettings(settingsForm)
      setSettingsForm((current) => ({ ...current, apiKey: '' }))
      await loadAppState(selectedJob?.id)
      settingsDialogRef.current?.close()
      setInfoMessage('Settings saved.')
    })
  }

  async function clearStoredApiKey(): Promise<void> {
    await runAction('Clearing stored API key...', async () => {
      await window.api.clearStoredApiKey()
      await loadAppState(selectedJob?.id)
      setInfoMessage(`Stored ${PROVIDER_LABELS[currentProvider]} API key cleared.`)
    })
  }

  async function importMedia(): Promise<void> {
    await runAction('Importing media...', async () => {
      const importedJob = await window.api.importMedia()
      if (!importedJob) {
        return
      }

      await loadAppState(importedJob.id)
      setInfoMessage(`Imported ${importedJob.sourceName}.`)
    })
  }

  async function startRecording(): Promise<void> {
    if (isRecording) {
      return
    }

    setErrorMessage(null)
    setInfoMessage(null)

    const { recordingId } = await window.api.beginRecording()
    recordingIdRef.current = recordingId

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      const mimeType = pickRecordingMimeType()
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)

      recorder.ondataavailable = (event) => {
        if (event.data.size === 0 || !recordingIdRef.current) {
          return
        }

        const writePromise = event.data
          .arrayBuffer()
          .then((chunk) => window.api.appendRecordingChunk(recordingIdRef.current!, chunk))
        pendingChunkWritesRef.current.push(writePromise)
      }

      recorder.onstop = () => {
        void finalizeRecording(mimeType || 'audio/webm')
      }

      mediaRecorderRef.current = recorder
      setIsRecording(true)
      recorder.start(1000)
      setInfoMessage('Recording in progress...')
    } catch (error) {
      await window.api.cancelRecording(recordingId)
      recordingIdRef.current = null
      stopMediaTracks()
      setErrorMessage(formatError(error))
    }
  }

  function stopRecording(): void {
    mediaRecorderRef.current?.stop()
  }

  async function processSelectedJob(): Promise<void> {
    if (!selectedJob) {
      return
    }

    await runAction('Generating transcript and summary...', async () => {
      const processedJob = await window.api.processJob(selectedJob.id)
      await loadAppState(processedJob.id)
      setInfoMessage(`Finished processing ${selectedJob.sourceName}.`)
    })
  }

  async function summarizeSelectedJob(): Promise<void> {
    if (!selectedJob) {
      return
    }

    await runAction('Refreshing summary...', async () => {
      const updatedJob = await window.api.summarizeJob(selectedJob.id)
      await loadAppState(updatedJob.id)
      setInfoMessage(`Summary updated for ${updatedJob.sourceName}.`)
    })
  }

  async function exportSelectedJob(): Promise<void> {
    if (!selectedJob) {
      return
    }

    await runAction('Exporting markdown...', async () => {
      const filePath = await window.api.exportJob(selectedJob.id)
      if (filePath) {
        setInfoMessage(`Exported to ${filePath}.`)
      }
    })
  }

  async function deleteSelectedJob(): Promise<void> {
    if (!selectedJob) {
      return
    }

    const confirmed = window.confirm(`Delete "${selectedJob.sourceName}" and its generated files?`)
    if (!confirmed) {
      return
    }

    await runAction('Deleting job...', async () => {
      const deletedJobId = selectedJob.id
      await window.api.deleteJob(deletedJobId)
      await loadAppState()
      if (selectedJobId === deletedJobId) {
        setSelectedJobId(null)
      }
      setInfoMessage('Job deleted.')
    })
  }

  async function renameJob(jobId: string): Promise<void> {
    const job = jobs.find((j) => j.id === jobId)
    if (!job) return
    const newName = window.prompt('輸入新標題', job.sourceName)
    if (!newName || newName.trim() === '' || newName.trim() === job.sourceName) return
    try {
      await window.api.renameJob(jobId, newName.trim())
      await loadAppState(jobId)
    } catch (error) {
      setErrorMessage(formatError(error))
    }
  }

  function handleTextSelect(): void {
    const selection = window.getSelection()
    const text = selection?.toString().trim()
    if (text && text.length > 0 && text.length < 200) {
      const rect = selection!.getRangeAt(0).getBoundingClientRect()
      setSelectionPopup({ text, x: rect.left + rect.width / 2, y: rect.top - 8 })
    } else {
      setSelectionPopup(null)
    }
  }

  function createGlossaryFromSelection(): void {
    if (!selectionPopup) return
    setGlossarySource(selectionPopup.text)
    setGlossaryTarget('')
    setGlossaryEditId(null)
    setSelectionPopup(null)
    glossaryDialogRef.current?.showModal()
  }

  async function copyToClipboard(label: string, value: string): Promise<void> {
    if (!value.trim()) {
      return
    }

    try {
      await navigator.clipboard.writeText(value)
      setInfoMessage(`${label} copied.`)
    } catch (error) {
      setErrorMessage(formatError(error))
    }
  }

  async function finalizeRecording(mimeType: string): Promise<void> {
    const recordingId = recordingIdRef.current
    if (!recordingId) {
      return
    }

    try {
      await Promise.all(pendingChunkWritesRef.current)
      const savedJob = await window.api.finishRecording(recordingId, mimeType)
      await loadAppState(savedJob.id)
      setInfoMessage(`Saved ${savedJob.sourceName}.`)
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      recordingIdRef.current = null
      mediaRecorderRef.current = null
      pendingChunkWritesRef.current = []
      stopMediaTracks()
      setIsRecording(false)
    }
  }

  function stopMediaTracks(): void {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    mediaStreamRef.current = null
  }

  function handleProviderChange(provider: ProviderId): void {
    const defaults = PROVIDER_DEFAULTS[provider]
    setSettingsForm((current) => ({
      ...current,
      provider,
      apiKey: '',
      baseUrl: defaults.baseUrl,
      transcriptionModel: defaults.transcriptionModel,
      summaryModel: defaults.summaryModel
    }))
  }

  async function loadGlossary(): Promise<void> {
    try {
      const entries = await window.api.getGlossary()
      setGlossary(entries)
    } catch (error) {
      setErrorMessage(formatError(error))
    }
  }

  async function addOrUpdateGlossaryEntry(): Promise<void> {
    if (!glossarySource.trim() || !glossaryTarget.trim()) return

    try {
      if (glossaryEditId) {
        await window.api.updateGlossaryEntry(glossaryEditId, glossarySource.trim(), glossaryTarget.trim())
      } else {
        await window.api.addGlossaryEntry(glossarySource.trim(), glossaryTarget.trim())
      }
      setGlossarySource('')
      setGlossaryTarget('')
      setGlossaryEditId(null)
      await loadGlossary()
    } catch (error) {
      setErrorMessage(formatError(error))
    }
  }

  async function deleteGlossaryEntry(id: string): Promise<void> {
    try {
      await window.api.deleteGlossaryEntry(id)
      await loadGlossary()
    } catch (error) {
      setErrorMessage(formatError(error))
    }
  }

  async function importGlossaryCsv(): Promise<void> {
    try {
      const entries = await window.api.importGlossaryCsv()
      setGlossary(entries)
      setInfoMessage('Glossary imported.')
    } catch (error) {
      setErrorMessage(formatError(error))
    }
  }

  async function exportGlossaryCsv(): Promise<void> {
    try {
      const filePath = await window.api.exportGlossaryCsv()
      if (filePath) {
        setInfoMessage(`Glossary exported to ${filePath}.`)
      }
    } catch (error) {
      setErrorMessage(formatError(error))
    }
  }

  function startEditGlossary(entry: GlossaryEntry): void {
    setGlossaryEditId(entry.id)
    setGlossarySource(entry.sourceTerm)
    setGlossaryTarget(entry.targetTerm)
  }

  function cancelEditGlossary(): void {
    setGlossaryEditId(null)
    setGlossarySource('')
    setGlossaryTarget('')
  }

  function openGlossaryDialog(): void {
    void loadGlossary()
    glossaryDialogRef.current?.showModal()
  }

  async function runAction(message: string, action: () => Promise<void>): Promise<void> {
    setBusyAction(message)
    setErrorMessage(null)
    setInfoMessage(null)

    try {
      await action()
    } catch (error) {
      setErrorMessage(formatError(error))
      await loadAppState(selectedJob?.id)
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        {selectedJob && (
          <button className="ghost-button" onClick={() => setSelectedJobId(null)} type="button">
            ← Back
          </button>
        )}
        <h1>Meeting Minutes</h1>
        <div className="top-bar-actions">
          <button
            className="primary-button"
            disabled={Boolean(busyAction) || isRecording}
            onClick={() => void importMedia()}
            type="button"
          >
            Import audio / video
          </button>
          {!isRecording ? (
            <button
              className="secondary-button"
              disabled={Boolean(busyAction)}
              onClick={() => void startRecording()}
              type="button"
            >
              Start recording
            </button>
          ) : (
            <button className="danger-button" onClick={stopRecording} type="button">
              Stop recording
            </button>
          )}
          <button className="ghost-button" onClick={openGlossaryDialog} type="button">
            📖 Glossary
          </button>
          <button
            className="ghost-button"
            onClick={() => settingsDialogRef.current?.showModal()}
            type="button"
          >
            ⚙ AI Settings
          </button>
          <span
            className={`pill ${appState?.settings.apiKeyConfigured ? 'pill-success' : 'pill-muted'}`}
          >
            {appState?.settings.apiKeyConfigured
              ? `${PROVIDER_LABELS[currentProvider]} key saved`
              : `${PROVIDER_LABELS[currentProvider]} key missing`}
          </span>
        </div>
      </header>

      <dialog className="settings-dialog" ref={settingsDialogRef}>
        <div className="settings-dialog-header">
          <div>
            <h2>AI Settings</h2>
            <p>Choose OpenAI, Groq, or Gemini for transcription and summary generation.</p>
          </div>
          <span
            className={`pill ${appState?.settings.apiKeyConfigured ? 'pill-success' : 'pill-muted'}`}
          >
            {appState?.settings.apiKeyConfigured
              ? `${PROVIDER_LABELS[currentProvider]} key saved`
              : `${PROVIDER_LABELS[currentProvider]} key missing`}
          </span>
        </div>

        <div className="settings-grid">
          <label>
            <span>Provider</span>
            <select
              onChange={(event) => handleProviderChange(event.target.value as ProviderId)}
              value={currentProvider}
            >
              {Object.entries(PROVIDER_LABELS).map(([provider, label]) => (
                <option key={provider} value={provider}>
                  {label}
                </option>
              ))}
            </select>
            <a
              className="link-button"
              href={PROVIDER_URLS[currentProvider]}
              target="_blank"
              rel="noopener noreferrer"
            >
              前往 {PROVIDER_LABELS[currentProvider]} 首頁 ↗
            </a>
          </label>

          <label>
            <span>API key</span>
            <input
              onChange={(event) =>
                setSettingsForm((current) => ({ ...current, apiKey: event.target.value }))
              }
              placeholder={`Leave blank to keep the current ${PROVIDER_LABELS[currentProvider]} key`}
              type="password"
              value={settingsForm.apiKey}
            />
          </label>

          <label>
            <span>Transcription model</span>
            <input
              onChange={(event) =>
                setSettingsForm((current) => ({
                  ...current,
                  transcriptionModel: event.target.value
                }))
              }
              value={settingsForm.transcriptionModel}
            />
          </label>

          <label>
            <span>Summary model</span>
            <input
              onChange={(event) =>
                setSettingsForm((current) => ({ ...current, summaryModel: event.target.value }))
              }
              value={settingsForm.summaryModel}
            />
          </label>

          <label className="settings-grid-wide">
            <span>Base URL</span>
            <input
              disabled={!currentProviderDefaults.baseUrlEditable}
              onChange={(event) =>
                setSettingsForm((current) => ({ ...current, baseUrl: event.target.value }))
              }
              placeholder={
                currentProviderDefaults.baseUrlEditable
                  ? 'Custom endpoint'
                  : 'Not used for Gemini SDK'
              }
              value={settingsForm.baseUrl}
            />
          </label>

          <label>
            <span>Output language</span>
            <select
              onChange={(event) =>
                setSettingsForm((current) => ({
                  ...current,
                  outputLanguage: event.target.value as OutputLanguage
                }))
              }
              value={settingsForm.outputLanguage}
            >
              {Object.entries(OUTPUT_LANGUAGE_LABELS).map(([lang, label]) => (
                <option key={lang} value={lang}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Export markdown 預設目錄</span>
            <input
              onChange={(event) =>
                setSettingsForm((current) => ({ ...current, exportDir: event.target.value }))
              }
              placeholder="留空使用預設目錄"
              type="text"
              value={settingsForm.exportDir}
            />
          </label>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settingsForm.showTimestamps}
              onChange={(event) =>
                setSettingsForm((current) => ({ ...current, showTimestamps: event.target.checked }))
              }
            />
            <span>顯示時間區段 (Action items / Key decisions / Next steps 加上 [HH:MM:SS] 前綴)</span>
          </label>
        </div>

        <details className="prompt-details">
          <summary>自訂各區塊提示詞 (Section Prompts)</summary>
          <div className="prompt-fields">
            {(['plainSummary', 'meetingMinutes', 'actionItems', 'keyDecisions', 'nextSteps'] as const).map(
              (key) => (
                <label key={key}>
                  <span>{SECTION_PROMPT_LABELS[key]}</span>
                  <textarea
                    rows={2}
                    value={settingsForm.sectionPrompts[key]}
                    placeholder={DEFAULT_SECTION_PROMPTS[key]}
                    onChange={(event) =>
                      setSettingsForm((current) => ({
                        ...current,
                        sectionPrompts: { ...current.sectionPrompts, [key]: event.target.value }
                      }))
                    }
                  />
                </label>
              )
            )}
            <button
              className="ghost-button"
              type="button"
              onClick={() =>
                setSettingsForm((current) => ({
                  ...current,
                  sectionPrompts: { ...DEFAULT_SECTION_PROMPTS }
                }))
              }
            >
              恢復預設提示詞
            </button>
          </div>
        </details>

        <p className="helper-text">
          {currentProvider === 'openai'
            ? 'OpenAI uses the default OpenAI endpoint unless you override it.'
            : currentProvider === 'groq'
              ? 'Groq uses an OpenAI-compatible endpoint, so transcription and summary run through the same pipeline.'
              : 'Gemini uses the Google GenAI SDK. Base URL is ignored; only the API key and model names matter.'}
        </p>

        <div className="toolbar settings-dialog-toolbar">
          <button
            className="primary-button"
            disabled={Boolean(busyAction)}
            onClick={() => void saveSettings()}
            type="button"
          >
            Save settings
          </button>
          <button
            className="ghost-button"
            disabled={Boolean(busyAction)}
            onClick={() => void clearStoredApiKey()}
            type="button"
          >
            Clear stored API key
          </button>
          <button
            className="ghost-button"
            onClick={() => settingsDialogRef.current?.close()}
            type="button"
          >
            Close
          </button>
        </div>
      </dialog>

      <dialog className="settings-dialog" ref={glossaryDialogRef}>
        <div className="settings-dialog-header">
          <div>
            <h2>Glossary</h2>
            <p>Define term replacements applied to transcripts and summaries.</p>
          </div>
          <span className="pill">{glossary.length} entries</span>
        </div>

        <div className="glossary-form">
          <input
            placeholder="Source term (e.g. 新界)"
            value={glossarySource}
            onChange={(e) => setGlossarySource(e.target.value)}
          />
          <span className="glossary-arrow">→</span>
          <input
            placeholder="Target term (e.g. 新借)"
            value={glossaryTarget}
            onChange={(e) => setGlossaryTarget(e.target.value)}
          />
          <button
            className="secondary-button"
            onClick={() => void addOrUpdateGlossaryEntry()}
            type="button"
          >
            {glossaryEditId ? 'Update' : 'Add'}
          </button>
          {glossaryEditId ? (
            <button className="ghost-button" onClick={cancelEditGlossary} type="button">
              Cancel
            </button>
          ) : null}
        </div>

        <div className="glossary-list">
          {glossary.length === 0 ? (
            <p className="empty-copy">No entries yet.</p>
          ) : (
            glossary.map((entry) => (
              <div key={entry.id} className="glossary-item">
                <span className="glossary-term">{entry.sourceTerm}</span>
                <span className="glossary-arrow">→</span>
                <span className="glossary-term">{entry.targetTerm}</span>
                <button
                  className="link-button"
                  onClick={() => startEditGlossary(entry)}
                  type="button"
                >
                  Edit
                </button>
                <button
                  className="link-button danger-text"
                  onClick={() => void deleteGlossaryEntry(entry.id)}
                  type="button"
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>

        <div className="toolbar settings-dialog-toolbar">
          <button
            className="secondary-button"
            onClick={() => void importGlossaryCsv()}
            type="button"
          >
            Import CSV
          </button>
          <button
            className="ghost-button"
            disabled={glossary.length === 0}
            onClick={() => void exportGlossaryCsv()}
            type="button"
          >
            Export CSV
          </button>
          <button
            className="ghost-button"
            onClick={() => glossaryDialogRef.current?.close()}
            type="button"
          >
            Close
          </button>
        </div>
      </dialog>

      {errorMessage ? <div className="message-banner error-banner">{errorMessage}</div> : null}
      {infoMessage ? <div className="message-banner info-banner">{infoMessage}</div> : null}
      {busyAction ? <div className="message-banner busy-banner">{busyAction}</div> : null}

      <main className="content">
        {loading ? (
          <div className="empty-state">
            <h2>Loading...</h2>
          </div>
        ) : selectedJob ? (
          <div className="detail-view" onMouseUp={handleTextSelect}>
           <div className="detail-sticky">
             <div className="detail-header">
               <div>
                 <h2
                   className="editable-title"
                   onClick={() => void renameJob(selectedJob.id)}
                   title="點擊更改標題"
                 >
                   {selectedJob.sourceName}
                 </h2>
                 <div className="meta-row">
                    <span>{sourceLabel(selectedJob.sourceKind)}</span>
                    <span>{formatBytes(selectedJob.sourceSizeBytes)}</span>
                    <span>{formatDate(selectedJob.createdAt)}</span>
                  </div>
                </div>

                <div className="toolbar">
                  <button
                    className="primary-button"
                    disabled={Boolean(busyAction) || isRecording}
                    onClick={() => void processSelectedJob()}
                    type="button"
                  >
                    Transcript + summary
                  </button>
                  <button
                    className="secondary-button"
                    disabled={Boolean(busyAction) || isRecording || !selectedJob.transcriptText}
                    onClick={() => void summarizeSelectedJob()}
                    type="button"
                  >
                    Refresh summary
                  </button>
                  <button
                    className="ghost-button"
                    disabled={Boolean(busyAction)}
                    onClick={() => void exportSelectedJob()}
                    type="button"
                  >
                    Export markdown
                  </button>
                  <button
                    className="ghost-button danger-text"
                    disabled={Boolean(busyAction) || isRecording}
                    onClick={() => void deleteSelectedJob()}
                    type="button"
                  >
                    Delete
                  </button>
                  <label className="checkbox-label toolbar-toggle">
                    <input
                      type="checkbox"
                      checked={!hideTimestamps}
                      onChange={(e) => setHideTimestamps(!e.target.checked)}
                    />
                    <span>顯示時間</span>
                  </label>
                </div>
              </div>

              {audioUrl && (
                <div className="audio-player">
                  <button
                    className="ghost-button audio-ctrl-btn"
                    type="button"
                    onClick={() => {
                      const a = audioRef.current
                      if (a) a.currentTime = Math.max(0, a.currentTime - 15)
                    }}
                  >
                    -15s
                  </button>
                  <button
                    className="ghost-button audio-ctrl-btn"
                    type="button"
                    onClick={() => {
                      const a = audioRef.current
                      if (a) a.currentTime = Math.min(a.duration || Infinity, a.currentTime + 15)
                    }}
                  >
                    +15s
                  </button>
                  <audio
                    src={audioUrl}
                    controls
                    preload="auto"
                    ref={audioRef}
                    onTimeUpdate={() => {
                      const a = audioRef.current
                      if (a) setCurrentAudioTime(a.currentTime)
                    }}
                  />
                </div>
              )}

              <div className="tab-bar">
                {([...summarySections.map((s) => ({ key: s.key, label: s.label })), { key: 'transcript', label: 'Transcript' }]).map((tab) => (
                  <button
                    key={tab.key}
                    className={`tab-button ${activeTab === tab.key ? 'active' : ''}`}
                    onClick={() => setActiveTab(tab.key)}
                    type="button"
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="tab-content" ref={tabContentRef}>
              {activeTab === 'transcript' ? (
                <article className="transcript-panel">
                  <div className="summary-card-header">
                    <h3>Transcript</h3>
                    <button
                      className="link-button"
                      onClick={() => void copyToClipboard('Transcript', selectedJob.transcriptText)}
                      type="button"
                    >
                      Copy
                    </button>
                  </div>
                  {selectedJob.transcriptSegments.length > 0 ? (
                    <div className="transcript-lines">
                      {selectedJob.transcriptSegments.map((seg) => {
                        const active = currentAudioTime >= seg.startSeconds && currentAudioTime < seg.endSeconds
                        return (
                          <p
                            key={seg.index}
                            className={`transcript-line ${active ? 'active-line' : ''}`}
                            onDoubleClick={() => {
                              const a = audioRef.current
                              if (a) { a.currentTime = seg.startSeconds; void a.play() }
                            }}
                          >
                            <span className="line-ts">[{formatSec(seg.startSeconds)}]</span> {seg.text}
                          </p>
                        )
                      })}
                    </div>
                  ) : (
                    <pre className="transcript-text">
                      {selectedJob.transcriptText || 'No transcript generated yet.'}
                    </pre>
                  )}
                  {selectedJob.errorMessage ? <p className="error-inline">{selectedJob.errorMessage}</p> : null}
                </article>
              ) : (
                (() => {
                  const section = summarySections.find((s) => s.key === activeTab) ?? summarySections[0]
                  const rawText = section.value
                    ? (hideTimestamps ? stripTimestamps(section.value) : section.value).replace(/\\n/g, '\n')
                    : ''
                  return (
                    <article className="summary-card">
                      <div className="summary-card-header">
                        <h3>{section.label}</h3>
                        <button
                          className="link-button"
                          onClick={() => void copyToClipboard(section.label, section.value)}
                          type="button"
                        >
                          Copy
                        </button>
                      </div>
                      {rawText ? (
                        <div className="summary-lines">
                          {rawText.split('\n').map((line, i) => {
                            const ts = parseLineTimestamp(line)
                            const active = ts ? currentAudioTime >= ts.start && currentAudioTime < ts.end : false
                            return (
                              <p
                                key={i}
                                className={`summary-line ${active ? 'active-line' : ''}`}
                                onDoubleClick={() => {
                                  if (!ts) return
                                  const a = audioRef.current
                                  if (a) { a.currentTime = ts.start; void a.play() }
                                }}
                                style={ts ? { cursor: 'pointer' } : undefined}
                              >
                                {line}
                              </p>
                            )
                          })}
                        </div>
                      ) : (
                        <div className="summary-content">Not generated yet.</div>
                      )}
                    </article>
                  )
                })()
              )}
            </div>

            {selectionPopup && (
              <div
                className="selection-popup"
                style={{ left: selectionPopup.x, top: selectionPopup.y }}
              >
                <button
                  className="secondary-button"
                  type="button"
                  onClick={createGlossaryFromSelection}
                >
                  📖 加入 Glossary
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => setSelectionPopup(null)}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        ) : (
          <section className="panel job-list-panel">
            <div className="panel-heading">
              <h2>Recent jobs</h2>
              <span>{jobs.length}</span>
            </div>
            <div className="job-list">
              {jobs.length === 0 ? (
                <p className="empty-copy">No recordings or imports yet.</p>
              ) : (
                jobs.map((job) => (
                  <div key={job.id} className="job-card-row">
                    <button
                      className={`job-card ${job.id === selectedJobId ? 'selected' : ''}`}
                      onClick={() => setSelectedJobId(job.id)}
                      type="button"
                    >
                      <div className="job-card-header">
                        <strong>{job.sourceName}</strong>
                        <span className={`status-chip status-${job.status}`}>{statusLabel(job.status)}</span>
                      </div>
                      <div className="job-card-meta">
                        <span>{sourceLabel(job.sourceKind)}</span>
                        <span>{formatBytes(job.sourceSizeBytes)}</span>
                      </div>
                      <span className="timestamp">{formatDate(job.updatedAt)}</span>
                    </button>
                    <button
                      className="ghost-button rename-btn"
                      onClick={(e) => { e.stopPropagation(); void renameJob(job.id) }}
                      type="button"
                      title="更改標題"
                    >
                      ✏️
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

const PROVIDER_URLS: Record<ProviderId, string> = {
  openai: 'https://platform.openai.com/',
  groq: 'https://console.groq.com/',
  gemini: 'https://aistudio.google.com/'
}

const SECTION_PROMPT_LABELS: Record<keyof SectionPrompts, string> = {
  plainSummary: 'Plain Summary',
  meetingMinutes: 'Meeting Minutes',
  actionItems: 'Action Items',
  keyDecisions: 'Key Decisions',
  nextSteps: 'Next Steps'
}

function buildSummarySections(
  summary: SummaryBundle
): Array<{ key: keyof SummaryBundle; label: string; value: string }> {
  return [
    { key: 'plainSummary', label: 'Plain summary', value: summary.plainSummary },
    { key: 'meetingMinutes', label: 'Meeting minutes', value: summary.meetingMinutes },
    { key: 'actionItems', label: 'Action items', value: summary.actionItems },
    { key: 'keyDecisions', label: 'Key decisions', value: summary.keyDecisions },
    { key: 'nextSteps', label: 'Next steps', value: summary.nextSteps }
  ]
}

function pickRecordingMimeType(): string | undefined {
  const preferredMimeTypes = ['audio/webm;codecs=opus', 'audio/webm']
  return preferredMimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error.'
}

function stripTimestamps(text: string): string {
  return text.replace(/\[?\d{1,2}:\d{2}:\d{2}\s*-\s*\d{1,2}:\d{2}:\d{2}\]?\s*/g, '')
}

/** Parse a timestamp like "0:01:23" or "01:23" to seconds */
function parseTimestampToSeconds(ts: string): number {
  const parts = ts.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return 0
}

/** Format seconds to HH:MM:SS */
function formatSec(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
}

/** Extract start/end seconds from a line like "[0:01:23 - 0:02:45] text" */
function parseLineTimestamp(line: string): { start: number; end: number } | null {
  const match = /\[?\s*(\d{1,2}:\d{2}:\d{2})\s*-\s*(\d{1,2}:\d{2}:\d{2})\s*\]?/.exec(line)
  if (!match) return null
  return { start: parseTimestampToSeconds(match[1]), end: parseTimestampToSeconds(match[2]) }
}

function sourceLabel(value: ProcessingJob['sourceKind']): string {
  switch (value) {
    case 'recording':
      return 'Microphone recording'
    case 'audio-file':
      return 'Imported audio'
    case 'video-file':
      return 'Imported video'
  }
}

function statusLabel(value: ProcessingJob['status']): string {
  switch (value) {
    case 'ready':
      return 'Ready'
    case 'transcribing':
      return 'Transcribing'
    case 'transcribed':
      return 'Transcript ready'
    case 'summarizing':
      return 'Summarizing'
    case 'complete':
      return 'Complete'
    case 'failed':
      return 'Failed'
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value))
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`
  }

  const units = ['KB', 'MB', 'GB']
  let size = value / 1024
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`
}

export default App
