import * as SecureStore from 'expo-secure-store'
import * as Crypto from 'expo-crypto'
import Constants from 'expo-constants'

export interface Pairing {
  url: string
  token: string
}

const PAIR_KEY = 'switchboard.pairing'
const DEVICE_KEY = 'switchboard.device'
const SETTINGS_KEY = 'switchboard.settings'

export interface AppSettings {
  autoSpeak: boolean
  announceSender: boolean
  readBack: boolean
  rate: number
  voice: string | null
  transcribe: 'auto' | 'device' | 'hub'
  pttMode: 'hold' | 'toggle'
  mediaButton: boolean
  notifyInWalk: boolean
  allowLocation: boolean
  allowClipboard: boolean
  allowCalendar: boolean
  autoUpdate: boolean
}

export const defaultSettings: AppSettings = {
  autoSpeak: false,
  announceSender: true,
  readBack: false,
  rate: 1.0,
  voice: null,
  transcribe: 'auto',
  pttMode: 'toggle',
  mediaButton: true,
  notifyInWalk: true,
  allowLocation: false,
  allowClipboard: false,
  allowCalendar: false,
  autoUpdate: true,
}

export async function loadPairing(): Promise<Pairing | null> {
  const raw = await SecureStore.getItemAsync(PAIR_KEY)
  if (raw) {
    try {
      return JSON.parse(raw) as Pairing
    } catch {
      // fall through
    }
  }
  return null
}

export async function savePairing(p: Pairing | null): Promise<void> {
  if (p) await SecureStore.setItemAsync(PAIR_KEY, JSON.stringify({ url: p.url.replace(/\/+$/, ''), token: p.token }))
  else await SecureStore.deleteItemAsync(PAIR_KEY)
}

/** Read a pairing out of a QR code or a pasted link: switchboard://pair?url=...&token=..., or https://hub/#token=... */
export function parsePairing(text: string): Pairing | null {
  const s = text.trim()
  try {
    if (s.startsWith('switchboard://')) {
      const q = new URLSearchParams(s.split('?')[1] ?? '')
      const url = q.get('url')
      const token = q.get('token')
      return url && token ? { url, token } : null
    }
    const m = /^(https?:\/\/[^#\s]+?)\/?#token=([^&\s]+)/.exec(s)
    if (m) return { url: m[1], token: decodeURIComponent(m[2]) }
  } catch {
    return null
  }
  return null
}

export async function deviceId(): Promise<string> {
  let id = await SecureStore.getItemAsync(DEVICE_KEY)
  if (!id) {
    id = `app-${Crypto.randomUUID()}`
    await SecureStore.setItemAsync(DEVICE_KEY, id)
  }
  return id
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await SecureStore.getItemAsync(SETTINGS_KEY)
    return { ...defaultSettings, ...(raw ? JSON.parse(raw) : {}) }
  } catch {
    return { ...defaultSettings }
  }
}

export async function saveSettings(s: AppSettings): Promise<void> {
  await SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(s))
}

/** The hub URL baked into this build (also where over-the-air updates come from). */
export const builtInHubUrl: string | null = (Constants.expoConfig?.extra as { hubUrl?: string } | undefined)?.hubUrl ?? null
