import { useEffect, useMemo, useRef, useState } from 'react'

import {
  DEFAULT_SECTION_PROMPTS,
  EMPTY_SUMMARY,
  OUTPUT_LANGUAGE_LABELS,
  PROVIDER_DEFAULTS,
  PROVIDER_LABELS,
  type AppState,
  type CustomTab,
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
    transcriptionProvider: 'openai',
    summaryProvider: 'openai',
    openaiApiKey: '',
    groqApiKey: '',
    geminiApiKey: '',
    openaiBaseUrl: PROVIDER_DEFAULTS.openai.baseUrl,
    groqBaseUrl: PROVIDER_DEFAULTS.groq.baseUrl,
    geminiBaseUrl: PROVIDER_DEFAULTS.gemini.baseUrl,
    openaiTranscriptionModel: PROVIDER_DEFAULTS.openai.transcriptionModel,
    groqTranscriptionModel: PROVIDER_DEFAULTS.groq.transcriptionModel,
    geminiTranscriptionModel: PROVIDER_DEFAULTS.gemini.transcriptionModel,
    openaiSummaryModel: PROVIDER_DEFAULTS.openai.summaryModel,
    groqSummaryModel: PROVIDER_DEFAULTS.groq.summaryModel,
    geminiSummaryModel: PROVIDER_DEFAULTS.gemini.summaryModel,
    outputLanguage: 'auto',
    showTimestamps: true,
    identifySpeakers: false,
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
  const [glossarySearch, setGlossarySearch] = useState('')
  const [selectionPopup, setSelectionPopup] = useState<{ text: string; x: number; y: number } | null>(null)
  const [hideTimestamps, setHideTimestamps] = useState(false)
  const [hideSpeakers, setHideSpeakers] = useState(false)
  const [showOnlyConfirmed, setShowLowConfidenceOnly] = useState(false)
  const [txProviderModels, setTxProviderModels] = useState<string[]>([])
  const [sumProviderModels, setSumProviderModels] = useState<string[]>([])
  const [txModelSearch, setTxModelSearch] = useState('')
  const [sumModelSearch, setSumModelSearch] = useState('')
  const [txModelDropdownOpen, setTxModelDropdownOpen] = useState(false)
  const [sumModelDropdownOpen, setSumModelDropdownOpen] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<string>('transcript')
  const [currentAudioTime, setCurrentAudioTime] = useState(0)
  const [trackActiveLine, setTrackActiveLine] = useState(true)
  const [tabSearchQuery, setTabSearchQuery] = useState('')
  const [transcriptSearchIndex, setTranscriptSearchIndex] = useState(0)
  const [editingSegmentIndex, setEditingSegmentIndex] = useState<number | null>(null)
  const [editingSegmentText, setEditingSegmentText] = useState<string>('')
  const [isAudioPlaying, setIsAudioPlaying] = useState(false)
  const [loopEditDialog, setLoopEditDialog] = useState(false)

  // Custom tabs
  const [customTabs, setCustomTabs] = useState<CustomTab[]>([])
  const [customTabResults, setCustomTabResults] = useState<Record<string, string>>({})
  const [promptDialogTabId, setPromptDialogTabId] = useState<string | null>(null)
  const [promptDialogName, setPromptDialogName] = useState('')
  const [promptDialogText, setPromptDialogText] = useState('')
  const [renameDialogJobId, setRenameDialogJobId] = useState<string | null>(null)
  const [renameDialogValue, setRenameDialogValue] = useState('')

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingIdRef = useRef<string | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const pendingChunkWritesRef = useRef<Promise<void>[]>([])
  const settingsDialogRef = useRef<HTMLDialogElement>(null)
  const glossaryDialogRef = useRef<HTMLDialogElement>(null)
  const promptDialogRef = useRef<HTMLDialogElement>(null)
  const renameDialogRef = useRef<HTMLDialogElement>(null)
  const editSegmentDialogRef = useRef<HTMLDialogElement>(null)
  const transcriptMatchRef = useRef<HTMLElement | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const segmentEndRef = useRef<number | null>(null)
  const segmentLoopStartRef = useRef<number | null>(null)
  const loopModeRef = useRef(false)
  const tabContentRef = useRef<HTMLDivElement>(null)

  const jobs = useMemo(() => {
    const raw = appState?.jobs ?? []
    return [...raw].sort((a, b) => b.sourceName.localeCompare(a.sourceName))
  }, [appState?.jobs])
  const selectedJob = selectedJobId ? (jobs.find((job) => job.id === selectedJobId) ?? null) : null
  const currentProvider = settingsForm.transcriptionProvider

  const summarySections = useMemo(
    () => buildSummarySections(selectedJob?.summary ?? EMPTY_SUMMARY),
    [selectedJob]
  )

  const transcriptMatchCount = useMemo(() => {
    if (!selectedJob || !tabSearchQuery.trim()) return 0
    return selectedJob.transcriptSegments.filter((seg) =>
      seg.text.toLowerCase().includes(tabSearchQuery.toLowerCase())
    ).length
  }, [selectedJob, tabSearchQuery])

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
    setActiveTab('transcript')
    setTabSearchQuery('')
    window.api.getAudioUrl(selectedJobId).then(setAudioUrl).catch(() => setAudioUrl(null))
    void window.api.saveLastJobId(selectedJobId)
  }, [selectedJobId])

  // Auto-scroll active line into view during playback
  useEffect(() => {
    if (!trackActiveLine) return
    const container = tabContentRef.current
    if (!container) return
    const activeLine = container.querySelector('.active-line') as HTMLElement | null
    if (activeLine) {
      activeLine.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [currentAudioTime, trackActiveLine])

  useEffect(() => {
    setTranscriptSearchIndex(0)
  }, [tabSearchQuery, activeTab])

  useEffect(() => {
    if (transcriptMatchRef.current) {
      transcriptMatchRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [transcriptSearchIndex])

  async function loadAppState(preferredJobId?: string): Promise<void> {
    try {
      setLoading(true)
      const nextState = await window.api.getAppState()
      setAppState(nextState)
      setSettingsForm({
        transcriptionProvider: nextState.settings.transcriptionProvider,
        summaryProvider: nextState.settings.summaryProvider,
        openaiApiKey: '',
        groqApiKey: '',
        geminiApiKey: '',
        openaiBaseUrl: nextState.settings.openaiBaseUrl,
        groqBaseUrl: nextState.settings.groqBaseUrl,
        geminiBaseUrl: nextState.settings.geminiBaseUrl,
        openaiTranscriptionModel: nextState.settings.openaiTranscriptionModel,
        groqTranscriptionModel: nextState.settings.groqTranscriptionModel,
        geminiTranscriptionModel: nextState.settings.geminiTranscriptionModel,
        openaiSummaryModel: nextState.settings.openaiSummaryModel,
        groqSummaryModel: nextState.settings.groqSummaryModel,
        geminiSummaryModel: nextState.settings.geminiSummaryModel,
        outputLanguage: nextState.settings.outputLanguage,
        showTimestamps: nextState.settings.showTimestamps,
        identifySpeakers: nextState.settings.identifySpeakers,
        sectionPrompts: nextState.settings.sectionPrompts,
        exportDir: nextState.settings.exportDir
      })
      setCustomTabs(nextState.customTabs ?? [])
      setCustomTabResults(nextState.customTabResults ?? {})
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
      setSettingsForm((current) => ({
        ...current,
        openaiApiKey: '',
        groqApiKey: '',
        geminiApiKey: ''
      }))
      await loadAppState(selectedJob?.id)
      settingsDialogRef.current?.close()
      setInfoMessage('Settings saved.')
    })
  }

  async function clearStoredApiKeyByProvider(provider: ProviderId): Promise<void> {
    await runAction('Clearing stored API key...', async () => {
      await window.api.clearStoredApiKey(provider)
      await loadAppState(selectedJob?.id)
      setInfoMessage(`Stored ${PROVIDER_LABELS[provider]} API key cleared.`)
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

  async function refreshModels(type: 'transcription' | 'summary'): Promise<void> {
    const providerId = type === 'transcription' ? settingsForm.transcriptionProvider : settingsForm.summaryProvider
    const apiKeyKey = providerId === 'openai' ? 'openaiApiKey' : providerId === 'groq' ? 'groqApiKey' : 'geminiApiKey'
    const apiKeyVal = settingsForm[apiKeyKey] || ''
    const baseUrlKey = providerId === 'openai' ? 'openaiBaseUrl' : providerId === 'groq' ? 'groqBaseUrl' : 'geminiBaseUrl'
    const baseUrlVal = settingsForm[baseUrlKey] || ''

    await runAction('Fetching available models...', async () => {
      try {
        const fetched = await window.api.fetchModelsByProvider(providerId, apiKeyVal, baseUrlVal)
        if (type === 'transcription') {
          setTxProviderModels(fetched)
          setInfoMessage(`Fetched transcription models for ${PROVIDER_LABELS[providerId]}.`)
        } else {
          setSumProviderModels(fetched)
          setInfoMessage(`Fetched summary models for ${PROVIDER_LABELS[providerId]}.`)
        }
      } catch (err) {
        setErrorMessage(`Failed to fetch models: ${formatError(err)} (請確認 API key 是否填寫)`)
      }
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

  function renameJob(jobId: string): void {
    const job = jobs.find((j) => j.id === jobId)
    if (!job) return
    setRenameDialogJobId(jobId)
    setRenameDialogValue(job.sourceName)
    renameDialogRef.current?.showModal()
  }

  async function submitRenameDialog(): Promise<void> {
    if (!renameDialogJobId) return
    const job = jobs.find((j) => j.id === renameDialogJobId)
    const trimmed = renameDialogValue.trim()
    if (!trimmed || trimmed === job?.sourceName) {
      renameDialogRef.current?.close()
      return
    }
    try {
      await window.api.renameJob(renameDialogJobId, trimmed)
      await loadAppState(renameDialogJobId)
    } catch (error) {
      setErrorMessage(formatError(error))
    }
    renameDialogRef.current?.close()
    setRenameDialogJobId(null)
  }

  async function saveEditingSegment(): Promise<void> {
    if (editingSegmentIndex === null || !selectedJob) return

    const currentSegment = selectedJob.transcriptSegments.find((s) => s.index === editingSegmentIndex)
    let nextSegments = [...selectedJob.transcriptSegments]

    if (currentSegment) {
      const speakerRegex = /^([^:\uff1a\n]+)\s*[:\uff1a]\s*(.*)$/
      const oldMatch = currentSegment.text.match(speakerRegex)
      const newMatch = editingSegmentText.match(speakerRegex)

      if (oldMatch && newMatch) {
        const oldSpeaker = oldMatch[1].trim()
        const newSpeaker = newMatch[1].trim()

        if (oldSpeaker !== newSpeaker) {
          const confirmAll = window.confirm(
            `偵測到您將說話者「${oldSpeaker}」修改為「${newSpeaker}」。\n\n是否要將此場會議中所有「${oldSpeaker}」一併更名為「${newSpeaker}」？`
          )
          if (confirmAll) {
            const escapedOld = oldSpeaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const prefixRegex = new RegExp(`^${escapedOld}\\s*[:\\uff1a]\\s*`)
            nextSegments = nextSegments.map((s) => {
              if (s.index === editingSegmentIndex) {
                return { ...s, text: editingSegmentText }
              }
              if (prefixRegex.test(s.text)) {
                return { ...s, text: s.text.replace(prefixRegex, `${newSpeaker}: `) }
              }
              return s
            })
          } else {
            nextSegments = nextSegments.map((s) => {
              if (s.index === editingSegmentIndex) {
                return { ...s, text: editingSegmentText }
              }
              return s
            })
          }
        } else {
          nextSegments = nextSegments.map((s) => {
            if (s.index === editingSegmentIndex) {
              return { ...s, text: editingSegmentText }
            }
            return s
          })
        }
      } else {
        nextSegments = nextSegments.map((s) => {
          if (s.index === editingSegmentIndex) {
            return { ...s, text: editingSegmentText }
          }
          return s
        })
      }
    }

    const nextText = nextSegments.map((s) => s.text).join('\n')

    try {
      const updatedJob = await window.api.updateTranscript(
        selectedJob.id,
        nextText,
        nextSegments
      )
      setAppState((current) => {
        if (!current) return current
        return {
          ...current,
          jobs: current.jobs.map((j) => (j.id === updatedJob.id ? updatedJob : j))
        }
      })
    } catch (err) {
      console.error(err)
      setErrorMessage(formatError(err))
    } finally {
      editSegmentDialogRef.current?.close()
      setEditingSegmentIndex(null)
    }
  }

  async function correctTranscriptWithAI(): Promise<void> {
    if (!selectedJob) return
    await runAction('使用 AI 矯正逐字稿錯別字與時間語意中...', async () => {
      const updatedJob = await window.api.correctTranscript(selectedJob.id)
      setAppState((current) => {
        if (!current) return current
        return {
          ...current,
          jobs: current.jobs.map((j) => (j.id === updatedJob.id ? updatedJob : j))
        }
      })
      setInfoMessage(`AI 矯正逐字稿完成！已過濾錯別字與發音模糊語詞。`)
    })
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
    setGlossarySearch('')
    setSelectionPopup(null)
    glossaryDialogRef.current?.showModal()
  }

  async function copyToClipboard(label: string, value: string): Promise<void> {
    if (!value.trim()) {
      return
    }

    try {
      await window.api.writeClipboard(value)
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

  async function loadGlossary(): Promise<void> {
    try {
      const entries = await window.api.getGlossary()
      setGlossary(entries)
    } catch (error) {
      setErrorMessage(formatError(error))
    }
  }

  async function addOrUpdateGlossaryEntry(): Promise<boolean> {
    if (!glossarySource.trim() || !glossaryTarget.trim()) return false

    // Duplicate check: same sourceTerm already exists (unless editing that very entry)
    const duplicate = glossary.find(
      (e) => e.sourceTerm.toLowerCase() === glossarySource.trim().toLowerCase() && e.id !== glossaryEditId
    )
    if (duplicate) {
      setErrorMessage(`「${glossarySource.trim()}」已存在於 Glossary 中（目標：${duplicate.targetTerm}）。如需修改，請先編輯該項目。`)
      return false
    }

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
      return true
    } catch (error) {
      setErrorMessage(formatError(error))
      return false
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
    setGlossarySearch('')
    glossaryDialogRef.current?.showModal()
  }

  function switchTab(key: string): void {
    setActiveTab(key)
    setTabSearchQuery('')
  }

  function addCustomTab(): void {
    const id = crypto.randomUUID()
    const newTab: CustomTab = { id, name: `自訂 ${customTabs.length + 1}`, prompt: '' }
    const updated = [...customTabs, newTab]
    setCustomTabs(updated)
    void window.api.saveCustomTabs(updated)
    switchTab(id)
  }

  function deleteCustomTab(tabId: string): void {
    const updated = customTabs.filter((t) => t.id !== tabId)
    setCustomTabs(updated)
    void window.api.saveCustomTabs(updated)
    if (activeTab === tabId) {
      switchTab('plainSummary')
    }
  }

  function openPromptDialog(tabId: string): void {
    const tab = customTabs.find((t) => t.id === tabId)
    if (!tab) return
    setPromptDialogTabId(tabId)
    setPromptDialogName(tab.name)
    setPromptDialogText(tab.prompt)
    promptDialogRef.current?.showModal()
  }

  function savePromptDialog(): void {
    if (!promptDialogTabId) return
    const updated = customTabs.map((t) =>
      t.id === promptDialogTabId ? { ...t, name: promptDialogName.trim() || t.name, prompt: promptDialogText } : t
    )
    setCustomTabs(updated)
    void window.api.saveCustomTabs(updated)
    promptDialogRef.current?.close()
    setPromptDialogTabId(null)
  }

  async function generateCustomTab(tabId: string): Promise<void> {
    if (!selectedJob) return
    const tab = customTabs.find((t) => t.id === tabId)
    if (!tab) return
    if (!tab.prompt.trim()) {
      setErrorMessage('請先設定提示詞。')
      return
    }

    await runAction('AI 解析中...', async () => {
      const result = await window.api.customAnalyze(selectedJob.id, tab.prompt)
      const key = `${selectedJob.id}-${tabId}`
      setCustomTabResults((prev) => {
        const updated = { ...prev, [key]: result }
        void window.api.saveCustomTabResults(updated)
        return updated
      })
    })
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
          {!selectedJob && (
            <>
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
            </>
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
        </div>
      </header>

      <dialog className="settings-dialog" ref={settingsDialogRef}>
        <div className="settings-dialog-header">
          <div>
            <h2>AI Settings</h2>
            <p>Choose OpenAI, Groq, or Gemini for transcription and summary generation.</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-end' }}>
            <span
              className={`pill ${appState?.settings.apiKeysConfigured[settingsForm.transcriptionProvider] ? 'pill-success' : 'pill-muted'}`}
            >
              Tx Key: {appState?.settings.apiKeysConfigured[settingsForm.transcriptionProvider] ? 'saved' : 'missing'}
            </span>
            <span
              className={`pill ${appState?.settings.apiKeysConfigured[settingsForm.summaryProvider] ? 'pill-success' : 'pill-muted'}`}
            >
              Sum Key: {appState?.settings.apiKeysConfigured[settingsForm.summaryProvider] ? 'saved' : 'missing'}
            </span>
          </div>
        </div>

        <div className="settings-grid">
          <label>
            <span>Transcription Provider</span>
            <select
              onChange={(event) =>
                setSettingsForm((current) => ({
                  ...current,
                  transcriptionProvider: event.target.value as ProviderId
                }))
              }
              value={settingsForm.transcriptionProvider}
            >
              {Object.entries(PROVIDER_LABELS).map(([provider, label]) => (
                <option key={provider} value={provider}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Summary Provider</span>
            <select
              onChange={(event) =>
                setSettingsForm((current) => ({
                  ...current,
                  summaryProvider: event.target.value as ProviderId
                }))
              }
              value={settingsForm.summaryProvider}
            >
              {Object.entries(PROVIDER_LABELS).map(([provider, label]) => (
                <option key={provider} value={provider}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <div className="settings-grid-wide" style={{ marginTop: '4px', borderTop: '1px solid var(--panel-border)', paddingTop: '14px' }}>
            <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', fontWeight: 'bold' }}>API Keys</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
              {(['openai', 'groq', 'gemini'] as const).map((prov) => {
                const keyProp = prov === 'openai' ? 'openaiApiKey' : prov === 'groq' ? 'groqApiKey' : 'geminiApiKey'
                return (
                  <div key={prov} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 'bold', color: 'var(--text-secondary)' }}>
                      {PROVIDER_LABELS[prov]} Key {appState?.settings.apiKeysConfigured[prov] ? '✅' : '❌'}
                    </span>
                    <input
                      type="password"
                      placeholder={appState?.settings.apiKeysConfigured[prov] ? '已儲存 (填寫以變更)' : '尚未儲存'}
                      value={settingsForm[keyProp] || ''}
                      style={{ padding: '8px 10px', borderRadius: '8px', fontSize: '13px' }}
                      onChange={(e) =>
                        setSettingsForm((current) => ({ ...current, [keyProp]: e.target.value }))
                      }
                    />
                    {appState?.settings.apiKeysConfigured[prov] && (
                      <button
                        type="button"
                        className="link-button danger-text"
                        style={{ fontSize: '11px', textAlign: 'left', marginTop: '2px', padding: 0 }}
                        onClick={() => void clearStoredApiKeyByProvider(prov)}
                      >
                        清除已儲存
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <label className="settings-grid-wide" style={{ borderTop: '1px solid var(--panel-border)', paddingTop: '14px' }}>
            <span>Transcription model</span>
            <div className="model-select-row">
              <div className="searchable-select-container" style={{ flex: 1 }}>
                <input
                  type="text"
                  className="searchable-select-input"
                  placeholder="搜尋或自行輸入模型名稱…"
                  value={txModelDropdownOpen ? txModelSearch : (settingsForm[`${settingsForm.transcriptionProvider}TranscriptionModel` as any] || '')}
                  onFocus={() => {
                    setTxModelSearch('')
                    setTxModelDropdownOpen(true)
                  }}
                  onBlur={() => {
                    // Slight delay to allow item clicks to proceed
                    setTimeout(() => setTxModelDropdownOpen(false), 200)
                  }}
                  onChange={(e) => {
                    const val = e.target.value
                    setTxModelSearch(val)
                    const prop = `${settingsForm.transcriptionProvider}TranscriptionModel` as any
                    setSettingsForm((current) => ({ ...current, [prop]: val }))
                  }}
                />
                {txModelDropdownOpen && (
                  <div className="searchable-select-dropdown">
                    {txProviderModels.length > 0 ? (
                      txProviderModels
                        .filter((m) => m.toLowerCase().includes(txModelSearch.toLowerCase()))
                        .map((model) => (
                          <button
                            key={model}
                            type="button"
                            className="searchable-select-item"
                            onMouseDown={() => {
                              const prop = `${settingsForm.transcriptionProvider}TranscriptionModel` as any
                              setSettingsForm((current) => ({ ...current, [prop]: model }))
                            }}
                          >
                            {model}
                          </button>
                        ))
                    ) : (
                      <div className="searchable-select-empty">請點擊 🔄 按鈕手動載入線上模型</div>
                    )}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="secondary-button refresh-models-btn"
                title="載入線上最新模型清單"
                onClick={() => void refreshModels('transcription')}
              >
                🔄
              </button>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              預設: {PROVIDER_DEFAULTS[settingsForm.transcriptionProvider].transcriptionModel}
            </span>
          </label>

          <label className="settings-grid-wide">
            <span>Summary model</span>
            <div className="model-select-row">
              <div className="searchable-select-container" style={{ flex: 1 }}>
                <input
                  type="text"
                  className="searchable-select-input"
                  placeholder="搜尋或自行輸入模型名稱…"
                  value={sumModelDropdownOpen ? sumModelSearch : (settingsForm[`${settingsForm.summaryProvider}SummaryModel` as any] || '')}
                  onFocus={() => {
                    setSumModelSearch('')
                    setSumModelDropdownOpen(true)
                  }}
                  onBlur={() => {
                    setTimeout(() => setSumModelDropdownOpen(false), 200)
                  }}
                  onChange={(e) => {
                    const val = e.target.value
                    setSumModelSearch(val)
                    const prop = `${settingsForm.summaryProvider}SummaryModel` as any
                    setSettingsForm((current) => ({ ...current, [prop]: val }))
                  }}
                />
                {sumModelDropdownOpen && (
                  <div className="searchable-select-dropdown">
                    {sumProviderModels.length > 0 ? (
                      sumProviderModels
                        .filter((m) => m.toLowerCase().includes(sumModelSearch.toLowerCase()))
                        .map((model) => (
                          <button
                            key={model}
                            type="button"
                            className="searchable-select-item"
                            onMouseDown={() => {
                              const prop = `${settingsForm.summaryProvider}SummaryModel` as any
                              setSettingsForm((current) => ({ ...current, [prop]: model }))
                            }}
                          >
                            {model}
                          </button>
                        ))
                    ) : (
                      <div className="searchable-select-empty">請點擊 🔄 按鈕手動載入線上模型</div>
                    )}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="secondary-button refresh-models-btn"
                title="載入線上最新模型清單"
                onClick={() => void refreshModels('summary')}
              >
                🔄
              </button>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              預設: {PROVIDER_DEFAULTS[settingsForm.summaryProvider].summaryModel}
            </span>
          </label>

          <div className="settings-grid-wide" style={{ borderTop: '1px solid var(--panel-border)', paddingTop: '10px' }}>
            <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', fontWeight: 'bold' }}>Base URLs</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px' }}>
              <label>
                <span>OpenAI Base URL</span>
                <input
                  type="text"
                  value={settingsForm.openaiBaseUrl}
                  style={{ padding: '8px 10px', borderRadius: '8px', fontSize: '13px' }}
                  onChange={(e) => setSettingsForm((current) => ({ ...current, openaiBaseUrl: e.target.value }))}
                />
              </label>
              <label>
                <span>Groq Base URL</span>
                <input
                  type="text"
                  value={settingsForm.groqBaseUrl}
                  style={{ padding: '8px 10px', borderRadius: '8px', fontSize: '13px' }}
                  onChange={(e) => setSettingsForm((current) => ({ ...current, groqBaseUrl: e.target.value }))}
                />
              </label>
            </div>
          </div>

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

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settingsForm.identifySpeakers}
              onChange={(event) =>
                setSettingsForm((current) => ({ ...current, identifySpeakers: event.target.checked }))
              }
            />
            <span>辨識發言者 (轉逐字稿時標註不同說話者)</span>
          </label>
          {settingsForm.identifySpeakers && settingsForm.transcriptionProvider !== 'gemini' && (
            <div className="warning-banner" style={{ padding: '8px 12px', border: '1px solid', borderRadius: '8px', fontSize: '12px' }}>
              ⚠️ 提醒：您目前為「轉錄」選擇的 {PROVIDER_LABELS[settingsForm.transcriptionProvider] || settingsForm.transcriptionProvider} / {settingsForm[`${settingsForm.transcriptionProvider}TranscriptionModel` as any] || '預設模型'} 不支援發言者識別 (Diarization)。如需發言者辨識，請使用 Gemini 或可產生 Diarization 的其餘支援模型，否則將無法自動貼上說話者標籤。
            </div>
          )}
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
            onClick={() => settingsDialogRef.current?.close()}
            type="button"
          >
            Close
          </button>
        </div>
      </dialog>

      <dialog className="settings-dialog" ref={glossaryDialogRef}>        <div className="settings-dialog-header">
          <div>
            <h2>Glossary</h2>
            <p>Define term replacements applied to transcripts and summaries.</p>
          </div>
          <span className="pill">{glossary.length} entries</span>
        </div>

        <input
          type="search"
          className="tab-search-input"
          placeholder="搜尋詞彙…"
          value={glossarySearch}
          onChange={(e) => setGlossarySearch(e.target.value)}
          style={{ marginBottom: '10px' }}
        />

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
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void addOrUpdateGlossaryEntry().then((ok) => { if (ok) glossaryDialogRef.current?.close() })
              }
            }}
          />
          <button
            className="secondary-button"
            onClick={() => void addOrUpdateGlossaryEntry().then((ok) => { if (ok) glossaryDialogRef.current?.close() })}
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
            glossary
              .filter((e) =>
                !glossarySearch.trim() ||
                e.sourceTerm.toLowerCase().includes(glossarySearch.toLowerCase()) ||
                e.targetTerm.toLowerCase().includes(glossarySearch.toLowerCase())
              )
              .map((entry) => (
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

      <dialog className="settings-dialog" ref={promptDialogRef}>
        <div className="settings-dialog-header">
          <div>
            <h2>提示詞設定</h2>
            <p>設定名稱與提示詞，AI 將根據提示詞分析逐字稿內容。</p>
          </div>
        </div>

        <div className="settings-grid">
          <label>
            <span>名稱</span>
            <input
              value={promptDialogName}
              onChange={(e) => setPromptDialogName(e.target.value)}
              placeholder="自訂分析名稱"
            />
          </label>
          <label className="settings-grid-wide">
            <span>提示詞</span>
            <textarea
              className="prompt-textarea"
              rows={6}
              value={promptDialogText}
              onChange={(e) => setPromptDialogText(e.target.value)}
              placeholder="例如：請列出本次會議提到的所有數字與統計資料"
            />
          </label>
        </div>

        <div className="toolbar settings-dialog-toolbar">
          <button className="primary-button" onClick={savePromptDialog} type="button">
            確定
          </button>
          <button
            className="ghost-button"
            onClick={() => promptDialogRef.current?.close()}
            type="button"
          >
            取消
          </button>
        </div>
      </dialog>

      <dialog className="settings-dialog" ref={renameDialogRef}>
        <div className="settings-dialog-header">
          <h2>更改標題</h2>
        </div>
        <div className="settings-grid">
          <label className="settings-grid-wide">
            <span>新標題</span>
            <input
              value={renameDialogValue}
              onChange={(e) => setRenameDialogValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submitRenameDialog() }}
              placeholder="輸入新標題"
              autoFocus
            />
          </label>
        </div>
        <div className="toolbar settings-dialog-toolbar">
          <button className="primary-button" onClick={() => void submitRenameDialog()} type="button">
            確定
          </button>
          <button
            className="ghost-button"
            onClick={() => renameDialogRef.current?.close()}
            type="button"
          >
            取消
          </button>
        </div>
      </dialog>

      <dialog className="settings-dialog edit-segment-dialog" ref={editSegmentDialogRef}>
        <div className="settings-dialog-header">
          <h2>編輯逐字稿</h2>
        </div>
        {/* Playback mini-toolbar */}
        {(() => {
          const seg = editingSegmentIndex !== null
            ? selectedJob?.transcriptSegments.find(s => s.index === editingSegmentIndex)
            : null
          if (!seg || !audioUrl) return null
          const seekTo = (offset: number) => {
            const a = audioRef.current
            if (!a) return
            const next = Math.min(seg.endSeconds, Math.max(seg.startSeconds, a.currentTime + offset))
            a.currentTime = next
          }
          const playSegment = () => {
            const a = audioRef.current
            if (!a) return
            if (!a.paused) {
              a.pause()
              return
            }
            segmentEndRef.current = seg.endSeconds
            segmentLoopStartRef.current = seg.startSeconds
            if (a.currentTime < seg.startSeconds || a.currentTime >= seg.endSeconds) {
              a.currentTime = seg.startSeconds
            }
            void a.play()
          }
          const toggleLoop = () => {
            const next = !loopEditDialog
            setLoopEditDialog(next)
            loopModeRef.current = next
          }
          return (
            <div className="edit-dialog-playback">
              <span className="edit-dialog-ts">[{formatSec(seg.startSeconds)} – {formatSec(seg.endSeconds)}]</span>
              <button className="ghost-button edit-dialog-ctrl" type="button" title="-15 秒" onClick={() => seekTo(-15)}>-15</button>
              <button className="ghost-button edit-dialog-ctrl" type="button" title="+15 秒" onClick={() => seekTo(+15)}>+15</button>
              <button className="ghost-button edit-dialog-ctrl" type="button" title={isAudioPlaying ? '暫停' : '播放此段'} onClick={playSegment}>
                {isAudioPlaying ? '⏸' : '▶'}
              </button>
              <button
                className={`ghost-button edit-dialog-ctrl ${loopEditDialog ? 'edit-dialog-ctrl-active' : ''}`}
                type="button"
                title={loopEditDialog ? '關閉循環' : '循環播放此段'}
                onClick={toggleLoop}
              >🔁</button>
            </div>
          )
        })()}
        <div className="settings-grid">
          <label className="settings-grid-wide">
            <textarea
              value={editingSegmentText}
              onChange={(e) => setEditingSegmentText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void saveEditingSegment()
                } else if (e.key === 'Escape') {
                  editSegmentDialogRef.current?.close()
                  setEditingSegmentIndex(null)
                }
              }}
              style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: '14px' }}
              autoFocus
            />
          </label>
        </div>
        <div className="toolbar settings-dialog-toolbar">
          <button className="primary-button" onClick={() => void saveEditingSegment()} type="button">
            儲存 (Enter)
          </button>
          <button
            className="ghost-button"
            onClick={() => { editSegmentDialogRef.current?.close(); setEditingSegmentIndex(null) }}
            type="button"
          >
            取消
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
                   onClick={() => renameJob(selectedJob.id)}
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
                  <label className="checkbox-label toolbar-toggle" style={{ marginLeft: '12px' }}>
                    <input
                      type="checkbox"
                      checked={!hideSpeakers}
                      onChange={(e) => setHideSpeakers(!e.target.checked)}
                    />
                    <span>顯示說話者</span>
                  </label>
                  <label className="checkbox-label toolbar-toggle" style={{ marginLeft: '12px' }}>
                    <input
                      type="checkbox"
                      checked={showOnlyConfirmed}
                      onChange={(e) => setShowLowConfidenceOnly(e.target.checked)}
                    />
                    <span>僅顯示需確認的句子</span>
                  </label>
                </div>
              </div>

              {audioUrl && selectedJob && (
                <div className="audio-player-container" style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '6px 12px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px dashed var(--border-color)', marginBottom: '6px' }}>
                  <div className="audio-player" style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%', margin: '2px 0', padding: '4px 8px' }}>
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
                      style={{ flex: 1 }}
                      onTimeUpdate={() => {
                        const a = audioRef.current
                        if (a) {
                          setCurrentAudioTime(a.currentTime)
                          if (segmentEndRef.current !== null && a.currentTime >= segmentEndRef.current) {
                            if (loopModeRef.current && segmentLoopStartRef.current !== null) {
                              a.currentTime = segmentLoopStartRef.current
                              void a.play()
                            } else {
                              a.pause()
                              segmentEndRef.current = null
                            }
                          }
                        }
                      }}
                      onPlay={() => setIsAudioPlaying(true)}
                      onPause={() => setIsAudioPlaying(false)}
                    />
                  </div>
                  <div className="trimming-controls" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', fontSize: '12px' }}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        className="secondary-button"
                        type="button"
                        title="將播放進度條目前的時間，設為會議正式開始的標記，翻譯時會以此為起點"
                        onClick={async () => {
                          const a = audioRef.current
                          if (a) {
                            const val = Number(a.currentTime.toFixed(1))
                            try {
                              const updatedJob = await window.api.updateJobTrimming(selectedJob.id, val, selectedJob.trimEnd)
                              setAppState((current) => {
                                if (!current) return current
                                return {
                                  ...current,
                                  jobs: current.jobs.map((j) => (j.id === updatedJob.id ? updatedJob : j))
                                }
                              })
                              setInfoMessage(`已設定會議開始時間標記：${formatSec(val)}。請重新點擊「翻譯與分析」來應用此範圍。`)
                            } catch (err) {
                              setErrorMessage(formatError(err))
                            }
                          }
                        }}
                      >
                        🚩 設為錄音開始標記 ({formatSec(currentAudioTime)})
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        title="將播放進度條目前的時間，設為會議正式結束的標記，翻譯時會以此為終點"
                        onClick={async () => {
                          const a = audioRef.current
                          if (a) {
                            const val = Number(a.currentTime.toFixed(1))
                            try {
                              const updatedJob = await window.api.updateJobTrimming(selectedJob.id, selectedJob.trimStart, val)
                              setAppState((current) => {
                                if (!current) return current
                                return {
                                  ...current,
                                  jobs: current.jobs.map((j) => (j.id === updatedJob.id ? updatedJob : j))
                                }
                              })
                              setInfoMessage(`已設定會議暫停/結束標記：${formatSec(val)}。請重新點擊「翻譯與分析」來應用此範圍。`)
                            } catch (err) {
                              setErrorMessage(formatError(err))
                            }
                          }
                        }}
                      >
                        🏁 設為錄音停止標記 ({formatSec(currentAudioTime)})
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        style={{
                          backgroundColor: trackActiveLine ? 'rgba(59, 130, 246, 0.2)' : undefined,
                          color: trackActiveLine ? '#60a5fa' : undefined,
                          borderColor: trackActiveLine ? '#3b82f6' : undefined
                        }}
                        title={trackActiveLine ? "自動滾動並聚焦當前播放的句子（已開啟）" : "自動滾動並聚焦當前播放的句子（已關閉）"}
                        onClick={() => setTrackActiveLine(!trackActiveLine)}
                      >
                        {trackActiveLine ? '🎯 追蹤當前段落：開啟' : '📍 追蹤當前時段：關閉'}
                      </button>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        目前有效錄音範圍：
                        <strong style={{ color: selectedJob.trimStart || selectedJob.trimEnd ? '#3b82f6' : 'inherit' }}>
                          [{selectedJob.trimStart !== null ? formatSec(selectedJob.trimStart) : '00:00:00'} - {selectedJob.trimEnd !== null ? formatSec(selectedJob.trimEnd) : '全部結束'}]
                        </strong>
                      </span>
                      {(selectedJob.trimStart !== null || selectedJob.trimEnd !== null) && (
                        <button
                          className="link-button"
                          type="button"
                          style={{ color: '#ef4444' }}
                          onClick={async () => {
                            try {
                              const updatedJob = await window.api.updateJobTrimming(selectedJob.id, null, null)
                              setAppState((current) => {
                                if (!current) return current
                                return {
                                  ...current,
                                  jobs: current.jobs.map((j) => (j.id === updatedJob.id ? updatedJob : j))
                                }
                              })
                              setInfoMessage(`已清除範圍裁切標記，將翻譯完整影音檔。`)
                            } catch (err) {
                              setErrorMessage(formatError(err))
                            }
                          }}
                        >
                          清除標記 ✕
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="tab-bar">
                {([{ key: 'transcript', label: 'Transcript' }, ...summarySections.map((s) => ({ key: s.key, label: s.label }))]).map((tab) => (
                  <button
                    key={tab.key}
                    className={`tab-button ${activeTab === tab.key ? 'active' : ''}`}
                    onClick={() => switchTab(tab.key)}
                    type="button"
                  >
                    {tab.label}
                  </button>
                ))}
                {customTabs.map((tab) => (
                  <button
                    key={tab.id}
                    className={`tab-button tab-custom ${activeTab === tab.id ? 'active' : ''}`}
                    onClick={() => switchTab(tab.id)}
                    type="button"
                  >
                    {tab.name}
                    <span
                      className="tab-close"
                      role="button"
                      aria-label="刪除"
                      onClick={(e) => { e.stopPropagation(); deleteCustomTab(tab.id) }}
                    >
                      ×
                    </span>
                  </button>
                ))}
                <button className="tab-button tab-add" onClick={addCustomTab} type="button" title="新增自訂分析">
                  +
                </button>
              </div>
              <div className="tab-search-bar">
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <input
                    type="search"
                    className="tab-search-input"
                    style={{ flex: 1 }}
                    placeholder="搜尋關鍵字…"
                    value={tabSearchQuery}
                    onChange={(e) => { setTabSearchQuery(e.target.value); setTranscriptSearchIndex(0) }}
                    onKeyDown={(e) => {
                      if (activeTab !== 'transcript' || !tabSearchQuery.trim() || transcriptMatchCount === 0) return
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        if (e.shiftKey) {
                          setTranscriptSearchIndex((i) => (i - 1 + transcriptMatchCount) % transcriptMatchCount)
                        } else {
                          setTranscriptSearchIndex((i) => (i + 1) % transcriptMatchCount)
                        }
                      }
                    }}
                  />
                  {activeTab === 'transcript' && tabSearchQuery.trim() && transcriptMatchCount > 0 && (
                    <>
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {Math.min(transcriptSearchIndex, transcriptMatchCount - 1) + 1}/{transcriptMatchCount}
                      </span>
                      <button
                        className="ghost-button"
                        type="button"
                        title="上一個 (Shift+Enter)"
                        onClick={() => setTranscriptSearchIndex((i) => (i - 1 + transcriptMatchCount) % transcriptMatchCount)}
                      >◀</button>
                      <button
                        className="ghost-button"
                        type="button"
                        title="下一個 (Enter)"
                        onClick={() => setTranscriptSearchIndex((i) => (i + 1) % transcriptMatchCount)}
                      >▶</button>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="tab-content" ref={tabContentRef}>
              {activeTab === 'transcript' ? (                <article className="transcript-panel">
                  <div className="summary-card-header">
                    <h3>Transcript</h3>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        className="link-button"
                        onClick={correctTranscriptWithAI}
                        disabled={Boolean(busyAction) || isRecording || selectedJob.transcriptSegments.length === 0}
                        type="button"
                        style={{ color: '#10b981' }}
                        title="使用 AI 矯正全篇逐字稿中的錯別字、同音異義字（如消金、契金等術語），並完整保留對齊的時間戳記"
                      >
                        AI 矯正 🪄
                      </button>
                      <button
                        className="link-button"
                        onClick={() => void copyToClipboard('Transcript', selectedJob.transcriptText)}
                        type="button"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                  {selectedJob.transcriptSegments.length > 0 ? (
                    <div className="transcript-lines">
                      {(() => {
                        let matchOrdinal = -1
                        const currentMatchTarget = Math.min(transcriptSearchIndex, transcriptMatchCount - 1)
                        return selectedJob.transcriptSegments
                          .filter((seg) => !tabSearchQuery.trim() || seg.text.toLowerCase().includes(tabSearchQuery.toLowerCase()))
                          .filter((seg) => !showOnlyConfirmed || Boolean(seg.lowConfidence))
                          .map((seg) => {
                          const active = currentAudioTime >= seg.startSeconds && currentAudioTime < seg.endSeconds
                          const isLowConfidence = Boolean(seg.lowConfidence)
                          const isSearchMatch = Boolean(tabSearchQuery.trim()) && seg.text.toLowerCase().includes(tabSearchQuery.toLowerCase())
                          if (isSearchMatch) matchOrdinal++
                          const isCurrentMatch = isSearchMatch && matchOrdinal === currentMatchTarget
                          const speakerRegex = /^([^:\uff1a\n]+)\s*[:\uff1a]\s*(.*)$/
                          const speakerMatch = seg.text.match(speakerRegex)
                          return (
                            <p
                              key={seg.index}
                              ref={isCurrentMatch ? (el) => { transcriptMatchRef.current = el } : undefined}
                              className={`transcript-line ${active ? 'active-line' : ''} ${isLowConfidence ? 'low-confidence-line' : ''} ${isCurrentMatch ? 'current-search-match' : ''}`}
                            >
                              <span
                                className="line-ts"
                                title="點擊播放此段音檔"
                                onClick={() => {
                                  const a = audioRef.current
                                  if (a) {
                                    segmentEndRef.current = seg.endSeconds
                                    a.currentTime = seg.startSeconds
                                    void a.play()
                                  }
                                }}
                                style={{ cursor: 'pointer', paddingRight: '4px', opacity: active ? 1 : 0.8 }}
                              >
                                ▶ [{formatSec(seg.startSeconds)}]
                              </span>
                              <>
                                  <span
                                    className="transcript-text-span"
                                    title={isLowConfidence ? "⚠️ 語意或發音可能較不清晰，按兩下即可編輯此處內容" : "按兩下即可編輯此處內容"}
                                    onDoubleClick={() => {
                                      setEditingSegmentIndex(seg.index)
                                      setEditingSegmentText(seg.text)
                                      editSegmentDialogRef.current?.showModal()
                                    }}
                                    style={{
                                      flex: 1,
                                      borderBottom: isLowConfidence ? '1.5px dotted #eab308' : undefined,
                                      paddingBottom: isLowConfidence ? '1px' : undefined
                                    }}
                                  >
                                    {speakerMatch ? (
                                      hideSpeakers ? (
                                        highlightText(speakerMatch[2], tabSearchQuery)
                                      ) : (
                                        <>
                                          <strong className="speaker-label" style={{ color: 'var(--accent-color, #3b82f6)', marginRight: '6px', fontWeight: 'bold' }}>
                                            {speakerMatch[1]}:
                                          </strong>
                                          {highlightText(speakerMatch[2], tabSearchQuery)}
                                        </>
                                      )
                                    ) : (
                                      highlightText(seg.text, tabSearchQuery)
                                    )}
                                    {isLowConfidence && (
                                      <span
                                        style={{
                                          color: '#eab308',
                                          marginLeft: '6px',
                                          fontSize: '11px',
                                          fontWeight: 'bold',
                                          padding: '1px 4px',
                                          background: 'rgba(234, 179, 8, 0.1)',
                                          borderRadius: '3px',
                                          userSelect: 'none'
                                        }}
                                        title="辨識品質可能較低，建議人為檢查"
                                      >
                                        ⚠️ 建議確認
                                      </span>
                                    )}
                                  </span>
                                  {/* Double-click the paragraph to edit, pencil button removed per guidelines */}
                                </>
                            </p>
                          )
                        })
                      })()}
                    </div>
                  ) : (
                    <pre className="transcript-text">
                      {selectedJob.transcriptText || 'No transcript generated yet.'}
                    </pre>
                  )}
                  {selectedJob.errorMessage ? <p className="error-inline">{selectedJob.errorMessage}</p> : null}
                </article>
              ) : customTabs.some((t) => t.id === activeTab) ? (
                (() => {
                  const tab = customTabs.find((t) => t.id === activeTab)!
                  const resultKey = `${selectedJob.id}-${activeTab}`
                  const result = customTabResults[resultKey] ?? ''
                  return (
                    <article className="summary-card">
                      <div className="summary-card-header">
                        <h3>{tab.name}</h3>
                        <div className="toolbar">
                          <button
                            className="secondary-button"
                            onClick={() => openPromptDialog(tab.id)}
                            type="button"
                          >
                            提示詞
                          </button>
                          <button
                            className="primary-button"
                            disabled={Boolean(busyAction) || !selectedJob.transcriptText}
                            onClick={() => void generateCustomTab(tab.id)}
                            type="button"
                          >
                            產出
                          </button>
                          {result ? (
                            <button
                              className="link-button"
                              onClick={() => void copyToClipboard(tab.name, result)}
                              type="button"
                            >
                              Copy
                            </button>
                          ) : null}
                        </div>
                      </div>
                      {result ? (
                        <div className="summary-lines">
                          {result.replace(/<br\s*\/?>/gi, '\n').split('\n')
                            .map((line, origIdx) => ({ line, origIdx }))
                            .filter(({ line }) => !tabSearchQuery.trim() || line.toLowerCase().includes(tabSearchQuery.toLowerCase()))
                            .map(({ line, origIdx }) => (
                              <p key={origIdx} className="summary-line">{highlightText(line, tabSearchQuery)}</p>
                            ))}
                        </div>
                      ) : (
                        <div className="summary-content">
                          {tab.prompt ? '按「產出」以使用 AI 解析逐字稿。' : '請先按「提示詞」設定分析指令。'}
                        </div>
                      )}
                    </article>
                  )
                })()
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
                          {rawText.replace(/<br\s*\/?>/gi, '\n').split('\n')
                            .map((line, origIdx) => ({ line, origIdx }))
                            .filter(({ line }) => !tabSearchQuery.trim() || line.toLowerCase().includes(tabSearchQuery.toLowerCase()))
                            .map(({ line, origIdx }) => {
                              const ts = parseLineTimestamp(line)
                              const active = ts ? currentAudioTime >= ts.start && currentAudioTime < ts.end : false
                              return (
                                <p
                                  key={origIdx}
                                  className={`summary-line ${active ? 'active-line' : ''}`}
                                  onDoubleClick={() => {
                                    if (!ts) return
                                    const a = audioRef.current
                                    if (a) {
                                      segmentEndRef.current = ts.end
                                      a.currentTime = ts.start
                                      void a.play()
                                    }
                                  }}
                                  style={ts ? { cursor: 'pointer' } : undefined}
                                >
                                  {highlightText(line, tabSearchQuery)}
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
                      onClick={(e) => { e.stopPropagation(); renameJob(job.id) }}
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

function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  return parts.map((part, i) =>
    i % 2 === 1 ? <mark key={i} className="search-highlight">{part}</mark> : part
  )
}

export default App
