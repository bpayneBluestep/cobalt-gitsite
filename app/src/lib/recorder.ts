/*
 * Screen recording with narration, as two simultaneous MediaRecorders.
 *
 * Ported from beh's intake, where this shape was arrived at the hard way. It looks
 * redundant, one recorder already has the mic track, but it is not:
 *
 *   Recorder 1  screen video + mic  →  the KEPT recording, stored in BlueStep
 *   Recorder 2  a SECOND getUserMedia capture, mic only  →  audio → transcript
 *
 * The second capture has to be its own `getUserMedia` call. Sharing or cloning the
 * first recorder's mic track produced a recorder that ran happily and emitted zero
 * bytes, which is the worst possible failure here: a recording that looks fine and
 * silently carries no narration.
 *
 * Two recorders rather than extracting audio from the video afterwards because there
 * is no way to demux webm in a browser without shipping a decoder, and the transcript
 * is wanted while the user is still in the conversation.
 */

/*
 * Capture settings, and why they are what they are.
 *
 * These were ported from beh at 1.5 Mbps and full resolution, against a 10 MB upload
 * ceiling, which the recorder crossed at 53 SECONDS. A one-minute walkthrough could
 * not be submitted, and nothing said so until the end of the interview. The two numbers
 * had simply never been checked against each other.
 *
 * The fix is mostly not the ceiling, it is the capture. A screen is overwhelmingly
 * static pixels: dropping to 1280-wide at 10 fps costs almost nothing for showing a
 * workflow, text stays sharp, fast scrolling softens slightly, and cuts the bitrate
 * needed by roughly two thirds. At these settings 64 MB holds about 18 minutes.
 */
export const REC_MAX_MS = 20 * 60 * 1000    // 20 minutes, and the byte budget usually bites first
export const REC_VIDEO_BITS = 500_000       // ~500 kbps, tuned for 1280w @ 10fps screen content
export const REC_AUDIO_BITS = 64_000        // speech, not music
export const REC_MAX_WIDTH = 1280
export const REC_FPS = 10

/** Fallback ceiling, used only until `wesleyStatus` reports the server's real one. */
export const REC_DEFAULT_BUDGET = 64 * 1024 * 1024

/** How often the recorders hand us a chunk. Also the resolution of the byte counter. */
const CHUNK_MS = 2000

export interface RecResult {
  videoBlob: Blob
  videoMime: string
  /** Null when there was no microphone, or the mic recorder produced nothing. */
  audioBlob: Blob | null
  /** Why there is no audio, for the log, never shown raw to the user. */
  audioNote: string
  /** True when recording was stopped because it reached the size budget, not by the user. */
  stoppedForSize: boolean
}

export interface Recording {
  /** Stop early. The promise passed to `start` resolves once both recorders flush. */
  stop: () => void
  startedAt: number
}

/** What the ticking callback reports: how long, and how much of the budget is gone. */
export interface RecProgress {
  elapsedMs: number
  bytes: number
  budget: number
}

export function recordingSupported(): boolean {
  // Probed rather than assumed from the types: `getDisplayMedia` is genuinely absent on
  // iOS Safari and on any page served without HTTPS, and TS types it as always present.
  const md = navigator.mediaDevices as unknown as Record<string, unknown> | undefined
  return !!(md &&
    typeof md.getDisplayMedia === 'function' &&
    typeof md.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined')
}

function pickMime(candidates: string[], fallback: string): string {
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(c)) return c
  }
  return fallback
}

// MP4 (H.264 + AAC) first where the browser can record it, so a downloaded recording
// opens in any desktop player; WebM is the fallback for browsers that can't.
const videoMime = () => pickMime(
  ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4',
   'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'], 'video/webm')

/** The file extension that matches a recorder's mime. */
export const recordingExt = (mime: string): string =>
  (mime || '').toLowerCase().startsWith('video/mp4') ? 'mp4' : 'webm'

