// Talking to the hub: REST with the token, and one WebSocket for live events.

const TOKEN_KEY = 'switchboard.token'
const DEVICE_KEY = 'switchboard.device'

function storageGet(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function storageSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // private mode: keep it in memory for this visit
  }
}

let memoryToken = null

/** The token arrives once in the URL fragment (from the QR code) and is kept in this browser. */
export function takeTokenFromUrl() {
  const m = /[#&]token=([^&]+)/.exec(location.hash)
  if (m) {
    const token = decodeURIComponent(m[1])
    storageSet(TOKEN_KEY, token)
    memoryToken = token
    history.replaceState(null, '', location.pathname + location.search + '#/')
  }
}

export function getToken() {
  return memoryToken ?? storageGet(TOKEN_KEY)
}

export function setToken(token) {
  memoryToken = token
  storageSet(TOKEN_KEY, token)
}

export function deviceId() {
  let id = storageGet(DEVICE_KEY)
  if (!id) {
    id = 'web-' + (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2))
    storageSet(DEVICE_KEY, id)
  }
  return id
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

export async function api(method, path, body) {
  const init = { method, headers: { authorization: `Bearer ${getToken() ?? ''}` } }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(path, init)
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) throw new ApiError((data && data.error) || `${res.status} ${res.statusText}`, res.status)
  return data
}

/**
 * One socket to the hub that reconnects by itself. `onEvent` gets every hub
 * event; `onStatus` gets 'connecting' | 'open' | 'closed' | 'unauthorized'.
 */
export function connectSocket({ onEvent, onStatus, device, name }) {
  let ws = null
  let stopped = false
  let backoff = 800
  let pingTimer = null

  const open = () => {
    if (stopped) return
    onStatus('connecting')
    const url = new URL('/ws', location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('token', getToken() ?? '')
    url.searchParams.set('platform', 'web')
    url.searchParams.set('device', device)
    url.searchParams.set('name', name)
    ws = new WebSocket(url)
    ws.onopen = () => {
      backoff = 800
      onStatus('open')
      pingTimer = setInterval(() => send({ type: 'ping' }), 25000)
    }
    ws.onmessage = ev => {
      try {
        onEvent(JSON.parse(ev.data))
      } catch (err) {
        console.error(err)
      }
    }
    ws.onclose = ev => {
      clearInterval(pingTimer)
      if (stopped) return
      onStatus(ev.code === 1008 || ev.code === 4401 ? 'unauthorized' : 'closed')
      setTimeout(open, backoff)
      backoff = Math.min(backoff * 2, 10000)
    }
    ws.onerror = () => {}
  }

  const send = event => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(event))
  }

  open()
  return {
    send,
    close() {
      stopped = true
      ws?.close()
    },
    reconnect() {
      ws?.close()
    },
  }
}
