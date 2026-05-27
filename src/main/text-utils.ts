import type { GlossaryEntry, TranscriptSegment } from '../shared/contracts'

/**
 * Split continuous text into individual sentences.
 * Handles CJK punctuation (。！？) and Western punctuation (.!?).
 */
export function splitSentences(text: string): string {
  return text
    .replace(/([。！？])\s*/g, '$1\n')
    .replace(/([.!?])\s+/g, '$1\n')
    .replace(/\n{2,}/g, '\n\n')
    .trim()
}

/**
 * Format transcript segments with timestamp prefixes.
 * Output: [HH:MM:SS - HH:MM:SS] segment text
 */
export function formatTimestampedTranscript(segments: TranscriptSegment[]): string {
  if (segments.length === 0) {
    return ''
  }

  return segments
    .map(
      (segment) =>
        `[${formatSeconds(segment.startSeconds)} - ${formatSeconds(segment.endSeconds)}] ${segment.text}`
    )
    .join('\n')
}

/**
 * Format a number of seconds as HH:MM:SS.
 */
export function formatSeconds(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * Apply glossary replacements to text.
 * Entries are sorted by source term length (longest first) to avoid partial matches.
 */
export function applyGlossary(text: string, entries: GlossaryEntry[]): string {
  if (entries.length === 0 || !text) {
    return text
  }

  const sorted = [...entries].sort(
    (a, b) => b.sourceTerm.length - a.sourceTerm.length
  )

  let result = text
  for (const entry of sorted) {
    if (!entry.sourceTerm) continue
    const escaped = entry.sourceTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(escaped, 'g'), entry.targetTerm)
  }

  return result
}
