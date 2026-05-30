import { createReadStream } from 'fs'

import OpenAI from 'openai'

import {
  AUDIO_CHUNK_SECONDS,
  EMPTY_SUMMARY,
  OUTPUT_LANGUAGE_LABELS,
  PROVIDER_LABELS,
  type OutputLanguage,
  type SectionPrompts,
  type SummaryBundle,
  type TranscriptSegment
} from '../shared/contracts'
import type { ProviderConfig, TranscriptPayload } from './database'
import { formatTimestampedTranscript, parseCorrectedTranscript, splitSentences } from './text-utils'

export class OpenAICompatibleProvider {
  private readonly client: OpenAI

  constructor(private readonly config: ProviderConfig) {
    if (!config.apiKey) {
      throw new Error(`${PROVIDER_LABELS[config.provider]} API key is not configured.`)
    }

    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl || undefined
    })
  }

  async transcribeAudio(chunkPaths: string[]): Promise<TranscriptPayload> {
    const transcriptSegments: TranscriptSegment[] = []

    for (const [index, chunkPath] of chunkPaths.entries()) {
      let response
      try {
        response = await this.client.audio.transcriptions.create({
          file: createReadStream(chunkPath),
          model: this.config.transcriptionModel,
          response_format: 'verbose_json',
          prompt: buildTranscriptionPrompt(this.config.outputLanguage, this.config.identifySpeakers)
        })
      } catch (err: any) {
        const errMsg = err && typeof err.message === 'string' ? err.message : ''
        if (
          errMsg.includes('verbose_json') ||
          errMsg.includes('unsupported_value') ||
          err?.status === 400
        ) {
          console.log(`[OpenAICompatibleProvider] Model does not support 'verbose_json', trying 'json' as fallback.`)
          response = await this.client.audio.transcriptions.create({
            file: createReadStream(chunkPath),
            model: this.config.transcriptionModel,
            response_format: 'json',
            prompt: buildTranscriptionPrompt(this.config.outputLanguage, this.config.identifySpeakers)
          })
        } else {
          throw err
        }
      }

      const baseOffset = index * AUDIO_CHUNK_SECONDS
      const rawSegments =
        'segments' in response && Array.isArray(response.segments) ? response.segments : []

      if (rawSegments.length > 0) {
        // Filter out Whisper hallucinations caused by silence or low-quality audio.
        // Whisper tends to repeat phrases (e.g. "Food management model.") when it
        // encounters silence. We drop segments where:
        //   - no_speech_prob > 0.6  (model itself says there's likely no speech)
        //   - compression_ratio > 2.4  (highly repetitive text = hallucination loop)
        const validSegments = rawSegments.filter((seg) => {
          const s = seg as unknown as Record<string, unknown>
          const noSpeechProb = Number(s.no_speech_prob ?? 0)
          const compressionRatio = Number(s.compression_ratio ?? 1)
          return noSpeechProb <= 0.6 && compressionRatio <= 2.4
        })

        transcriptSegments.push(
          ...validSegments.map((segment, segmentIndex) => {
            const s = segment as unknown as Record<string, unknown>
            const avgLogprob = Number(s.avg_logprob ?? 0)
            const temperature = Number(s.temperature ?? 0)
            const lowConfidence = avgLogprob < -0.85 || temperature > 0.6
            return {
              index: transcriptSegments.length + segmentIndex,
              startSeconds: Number(segment.start ?? 0) + baseOffset,
              endSeconds: Number(segment.end ?? 0) + baseOffset,
              text: String(segment.text ?? '').trim(),
              lowConfidence
            }
          })
        )
      } else {
        const chunkText = response.text.trim()
        if (chunkText) {
          const sentences = splitSentences(chunkText)
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)

          if (sentences.length > 0) {
            const segmentDuration = AUDIO_CHUNK_SECONDS / sentences.length
            sentences.forEach((sentence, sIdx) => {
              transcriptSegments.push({
                index: transcriptSegments.length,
                startSeconds: baseOffset + sIdx * segmentDuration,
                endSeconds: baseOffset + (sIdx + 1) * segmentDuration,
                text: sentence
              })
            })
          }
        }
      }
    }

    // Build text with sentence-level line breaks from segments
    const text = transcriptSegments.map((s) => s.text).join('\n')

    return { text, segments: transcriptSegments }
  }

  async summarizeTranscript(transcript: string, segments: TranscriptSegment[]): Promise<SummaryBundle> {
    if (!transcript.trim()) {
      throw new Error('Transcript is empty, so there is nothing to summarize.')
    }

    const timestampedTranscript = formatTimestampedTranscript(segments) || transcript

    const responseFormat: OpenAI.ResponseFormatJSONSchema | OpenAI.ResponseFormatJSONObject | undefined =
      this.config.provider === 'openai'
        ? {
            type: 'json_schema',
            json_schema: {
              name: 'SummaryBundle',
              strict: true,
              schema: {
                type: 'object',
                properties: {
                  plainSummary: { type: 'string', description: 'Summary paragraph' },
                  meetingMinutes: { type: 'string', description: 'Meeting notes' },
                  actionItems: { type: 'string', description: 'Action items' },
                  keyDecisions: { type: 'string', description: 'Key decisions' },
                  nextSteps: { type: 'string', description: 'Next steps' }
                },
                required: [
                  'plainSummary',
                  'meetingMinutes',
                  'actionItems',
                  'keyDecisions',
                  'nextSteps'
                ],
                additionalProperties: false
              }
            }
          }
        : undefined

    const completion = await this.client.chat.completions.create({
      model: this.config.summaryModel,
      max_tokens: 8192,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      messages: [
        {
          role: 'system',
          content: buildSummarizationSystemPrompt(this.config.outputLanguage, this.config.showTimestamps, this.config.sectionPrompts)
        },
        {
          role: 'user',
          content: `Summarize this timestamped transcript and fill every field with relevant content:\n\n${timestampedTranscript}`
        }
      ]
    })

    const content = completion.choices[0]?.message.content
    if (!content) {
      throw new Error('The summary provider returned an empty response.')
    }

    return parseSummaryBundle(content)
  }
  async analyzeWithPrompt(transcript: string, prompt: string): Promise<string> {
    if (!transcript.trim()) {
      throw new Error('Transcript is empty, so there is nothing to analyze.')
    }

    const languageNote =
      this.config.outputLanguage === 'auto'
        ? 'Use the same language as the transcript.'
        : `Always respond in ${OUTPUT_LANGUAGE_LABELS[this.config.outputLanguage]}.`

    const completion = await this.client.chat.completions.create({
      model: this.config.summaryModel,
      messages: [
        {
          role: 'system',
          content: `You are a helpful assistant analyzing a meeting transcript. ${languageNote}`
        },
        {
          role: 'user',
          content: `${prompt}\n\n<transcript>\n${transcript}\n</transcript>`
        }
      ]
    })

    return completion.choices[0]?.message.content?.trim() ?? ''
  }

  async correctTranscript(transcript: string, segments: TranscriptSegment[]): Promise<TranscriptPayload> {
    if (!transcript.trim()) {
      throw new Error('Transcript is empty, so there is nothing to correct.')
    }

    const timestampedTranscript = formatTimestampedTranscript(segments) || transcript
    const languageNote =
      this.config.outputLanguage === 'auto'
        ? 'Use the same language as the transcript.'
        : this.config.outputLanguage === 'zh-TW'
          ? 'Always respond in Taiwanese Traditional Chinese (繁體中文/正體中文), using Taiwan local terms and phrases. Ensure no Simplified Chinese characters are present.'
          : `Always respond in ${OUTPUT_LANGUAGE_LABELS[this.config.outputLanguage]}.`

    const speakerRule = this.config.identifySpeakers
      ? '5. Since speaker identification (identifySpeakers) is enabled, you MUST analyze the conversational context, speaker flow, and back-and-forth Q&A, and prefix each line with a speaker identifier (e.g., "說話者 A: ", "說話者 B: " or "Speaker A: ", "Speaker B: " depending on context/language) of who is speaking. Do this line-by-line. If a line already contains a speaker label, keep or optimize/rename it. The correct line format is: "[HH:MM:SS - HH:MM:SS] Speaker name: <corrected text>"'
      : '5. Do not add or invent speaker prefixes if they are not already present in the original transcript.'

    const completion = await this.client.chat.completions.create({
      model: this.config.summaryModel,
      messages: [
        {
          role: 'system',
          content: `You are an expert editor specializing in correcting voice transcriptions.
Your task is to fix spelling, grammar, punctuation, and particularly homophones or voice transcription mistakes based on sentence context.

CRITICAL RULES:
1. You must maintain the exact structure of the transcript, keeping all timestamps "[HH:MM:SS - HH:MM:SS]" exactly intact. Do not change any timestamp.
2. Only correct the text portion.
3. Every output line must preserve the timestamp format: "[HH:MM:SS - HH:MM:SS] <corrected text>"
4. Do not summarize, do not omit lines, and do not add any markdown fences, headers, comments, conversational fluff, or introduction. Return ONLY the line-by-line corrected timestamped transcript.
${speakerRule}
6. ${languageNote}`
        },
        {
          role: 'user',
          content: `Please correct the following timestamped transcript. Correct all homophones and typos while keeping timestamps exactly unmodified:\n\n${timestampedTranscript}`
        }
      ]
    })

    const content = completion.choices[0]?.message.content ?? ''
    return parseCorrectedTranscript(content, segments)
  }
}

