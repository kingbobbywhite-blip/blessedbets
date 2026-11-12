import crypto from 'node:crypto'
import type { WebSocket } from 'ws'
import type { HubToChannel, HubToUi } from '../shared/protocol.ts'

export interface UiClient {
  kind: 'ui'
  id: string
  ws: WebSocket
  /** Set when the phone app (or a browser that registered) identifies itself. */
  deviceId: string | null
  platform: string
  name: string
  /** Willing to record and speak: walk mode in the app, voice switched on in a browser. */
  voice: boolean
  foreground: boolean
  walk: boolean
  target: string | null
  connectedAt: number
  lastActive: number
}

export interface ChannelClient {
  kind: 'channel'
  id: string
  ws: WebSocket
  session: string
  connectedAt: number
}

/**
 * Who is connected right now. The database is the record; this is only the
 * live wiring: which sessions have a channel open, which screens are watching.
 */
export class Bus {
  readonly ui = new Set<UiClient>()
  readonly channels = new Map<string, ChannelClient>()

  addUi(ws: WebSocket, info: Partial<Pick<UiClient, 'deviceId' | 'platform' | 'name'>>): UiClient {
    const now = Date.now()
    const client: UiClient = {
      kind: 'ui',
      id: crypto.randomUUID(),
      ws,
      deviceId: info.deviceId ?? null,
      platform: info.platform ?? 'web',
      name: info.name ?? info.platform ?? 'browser',
      voice: false,
      foreground: true,
      walk: false,
      target: null,
      connectedAt: now,
      lastActive: now,
    }
    this.ui.add(client)
    return client
  }

  removeUi(client: UiClient) {
    this.ui.delete(client)
  }

  /** A newer channel for the same session replaces the older one (Claude Code restarted its server). */
  setChannel(session: string, ws: WebSocket): { client: ChannelClient; replaced: ChannelClient | null } {
    const replaced = this.channels.get(session) ?? null
    const client: ChannelClient = { kind: 'channel', id: crypto.randomUUID(), ws, session, connectedAt: Date.now() }
    this.channels.set(session, client)
    if (replaced && replaced.ws !== ws) {
      try {
        replaced.ws.close(4000, 'replaced by a newer connection')
      } catch {
        // already closed
      }
    }
    return { client, replaced }
  }

  removeChannel(client: ChannelClient): boolean {
    if (this.channels.get(client.session) === client) {
      this.channels.delete(client.session)
      return true
    }
    return false
  }

  isConnected(session: string): boolean {
    const c = this.channels.get(session)
    return Boolean(c && c.ws.readyState === 1)
  }

  sendToChannel(session: string, event: HubToChannel): boolean {
    const c = this.channels.get(session)
    if (!c || c.ws.readyState !== 1) return false
    c.ws.send(JSON.stringify(event))
    return true
  }

  broadcast(event: HubToUi) {
    const data = JSON.stringify(event)
    for (const c of this.ui) if (c.ws.readyState === 1) c.ws.send(data)
  }

  sendToUi(client: UiClient, event: HubToUi): boolean {
    if (client.ws.readyState !== 1) return false
    client.ws.send(JSON.stringify(event))
    return true
  }

  deviceClients(deviceId: string): UiClient[] {
    return [...this.ui].filter(c => c.deviceId === deviceId && c.ws.readyState === 1)
  }

  onlineDeviceIds(): Set<string> {
    return new Set([...this.ui].filter(c => c.deviceId && c.ws.readyState === 1).map(c => c.deviceId!))
  }

  /**
   * Where a push-to-talk press should go: the named device if it is connected,
   * else the most recently active screen with voice switched on, preferring one
   * in walk mode.
   */
  voiceClient(deviceId?: string | null): UiClient | null {
    const open = [...this.ui].filter(c => c.ws.readyState === 1)
    if (deviceId) {
      const match = open.filter(c => c.deviceId === deviceId).sort((a, b) => b.lastActive - a.lastActive)[0]
      if (match) return match
    }
    const voice = open.filter(c => c.voice)
    const pick = (list: UiClient[]) => list.sort((a, b) => b.lastActive - a.lastActive)[0] ?? null
    return pick(voice.filter(c => c.walk)) ?? pick(voice) ?? null
  }

  /**
   * The device that should run a phone action: the named one, else the most
   * recently active phone app, else the most recently active browser.
   */
  actionClient(deviceId?: string | null): UiClient | null {
    const devices = [...this.ui].filter(c => c.ws.readyState === 1 && c.deviceId)
    const list = deviceId ? devices.filter(c => c.deviceId === deviceId) : devices
    return (
      list.sort((a, b) => Number(a.platform === 'web') - Number(b.platform === 'web') || b.lastActive - a.lastActive)[0] ?? null
    )
  }
}
