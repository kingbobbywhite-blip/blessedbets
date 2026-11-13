import type { Pairing } from './config'

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export function makeApi(pairing: Pairing) {
  const base = pairing.url.replace(/\/+$/, '')
  async function call<T = any>(method: string, path: string, body?: unknown, timeoutMs = 30000): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${pairing.token}` }
    let payload: any
    if (body instanceof FormData) payload = body
    else if (body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${base}${path}`, { method, headers, body: payload, signal: ctrl.signal })
      const text = await res.text()
      let data: any = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = text
      }
      if (!res.ok) throw new ApiError((data && data.error) || `${res.status}`, res.status)
      return data as T
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new ApiError('The hub did not answer in time', 0)
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
  return { base, token: pairing.token, call }
}

export type Api = ReturnType<typeof makeApi>

export interface Socket {
  send(event: unknown): void
  close(): void
  reconnect(): void
}

/** One WebSocket to the hub that reconnects by itself (and right away when the app comes back). */
export function connectSocket(opts: {
  pairing: Pairing
  device: string
  platform: string
  name: string
  onEvent: (ev: any) => void
  onStatus: (s: 'connecting' | 'open' | 'closed') => void
}): Socket {
  let ws: WebSocket | null = null
  let stopped = false
  let backoff = 800
  let ping: ReturnType<typeof setInterval> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const open = () => {
    if (stopped) return
    if (retryTimer) clearTimeout(retryTimer)
    opts.onStatus('connecting')
    const url =
      opts.pairing.url.replace(/^http/, 'ws').replace(/\/+$/, '') +
      `/ws?${new URLSearchParams({ token: opts.pairing.token, platform: opts.platform, device: opts.device, name: opts.name })}`
    const socket = new WebSocket(url)
    ws = socket
    let retried = false
    const retry = () => {
      if (ping) clearInterval(ping)
      if (stopped || retried || ws !== socket) return
      retried = true
      opts.onStatus('closed')
      retryTimer = setTimeout(open, backoff)
      backoff = Math.min(backoff * 2, 8000)
    }
    socket.onopen = () => {
      backoff = 800
      opts.onStatus('open')
      ping = setInterval(() => send({ type: 'ping' }), 25000)
    }
    socket.onmessage = ev => {
      try {
        opts.onEvent(JSON.parse(String(ev.data)))
      } catch {
        // ignore
      }
    }
    socket.onclose = retry
    socket.onerror = retry
  }
  const send = (event: unknown) => {
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
      if (ws && ws.readyState === 1) return
      backoff = 800
      const old = ws
      ws = null
      old?.close()
      open()
    },
  }
}
