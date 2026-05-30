import { readFile } from 'fs/promises'
import { extname } from 'path'

import { GoogleGenAI } from '@google/genai'

import {
  AUDIO_CHUNK_SECONDS,
  OUTPUT_LANGUAGE_LABELS,
  PROVIDER_LABELS,
  type OutputLanguage,
  type SummaryBundle,
  type TranscriptSegment
} from '../shared/contracts'
import type { ProviderConfig, TranscriptPayload } from './database'
import { parseSummaryBundle } from './openai-provider'
import { formatTimestampedTranscript, parseCorrectedTranscript, splitSentences } from './text-utils'

export class GeminiProvider {
  private readonly client: GoogleGenAI

  constructor(private readonly config: ProviderConfig) {
    if (!config.apiKey) {
      throw new Error(`${PROVIDER_LABELS[config.provider]} API key is not configured.`)
    }

    this.client = new GoogleGenAI({ apiKey: config.apiKey })
  }

  async transcribeAudio(chunkPaths: string[]): Promise<TranscriptPayload> {
    const transcriptSegments: TranscriptSegment[] = []

    for (const [index, chunkPath] of chunkPaths.entries()) {
      const baseOffset = index * AUDIO_CHUNK_SECONDS
      const chunkText = await this.transcribeChunk(chunkPath)

      if (chunkText) {
        // Apply sentence splitting for Gemini (no native segment support)
        const sentences = splitSentences(chunkText)
          .split('\n')
          .map((line) => line.trim())
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

    const text = transcriptSegments.map((s) => s.text).join('\n')
    return { text, segments: transcriptSegments }
  }

  async summarizeTranscript(
    transcript: string,
    segments: TranscriptSegment[]
  ): Promise<SummaryBundle> {
    if (!transcript.trim()) {
      throw new Error('Transcript is empty, so there is nothing to summarize.')
    }

    const timestampedTranscript = formatTimestampedTranscript(segments) || transcript
    const languageInstruction = buildLanguageInstruction(this.config.outputLanguage)
    const { sectionPrompts, showTimestamps } = this.config

    const promptText = [
      'Summarize the following timestamped meeting transcript.',
      'The transcript includes timestamps in [HH:MM:SS - HH:MM:SS] format for each segment.',
      'Return ONLY a valid JSON object (no markdown, no code fences) with exactly these string fields:',
      `- plainSummary: ${sectionPrompts.plainSummary}`,
      `- meetingMinutes: ${sectionPrompts.meetingMinutes}`,
      `- actionItems: ${sectionPrompts.actionItems}${showTimestamps ? ', each starting with "- [HH:MM:SS - HH:MM:SS] "' : ''}`,
      `- keyDecisions: ${sectionPrompts.keyDecisions}${showTimestamps ? ', each starting with "- [HH:MM:SS - HH:MM:SS] "' : ''}`,
      `- nextSteps: ${sectionPrompts.nextSteps}${showTimestamps ? ', each starting with "- [HH:MM:SS - HH:MM:SS] "' : ''}`,
      `Every field must contain relevant content. ${languageInstruction}`,
      '',
      '<transcript>',
      timestampedTranscript,
      '</transcript>'
    ].join('\n')

    const response = await this.client.models.generateContent({
      model: this.config.summaryModel,
      contents: [{ role: 'user', parts: [{ text: promptText }] }]
    })

    return parseSummaryBundle(extractGeminiText(response))
  }

  async analyzeWithPrompt(transcript: string, prompt: string): Promise<string> {
    if (!transcript.trim()) {
      throw new Error('Transcript is empty, so there is nothing to analyze.')
    }

    const languageInstruction = buildLanguageInstruction(this.config.outputLanguage)

    const response = await this.client.models.generateContent({
      model: this.config.summaryModel,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `${prompt}\n\n${languageInstruction}\n\n<transcript>\n${transcript}\n</transcript>`
            }
          ]
        }
      ]
    })

    return extractGeminiText(response).trim()
  }

  async correctTranscript(
    transcript: string,
    segments: TranscriptSegment[]
  ): Promise<TranscriptPayload> {
    if (!transcript.trim()) {
      throw new Error('Transcript is empty, so there is nothing to correct.')
    }

    const timestampedTranscript = formatTimestampedTranscript(segments) || transcript
    const languageInstruction = buildLanguageInstruction(this.config.outputLanguage)

    const speakerInstruction = this.config.identifySpeakers
      ? '5. Since speaker identification (identifySpeakers) is enabled, you MUST analyze the conversational context, speaker flow, and back-and-forth Q&A, and prefix each line with a speaker identifier (e.g., "說話者 A: ", "說話者 B: " or "Speaker A: ", "Speaker B: " depending on context/language) of who is speaking. Do this line-by-line. If a line already contains a speaker label, keep or optimize/rename it. The correct line format is: "[HH:MM:SS - HH:MM:SS] Speaker name: <corrected text>"'
      : '5. Do not add or inject speaker prefixes if they are not already present in the original transcript.'

    const promptText = [
      'You are an expert editor specializing in correcting voice transcriptions.',
      'Your task is to fix spelling, grammar, punctuation, and particularly homophones or voice transcription mistakes based on sentence context.',
      '',
      'CRITICAL RULES:',
      '1. You must maintain the exact structure of the transcript, keeping all timestamps "[HH:MM:SS - HH:MM:SS]" exactly intact. Do not change any timestamp.',
      '2. Only correct the text portion.',
      '3. Every output line must preserve the timestamp format: "[HH:MM:SS - HH:MM:SS] <corrected text>"',
      '4. Do not summarize, do not omit lines, and do not add any markdown fences, headers, comments, conversational fluff, or introduction. Return ONLY the line-by-line corrected timestamped transcript.',
      speakerInstruction,
      languageInstruction,
      '',
      '<transcript>',
      timestampedTranscript,
      '</transcript>'
    ].join('\n')

    const response = await this.client.models.generateContent({
      model: this.config.summaryModel,
      contents: [{ role: 'user', parts: [{ text: promptText }] }]
    })

    const content = extractGeminiText(response)
    return parseCorrectedTranscript(content, segments)
  }

  private async transcribeChunk(chunkPath: string): Promise<string> {
    const audioBytes = await readFile(chunkPath)
    const languageInstruction =
      this.config.outputLanguage === 'auto'
        ? 'Keep the original language.'
        : this.config.outputLanguage === 'zh-TW'
          ? 'Output must be exclusively in Taiwanese Traditional Chinese (繁體中文/正體中文), using Taiwan local terms. Never output Simplified Chinese characters.'
          : `Output in ${OUTPUT_LANGUAGE_LABELS[this.config.outputLanguage]}.`
    const speakerInstruction = this.config.identifySpeakers
      ? 'Identify and label different speakers (e.g., Speaker 1:, Speaker 2:).'
      : ''

    const response = await this.client.models.generateContent({
      model: this.config.transcriptionModel,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: [
                'Transcribe this audio verbatim.',
                'Return only the transcript text.',
                languageInstruction,
                speakerInstruction,
                'Do not summarize.'
              ]
                .filter(Boolean)
                .join(' ')
            },
            {
              inlineData: {
                mimeType: mimeTypeForAudioFile(chunkPath),
                data: audioBytes.toString('base64')
              }
            }
          ]
        }
      ]
    })

    return extractGeminiText(response).trim()
  }
}

function buildLanguageInstruction(language: OutputLanguage): string {
  if (language === 'auto') {
    return 'Use the same language as the transcript.'
  }
  if (language === 'zh-TW') {
    return 'Always respond exclusively in Taiwanese Traditional Chinese (繁體中文/正體中文), using Taiwan local terms and phrases. Never output Simplified Chinese characters.'
  }
  return `Always respond in ${OUTPUT_LANGUAGE_LABELS[language]}.`
}

function extractGeminiText(response: { text?: string }): string {
  if (typeof response.text === 'string') {
    return response.text
  }

  throw new Error('Gemini returned an empty response.')
}

function mimeTypeForAudioFile(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.m4a':
      return 'audio/mp4'
    case '.ogg':
      return 'audio/ogg'
    case '.webm':
      return 'audio/webm'
    default:
      return 'audio/mpeg'
  }
}
