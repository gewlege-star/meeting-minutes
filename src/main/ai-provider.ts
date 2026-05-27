import type { SummaryBundle, TranscriptSegment } from '../shared/contracts'
import type { ProviderConfig, TranscriptPayload } from './database'
import { GeminiProvider } from './gemini-provider'
import { OpenAICompatibleProvider } from './openai-provider'

export interface AIProvider {
  transcribeAudio: (chunkPaths: string[]) => Promise<TranscriptPayload>
  summarizeTranscript: (transcript: string, segments: TranscriptSegment[]) => Promise<SummaryBundle>
  analyzeWithPrompt: (transcript: string, prompt: string) => Promise<string>
}

export function createAIProvider(config: ProviderConfig): AIProvider {
  if (config.provider === 'gemini') {
    return new GeminiProvider(config)
  }

  return new OpenAICompatibleProvider(config)
}
