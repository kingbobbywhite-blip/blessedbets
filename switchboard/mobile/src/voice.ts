import * as Speech from 'expo-speech'
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio'

/** Turn a markdown-ish reply into something pleasant to hear. */
export function speakable(text: string): string {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

let queue: Promise<void> = Promise.resolve()
let speaking = 0

export function isSpeaking(): boolean {
  return speaking > 0
}

/** Speak after whatever is already queued; resolves when done or skipped. */
export function speak(text: string, opts: { rate: number; voice: string | null }): Promise<void> {
  const clean = speakable(text)
  if (!clean) return Promise.resolve()
  queue = queue.then(
    () =>
      new Promise<void>(resolve => {
        speaking++
        const done = () => {
          speaking = Math.max(0, speaking - 1)
          resolve()
        }
        Speech.speak(clean, {
          rate: opts.rate,
          voice: opts.voice ?? undefined,
          onDone: done,
          onStopped: done,
          onError: done,
        })
      }),
  )
  return queue
}

export function stopSpeaking(): void {
  Speech.stop()
  speaking = 0
  queue = Promise.resolve()
}

export async function voices(): Promise<Speech.Voice[]> {
  try {
    return await Speech.getAvailableVoicesAsync()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Short sounds

const SOUNDS = {
  start: require('../assets/sounds/start.wav'),
  stop: require('../assets/sounds/stop.wav'),
  sent: require('../assets/sounds/sent.wav'),
  error: require('../assets/sounds/error.wav'),
  message: require('../assets/sounds/message.wav'),
}
export type Chime = keyof typeof SOUNDS
const players: Partial<Record<Chime, AudioPlayer>> = {}

export function chime(kind: Chime): void {
  try {
    let p = players[kind]
    if (!p) {
      p = createAudioPlayer(SOUNDS[kind])
      players[kind] = p
    }
    p.seekTo(0)
    p.play()
  } catch {
    // no sound available
  }
}

// ---------------------------------------------------------------------------
// Walk mode: keep the app alive in your pocket

let keepAlive: AudioPlayer | null = null
let ourPause = 0
let statusSub: { remove(): void } | null = null

/**
 * Configure audio for talking and listening in the background, and loop a
 * silent track with lock-screen controls. That keeps the app (and its
 * connection to the hub) running with the screen off, and a headset or Flic
 * media-button press shows up as the track being paused: `onMediaButton` fires.
 */
export async function startWalkAudio(opts: { title: string; subtitle: string; onMediaButton?: () => void }): Promise<void> {
  await setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    allowsRecording: true,
    allowsBackgroundRecording: true,
    interruptionMode: 'mixWithOthers',
  })
  if (!keepAlive) {
    keepAlive = createAudioPlayer(require('../assets/sounds/silence.wav'), { keepAudioSessionActive: true })
    keepAlive.loop = true
    keepAlive.volume = 0
  }
  statusSub?.remove()
  statusSub = keepAlive.addListener('playbackStatusUpdate', status => {
    if (!keepAlive || !status.isLoaded) return
    if (!status.playing && Date.now() - ourPause > 1500 && !status.didJustFinish) {
      // Paused by someone else: a headset button, the lock screen, a Flic in media mode.
      opts.onMediaButton?.()
      setTimeout(() => keepAlive?.play(), 250)
    }
  })
  keepAlive.play()
  try {
    keepAlive.setActiveForLockScreen(true, { title: opts.title, artist: opts.subtitle })
  } catch {
    // older OS: no lock screen controls
  }
}

export function updateWalkAudio(title: string, subtitle: string): void {
  try {
    keepAlive?.updateLockScreenMetadata({ title, artist: subtitle })
  } catch {
    // ignore
  }
}

export async function stopWalkAudio(): Promise<void> {
  statusSub?.remove()
  statusSub = null
  if (keepAlive) {
    ourPause = Date.now()
    try {
      keepAlive.setActiveForLockScreen(false)
    } catch {
      // ignore
    }
    keepAlive.pause()
  }
  await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false, allowsRecording: true, interruptionMode: 'mixWithOthers' })
}
