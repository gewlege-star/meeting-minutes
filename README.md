# Meeting Minutes (v0.3.0-beta)

Desktop app for:

- microphone recording
- audio / video import
- transcript generation
- structured meeting summaries

## Stack

- Electron + React + TypeScript
- SQLite for local persistence
- FFmpeg for audio normalization and chunking
- OpenAI, Groq, or Gemini for transcription and summary generation

## Current MVP flow

1. Choose OpenAI, Groq, or Gemini, then save that provider's API key and model settings in the app.
2. Record from the microphone or import an audio/video file.
3. Generate transcript + summary.
4. Export the result as Markdown.

The API key is stored with Electron `safeStorage`, not in plaintext.

## Development

```bash
npm install
npm run dev
```

## Packaging

```bash
# macOS
npm run build:mac

# Windows
npm run build:win
```

## Notes

- Imported media and generated outputs live in the Electron user data directory.
- Audio is normalized to a speech-friendly MP3 before transcription.
- The transcription pipeline segments long recordings into 2-minute chunks before sending them to the provider to avoid hallucinations and ensure responsive results.
- Native Electron modules are rebuilt automatically before `npm run dev`.
