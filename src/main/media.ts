import { mkdir, readdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

import ffmpeg from 'fluent-ffmpeg'
import ffmpegPath from 'ffmpeg-static'

import { AUDIO_CHUNK_SECONDS, type ProcessingJob } from '../shared/contracts'
import type { AppDirectories } from './storage'

let ffmpegConfigured = false

export async function ensureNormalizedAudio(
  job: ProcessingJob,
  directories: AppDirectories
): Promise<string> {
  const outputPath = join(directories.normalizedDir, `${job.id}.mp3`)
  if (existsSync(outputPath)) {
    return outputPath
  }

  configureFfmpeg()

  await runFfmpeg((command) => {
    let cmd = command.input(job.sourcePath)

    if (typeof job.trimStart === 'number' && job.trimStart > 0) {
      cmd = cmd.seekInput(job.trimStart)
    }

    if (typeof job.trimEnd === 'number' && job.trimEnd > 0) {
      const start = job.trimStart || 0
      const duration = job.trimEnd - start
      if (duration > 0) {
        cmd = cmd.duration(duration)
      }
    }

    return cmd
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('32k')
      .format('mp3')
      .output(outputPath)
  })

  return outputPath
}

export async function createAudioChunks(
  jobId: string,
  normalizedPath: string,
  directories: AppDirectories
): Promise<string[]> {
  const chunkDir = join(directories.chunksDir, jobId)
  await rm(chunkDir, { recursive: true, force: true })
  await mkdir(chunkDir, { recursive: true })
  const chunkPattern = join(chunkDir, 'chunk-%03d.mp3')

  configureFfmpeg()

  await runFfmpeg((command) =>
    command
      .input(normalizedPath)
      .outputOptions([
        '-f',
        'segment',
        '-segment_time',
        String(AUDIO_CHUNK_SECONDS),
        '-reset_timestamps',
        '1',
        '-c',
        'copy'
      ])
      .output(chunkPattern)
  )

  const files = (await readdir(chunkDir))
    .filter((fileName) => fileName.endsWith('.mp3'))
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => join(chunkDir, fileName))

  if (files.length === 0) {
    throw new Error('Failed to create audio chunks for transcription.')
  }

  return files
}

function configureFfmpeg(): void {
  if (ffmpegConfigured) {
    return
  }

  if (!ffmpegPath) {
    throw new Error('ffmpeg-static did not provide a binary path.')
  }

  ffmpeg.setFfmpegPath(ffmpegPath.replace('app.asar', 'app.asar.unpacked'))
  ffmpegConfigured = true
}

function runFfmpeg(build: (command: ffmpeg.FfmpegCommand) => ffmpeg.FfmpegCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = build(ffmpeg())
    command.once('end', () => resolve())
    command.once('error', (error) => reject(error))
    command.run()
  })
}