function buildTranscriptionPrompt(language: OutputLanguage, identifySpeakers: boolean): string {
  const parts: string[] = []
  if (language === 'zh-TW') {
    parts.push('這是一篇繁體中文、正體中文的會議逐字稿記錄，標點符號一律使用全形，請用繁體字及台灣語境寫作（例如：使用消金、企金、專案，不使用簡體字。）。')
  } else if (language !== 'auto') {
    parts.push(`Please output the transcription in ${OUTPUT_LANGUAGE_LABELS[language]}.`)
  }
  if (identifySpeakers) {
    parts.push('Identify and label different speakers (e.g., Speaker 1:, Speaker 2:).')
  }
  return parts.join(' ')
}

function buildSummarizationSystemPrompt(language: OutputLanguage, showTimestamps: boolean, prompts: SectionPrompts): string {
  const timestampNote = showTimestamps
    ? 'each starting with "- [HH:MM:SS - HH:MM:SS] "'
    : ''

  const lines = [
    'You produce structured meeting summaries.',
    'The transcript below includes timestamps in [HH:MM:SS - HH:MM:SS] format for each segment.',
    'Return ONLY a valid JSON object (no markdown fences, no explanation) with exactly these string fields:',
    `- plainSummary: ${prompts.plainSummary}`,
    `- meetingMinutes: ${prompts.meetingMinutes}`,
    `- actionItems: ${prompts.actionItems}${showTimestamps ? ', ' + timestampNote : ''}`,
    `- keyDecisions: ${prompts.keyDecisions}${showTimestamps ? ', ' + timestampNote : ''}`,
    `- nextSteps: ${prompts.nextSteps}${showTimestamps ? ', ' + timestampNote : ''}`,
    'Every field must contain relevant content.'
  ]

  if (language === 'auto') {
    lines.push('Use the same language as the transcript.')
  } else {
    lines.push(`Always respond in ${OUTPUT_LANGUAGE_LABELS[language]}.`)
  }

  return lines.join('\n')
}

