import React from 'react'
import { Pressable, StyleSheet, Text, View, useColorScheme, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import type { Session } from './types'

export const light = {
  bg: '#f6f7f9',
  surface: '#ffffff',
  surface2: '#eef0f4',
  text: '#15171c',
  muted: '#646b78',
  border: '#dde1e8',
  accent: '#3b5bdb',
  accentText: '#ffffff',
  accentSoft: '#e7ecff',
  mine: '#3b5bdb',
  between: '#fff6e0',
  danger: '#c92a2a',
  ok: '#2b8a3e',
  warn: '#e8590c',
  p: ['#c92a2a', '#e8590c', '#3b5bdb', '#868e96'],
}
export const dark: typeof light = {
  bg: '#111318',
  surface: '#1a1d24',
  surface2: '#242833',
  text: '#eceef3',
  muted: '#9aa1ae',
  border: '#2d323d',
  accent: '#7c9cff',
  accentText: '#0d1020',
  accentSoft: '#232b48',
  mine: '#4c6ef5',
  between: '#2f2a1c',
  danger: '#ff6b6b',
  ok: '#69db7c',
  warn: '#ffa94d',
  p: ['#ff6b6b', '#ffa94d', '#7c9cff', '#868e96'],
}
export type Theme = typeof light
export const useTheme = (): Theme => (useColorScheme() === 'dark' ? dark : light)

export const STATUS_LABEL: Record<string, string> = {
  idle: 'idle',
  busy: 'working',
  waiting: 'needs you',
  starting: 'starting',
  attention: 'needs attention',
  offline: 'offline',
  exited: 'exited',
}

export function liveStatus(s: Session): string {
  if (['offline', 'exited', 'starting', 'attention'].includes(s.status)) return s.status
  return s.connected || s.managed ? s.status : 'offline'
}

export function StatusDot({ session }: { session: Session }) {
  const t = useTheme()
  const st = liveStatus(session)
  const color =
    st === 'idle' ? t.ok : st === 'busy' || st === 'starting' ? t.accent : st === 'waiting' || st === 'attention' ? t.warn : st === 'exited' ? t.danger : t.p[3]
  return <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
}

export function Button({
  title,
  onPress,
  kind = 'default',
  small,
  disabled,
  style,
}: {
  title: string
  onPress: () => void
  kind?: 'default' | 'primary' | 'danger'
  small?: boolean
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const t = useTheme()
  const bg = kind === 'primary' ? t.accent : t.surface
  const fg = kind === 'primary' ? t.accentText : kind === 'danger' ? t.danger : t.text
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderColor: kind === 'primary' ? t.accent : t.border,
          borderWidth: 1,
          borderRadius: small ? 8 : 10,
          paddingVertical: small ? 5 : 9,
          paddingHorizontal: small ? 10 : 14,
          opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
          alignItems: 'center',
        },
        style,
      ]}
    >
      <Text style={{ color: fg, fontWeight: kind === 'primary' ? '600' : '400', fontSize: small ? 13 : 15 }}>{title}</Text>
    </Pressable>
  )
}

export function Chip({ label, on, onPress }: { label: string; on?: boolean; onPress?: () => void }) {
  const t = useTheme()
  return (
    <Pressable
      onPress={onPress}
      style={{
        borderWidth: 1,
        borderColor: on ? t.accent : t.border,
        backgroundColor: on ? t.accentSoft : t.surface,
        borderRadius: 999,
        paddingVertical: 4,
        paddingHorizontal: 11,
        marginRight: 6,
      }}
    >
      <Text style={{ color: on ? t.accent : t.text, fontSize: 13 }}>{label}</Text>
    </Pressable>
  )
}

/** Plain text with `code`, **bold** and code blocks set apart; enough for chat replies. */
export function RichText({ text, color, style }: { text: string; color: string; style?: StyleProp<TextStyle> }) {
  const t = useTheme()
  const parts = text.split(/(```[\s\S]*?```)/g)
  return (
    <View>
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const code = part.replace(/^```\w*\n?/, '').replace(/```$/, '')
          return (
            <Text key={i} style={{ fontFamily: 'Menlo', fontSize: 12, backgroundColor: t.surface2, color: t.text, padding: 6, borderRadius: 6, marginVertical: 4 }}>
              {code}
            </Text>
          )
        }
        const inline = part.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)
        return (
          <Text key={i} style={[{ color, fontSize: 15, lineHeight: 21 }, style]}>
            {inline.map((seg, j) =>
              seg.startsWith('`') ? (
                <Text key={j} style={{ fontFamily: 'Menlo', fontSize: 13 }}>
                  {seg.slice(1, -1)}
                </Text>
              ) : seg.startsWith('**') ? (
                <Text key={j} style={{ fontWeight: '700' }}>
                  {seg.slice(2, -2)}
                </Text>
              ) : (
                seg
              ),
            )}
          </Text>
        )
      })}
    </View>
  )
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

export function clock(iso: string): string {
  const d = new Date(iso)
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export const base = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  h1: { fontSize: 24, fontWeight: '700' },
  h2: { fontSize: 17, fontWeight: '600' },
  small: { fontSize: 12 },
})
