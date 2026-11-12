/**
 * Push notifications through Expo's push service, for when the phone app is
 * not connected (closed, or asleep in your pocket outside walk mode).
 */
export interface PushMessage {
  to: string
  title?: string
  body: string
  data?: Record<string, unknown>
  categoryId?: string
  sound?: 'default' | null
  priority?: 'default' | 'normal' | 'high'
  channelId?: string
}

export function isExpoToken(token: string | null | undefined): token is string {
  return Boolean(token && /^Expo(nent)?PushToken\[.+\]$/.test(token))
}

export async function sendPush(messages: PushMessage[], accessToken: string | null, log: (m: string) => void): Promise<void> {
  const valid = messages.filter(m => isExpoToken(m.to))
  if (!valid.length) return
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(valid.map(m => ({ sound: 'default', priority: 'high', channelId: 'messages', ...m }))),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) log(`push failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
  } catch (err) {
    log(`push failed: ${(err as Error).message}`)
  }
}