const audioMime = () => pickMime(
  ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'], '')

/**
 * Ask for a screen, start recording, and resolve the handle once it is running.
 *
 * `onDone` fires when BOTH recorders have flushed, not when stop() is called. Track
 * teardown is deliberately deferred until then: stopping the tracks first truncates
 * whatever the recorders had not yet emitted.
 *
 * Rejects if the user dismisses the screen-picker, which is a normal thing to do and
 * should read as "never mind", not as an error.
 */
export async function startRecording(
  onDone: (result: RecResult) => void,
  onTick: (progress: RecProgress) => void,
  budget: number = REC_DEFAULT_BUDGET,
): Promise<Recording> {
  // Constraints, not just bitrate. Asking the browser for fewer, smaller frames is what
  // makes a low bitrate look fine: throttling bits alone just produces a mushy 1080p.
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { max: REC_MAX_WIDTH },
      frameRate: { ideal: REC_FPS, max: REC_FPS + 5 },
    },
  })

  // A missing mic is not fatal: the video is still worth keeping, and the user is
  // told afterwards that no narration was picked up.
  let mic: MediaStream
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    mic = new MediaStream()
  }

  const vMime = videoMime()
  const micTracks = mic.getAudioTracks()

  const combined = new MediaStream()
  display.getVideoTracks().forEach(t => combined.addTrack(t))
  micTracks.forEach(t => combined.addTrack(t))
  const videoRec = new MediaRecorder(combined, {
    mimeType: vMime,
    videoBitsPerSecond: REC_VIDEO_BITS,
    audioBitsPerSecond: REC_AUDIO_BITS,
  })

  // The separate capture. See the header: cloning the track above does not work.
  let audioStream: MediaStream | null = null
  if (micTracks.length) {
    try { audioStream = await navigator.mediaDevices.getUserMedia({ audio: true }) } catch { audioStream = null }
  }
  const aMime = audioMime()
  const audioRec = (audioStream && audioStream.getAudioTracks().length)
    ? new MediaRecorder(audioStream, aMime ? { mimeType: aMime } : undefined)
    : null

  const videoChunks: Blob[] = []
  const audioChunks: Blob[] = []
  let videoBytes = 0
  let hitBudget = false

  // The video recorder runs with a timeslice so the bytes can be counted AS THEY ARRIVE.
  // Without one it emits a single blob at the very end, and the only moment you could
  // discover the file is too big is the moment it is too late to do anything about it.
  videoRec.ondataavailable = e => {
    if (!e.data?.size) return
    videoChunks.push(e.data)
    videoBytes += e.data.size
    if (videoBytes >= budget && !hitBudget) {
      hitBudget = true
      stop()   // hard stop: what has been recorded so far is kept and is under the limit
    }
  }
  if (audioRec) audioRec.ondataavailable = e => { if (e.data?.size) audioChunks.push(e.data) }

  const startedAt = Date.now()
  let finished = false
  let stopping = false

  const tick = window.setInterval(
    () => onTick({ elapsedMs: Date.now() - startedAt, bytes: videoBytes, budget }),
    250,
  )

  const finish = () => {
    if (finished) return
    if (videoRec.state !== 'inactive') return
    if (audioRec && audioRec.state !== 'inactive') return
    finished = true
    window.clearInterval(tick)
    window.clearTimeout(cap)

    // Only now. See the header.
    display.getTracks().forEach(t => t.stop())
    mic.getTracks().forEach(t => t.stop())
    audioStream?.getTracks().forEach(t => t.stop())

    const audioBlob = audioChunks.length
      ? new Blob(audioChunks, { type: audioRec?.mimeType || 'audio/webm' })
      : null

    onDone({
      videoBlob: new Blob(videoChunks, { type: vMime }),
      videoMime: vMime,
      audioBlob,
      audioNote: audioBlob
        ? ''
        : (audioRec ? 'the microphone recorder produced no audio' : 'no microphone was available'),
      stoppedForSize: hitBudget,
    })
  }

  videoRec.onstop = finish
  if (audioRec) audioRec.onstop = finish

  const stop = () => {
    if (stopping) return
    stopping = true
    try { if (videoRec.state !== 'inactive') videoRec.stop() } catch { /* already stopped */ }
    try { if (audioRec && audioRec.state !== 'inactive') audioRec.stop() } catch { /* already stopped */ }
  }

  // "Stop sharing" in the browser's own bar ends the track, not our recorder.
  display.getVideoTracks()[0]?.addEventListener('ended', stop)

  const cap = window.setTimeout(stop, REC_MAX_MS)

  // Both recorders take a timeslice. On the audio side it stops a short recording from
  // ending before anything is emitted at all; on the video side it is what makes the
  // running byte count, and therefore the hard stop above: possible.
  videoRec.start(CHUNK_MS)
  if (audioRec) audioRec.start(1000)

  return { stop, startedAt }
}

/**
 * Base64 of a blob's bytes, what the endpoint expects.
 *
 * Encoded straight from the bytes rather than by trimming a `readAsDataURL` string.
 * Trimming is what corrupted every screen recording: the recorder's mime carries its
 * own comma (`video/webm;codecs=vp9,opus`), the old code cut at the first comma, and
 * `opus;base64,` went up as the start of the file. No data URL, nothing to mis-cut.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  let bytes: Uint8Array
  try { bytes = new Uint8Array(await blob.arrayBuffer()) }
  catch { throw new Error('That file could not be read.') }
  // Chunked: String.fromCharCode(...all) overflows the argument limit on a big file.
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)))
  }
  return btoa(bin)
}

/**
 * Whether a recording's first bytes are the container its mime claims: WebM starts with
 * the EBML magic, MP4 has `ftyp` at offset 4. Checked before upload, so a broken
 * recording is caught while the person can still record it again, not by the engineer
 * who later finds it won't play. The Maestro checks the same thing as the backstop.
 */
export async function recordingLooksValid(blob: Blob, mime: string): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  const m = (mime || blob.type || '').toLowerCase()
  if (m.startsWith('video/webm') || m.startsWith('audio/webm')) {
    return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3
  }
  if (m.startsWith('video/mp4')) {
    return String.fromCharCode(head[4], head[5], head[6], head[7]) === 'ftyp'
  }
  return head.length > 0
}

/** Round-trip check on an encoding: the first bytes of the base64 decode back to the blob's. */
export async function base64MatchesBlob(dataBase64: string, blob: Blob): Promise<boolean> {
  const want = new Uint8Array(await blob.slice(0, 48).arrayBuffer())
  const got = atob(dataBase64.slice(0, 64))
  if (got.length < want.length) return false
  for (let i = 0; i < want.length; i++) if (got.charCodeAt(i) !== want[i]) return false
  return true
}

/** `9:05`, elapsed and remaining, on the recording chip. */
export function formatClock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s < 10 ? '0' : ''}${s}`
}
