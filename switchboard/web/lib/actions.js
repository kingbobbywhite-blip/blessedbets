// Phone actions a browser can do when a session asks (the native app can do more).
import { speak, speakable, stopSpeaking } from './voice.js'

const PERMS_KEY = 'switchboard.allow'

export function allowed() {
  try {
    return { location: false, clipboard: false, ...JSON.parse(localStorage.getItem(PERMS_KEY) || '{}') }
  } catch {
    return { location: false, clipboard: false }
  }
}
export function setAllowed(patch) {
  try {
    localStorage.setItem(PERMS_KEY, JSON.stringify({ ...allowed(), ...patch }))
  } catch {
    // ignore
  }
}

export function webCapabilities() {
  const caps = ['speak', 'stop_speaking', 'notify', 'open_url', 'get_device_info']
  if (navigator.vibrate) caps.push('vibrate')
  if (navigator.geolocation) caps.push('get_location')
  if (navigator.getBattery) caps.push('get_battery')
  if (navigator.clipboard) caps.push('clipboard_get', 'clipboard_set')
  return caps
}

export async function runWebAction(action, params, { settings }) {
  switch (action) {
    case 'speak':
      await speak(speakable(params.text || ''), settings)
      return 'Spoken.'
    case 'stop_speaking':
      stopSpeaking()
      return 'Stopped.'
    case 'notify': {
      const title = params.title || 'Claude'
      if ('Notification' in window) {
        if (Notification.permission === 'default') await Notification.requestPermission()
        if (Notification.permission === 'granted') {
          new Notification(title, { body: params.body || '' })
          return 'Notification shown.'
        }
      }
      return 'Notifications are blocked in this browser.'
    }
    case 'vibrate':
      navigator.vibrate?.(params.pattern === 'long' ? 600 : params.pattern === 'success' ? [60, 60, 60] : 120)
      return 'Vibrated.'
    case 'open_url': {
      const url = String(params.url || '')
      if (!/^(https?:|tel:|sms:|mailto:|maps:|geo:)/i.test(url)) throw new Error('Only http(s), tel:, sms:, mailto: and map links can be opened from a browser')
      window.open(url, '_blank', 'noopener')
      return 'Opened.'
    }
    case 'get_location': {
      if (!allowed().location) throw new Error('Location sharing is off. Turn it on in Switchboard settings on that device.')
      const pos = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000 }),
      )
      return { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy_m: Math.round(pos.coords.accuracy) }
    }
    case 'get_battery': {
      const b = await navigator.getBattery()
      return { level: Math.round(b.level * 100) + '%', charging: b.charging }
    }
    case 'get_device_info':
      return { userAgent: navigator.userAgent, language: navigator.language, screen: `${screen.width}x${screen.height}`, online: navigator.onLine }
    case 'clipboard_get':
      if (!allowed().clipboard) throw new Error('Clipboard access is off. Turn it on in Switchboard settings on that device.')
      return await navigator.clipboard.readText()
    case 'clipboard_set':
      await navigator.clipboard.writeText(String(params.text ?? ''))
      return 'Copied.'
  }
  throw new Error(`A browser cannot do "${action}". The Switchboard phone app can.`)
}
