// Speaking replies aloud, listening to you, and the little sounds in between.

const SETTINGS_KEY = 'switchboard.voice'

export const defaultVoiceSettings = {
  autoSpeak: false, // read every reply aloud (walk mode always does)
  voiceURI: '',
  rate: 1.05,
  announceSender: true,
  transcribe: 'auto', // 'auto' | 'device' | 'hub'
  pttMode: 'hold', // 'hold' | 'toggle'
  readBack: false, // say what you said back before sending
}

export function loadVoiceSettings() {
  try {
    return { ...defaultVoiceSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }
  } catch {
    return { ...defaultVoiceSettings }
  }
}

export function saveVoiceSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  } catch {
    // ignore
  }
}

/** Turn a markdown-ish reply into something pleasant to hear. */
export function speakable(text) {
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

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null

export function voices() {
  return synth ? synth.getVoices() : []
}

let queue = Promise.resolve()

/** Speak text after anything already queued. Resolves when it has been said (or skipped). */
export function speak(text, settings) {
  if (!synth || !text) return Promise.resolve()
  queue = queue.then(
    () =>
      new Promise(resolve => {
        const u = new SpeechSynthesisUtterance(text)
        const v = voices().find(x => x.voiceURI === settings.voiceURI)
        if (v) u.voice = v
        u.rate = settings.rate || 1
        u.onend = () => resolve()
        u.onerror = () => resolve()
        synth.speak(u)
        // Some browsers never fire onend; do not let the queue stall forever.
        setTimeout(resolve, Math.min(120000, 4000 + text.length * 90))
      }),
  )
  return queue
}

export function stopSpeaking() {
  synth?.cancel()
  queue = Promise.resolve()
}

export function isSpeaking() {
  return Boolean(synth?.speaking)
}

/** iOS only lets speech start from a tap; call this from one. */
export function unlockSpeech() {
  if (!synth) return
  const u = new SpeechSynthesisUtterance(' ')
  u.volume = 0
  synth.speak(u)
  chime('unlock')
}

let audioCtx = null
export function chime(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const notes = {
      start: [660, 880],
      stop: [880, 660],
      sent: [523, 784],
      error: [220, 180],
      message: [740],
      unlock: [1],
    }[kind] || [440]
    let t = audioCtx.currentTime
    for (const f of notes) {
      const o = audioCtx.createOscillator()
      const g = audioCtx.createGain()
      o.type = 'sine'
      o.frequency.value = f
      g.gain.setValueAtTime(kind === 'unlock' ? 0.0001 : 0.18, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
      o.connect(g).connect(audioCtx.destination)
      o.start(t)
      o.stop(t + 0.13)
      t += 0.13
    }
  } catch {
    // no audio
  }
}

export function deviceSpeechRecognition() {
  return typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition || null : null
}

/**
 * Listen once. With the hub doing transcription, records audio and returns the
 * Blob; on the device, returns the recognised text. `stop()` ends it;
 * `cancel()` throws the take away.
 */
export function startListening({ mode, onInterim }) {
  const Recognition = deviceSpeechRecognition()
  const useDevice = mode === 'device' || (mode === 'auto-device' && Recognition)
  if (useDevice && Recognition) {
    const rec = new Recognition()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = navigator.language || 'en-US'
    let finalText = ''
    let cancelled = false
    const done = new Promise((resolve, reject) => {
      rec.onresult = ev => {
        let interim = ''
        finalText = ''
        for (const r of ev.results) {
          if (r.isFinal) finalText += r[0].transcript
          else interim += r[0].transcript
        }
        onInterim?.((finalText + ' ' + interim).trim())
      }
      rec.onerror = ev => (ev.error === 'no-speech' || ev.error === 'aborted' ? resolve({ text: '' }) : reject(new Error(ev.error)))
      rec.onend = () => resolve(cancelled ? { cancelled: true } : { text: finalText.trim() })
    })
    rec.start()
    return {
      kind: 'device',
      done,
      stop: () => rec.stop(),
      cancel: () => {
        cancelled = true
        rec.abort()
      },
    }
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('This browser cannot record audio here (it needs https).')
  }
  let recorder = null
  let stream = null
  let cancelled = false
  const chunks = []
  const done = (async () => {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported?.(t)) || ''
    recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    recorder.ondataavailable = e => e.data.size && chunks.push(e.data)
    const stopped = new Promise(resolve => (recorder.onstop = resolve))
    recorder.start()
    await stopped
    stream.getTracks().forEach(t => t.stop())
    if (cancelled) return { cancelled: true }
    return { blob: new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }) }
  })()
  return {
    kind: 'hub',
    done,
    stop: () => recorder?.state === 'recording' && recorder.stop(),
    cancel: () => {
      cancelled = true
      if (recorder?.state === 'recording') recorder.stop()
      else stream?.getTracks().forEach(t => t.stop())
    },
  }
}

let wakeLock = null
export async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen')
    else if (!on && wakeLock) {
      await wakeLock.release()
      wakeLock = null
    }
  } catch {
    // not allowed right now
  }
}
