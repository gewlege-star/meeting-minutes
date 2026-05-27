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
import { formatTimestampedTranscript } from './text-utils'

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
      const response = await this.client.audio.transcriptions.create({
        file: createReadStream(chunkPath),
        model: this.config.transcriptionModel,
        response_format: 'verbose_json',
        prompt: buildTranscriptionPrompt(this.config.outputLanguage)
      })

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
          ...validSegments.map((segment, segmentIndex) => ({
            index: transcriptSegments.length + segmentIndex,
            startSeconds: Number(segment.start ?? 0) + baseOffset,
            endSeconds: Number(segment.end ?? 0) + baseOffset,
            text: String(segment.text ?? '').trim()
          }))
        )
      } else {
        const chunkText = response.text.trim()
        if (chunkText) {
          transcriptSegments.push({
            index: transcriptSegments.length,
            startSeconds: baseOffset,
            endSeconds: baseOffset + AUDIO_CHUNK_SECONDS,
            text: chunkText
          })
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

    const responseFormat: OpenAI.ResponseFormatJSONSchema | OpenAI.ResponseFormatJSONObject =
      this.config.provider === 'openai' || this.config.provider === 'groq'
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
        : { type: 'json_object' }

    const completion = await this.client.chat.completions.create({
      model: this.config.summaryModel,
      response_format: responseFormat,
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
}

function buildTranscriptionPrompt(language: OutputLanguage): string {
  if (language === 'auto') {
    return ''
  }
  return `Please output the transcription in ${OUTPUT_LANGUAGE_LABELS[language]}.`
}

function buildSummarizationSystemPrompt(language: OutputLanguage, showTimestamps: boolean, prompts: SectionPrompts): string {
  const timestampNote = showTimestamps
    ? 'each starting with "- [HH:MM:SS - HH:MM:SS] "'
    : ''

  const lines = [
    'You produce structured meeting summaries.',
    'The transcript below includes timestamps in [HH:MM:SS - HH:MM:SS] format for each segment.',
    'Return valid JSON with exactly these string fields:',
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
  const cleaned = jsonText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
  const parsed = JSON.parse(cleaned) as unknown
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