export function parseSummaryBundle(jsonText: string): SummaryBundle {
  const cleaned = extractJson(jsonText)
  const parsed = safeJsonParse(cleaned)
  const summary = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}

  return {
    ...EMPTY_SUMMARY,
    plainSummary: sanitizeSection(summary.plainSummary),
    meetingMinutes: sanitizeSection(summary.meetingMinutes),
    actionItems: sanitizeSection(summary.actionItems),
    keyDecisions: sanitizeSection(summary.keyDecisions),
    nextSteps: sanitizeSection(summary.nextSteps)
  }
}

/** Try to parse JSON, repairing truncated strings/objects if needed. */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Attempt to repair truncated JSON by closing open strings and braces
    let repaired = text
    // Close any unterminated string
    const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length
    if (quoteCount % 2 !== 0) {
      repaired += '"'
    }
    // Close any unclosed braces/brackets
    let braces = 0
    let brackets = 0
    let inString = false
    for (let i = 0; i < repaired.length; i++) {
      const ch = repaired[i]
      if (ch === '"' && (i === 0 || repaired[i - 1] !== '\\')) {
        inString = !inString
      }
      if (!inString) {
        if (ch === '{') braces++
        else if (ch === '}') braces--
        else if (ch === '[') brackets++
        else if (ch === ']') brackets--
      }
    }
    repaired += ']'.repeat(Math.max(0, brackets))
    repaired += '}'.repeat(Math.max(0, braces))

    try {
      return JSON.parse(repaired)
    } catch {
      return {}
    }
  }
}

/** Extract the first JSON object from a string, stripping code fences and surrounding text. */
function extractJson(text: string): string {
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) return fenceMatch[1].trim()

  // Find the first { ... } block spanning the full depth
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) return text.slice(start, end + 1)

  return text.trim()
}

function sanitizeSection(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : JSON.stringify(item)))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}
