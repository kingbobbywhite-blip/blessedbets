import React, { useEffect } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { useKeepAwake } from 'expo-keep-awake'
import { useStore } from '../store'
import { Button, Chip, RichText, base, clock, useTheme } from '../ui'
import { stopSpeaking } from '../voice'
import { MicButton } from './ChatScreen'

export function WalkScreen() {
  const t = useTheme()
  const store = useStore()
  const { state } = store
  useKeepAwake()
  useEffect(() => {
    void store.loadThread(null).catch(() => {})
  }, [])
  const target = state.target ?? state.info?.orchestrator ?? 'boss'
  const recent = state.feed.filter(m => m.to_id === 'user' || m.from_id === 'user').slice(-4)
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 18 }}>
      <View style={[base.row, { justifyContent: 'space-between' }]}>
        <Text style={[base.h1, { color: t.text }]}>Walk</Text>
        <Button
          kind={state.walk ? 'danger' : 'primary'}
          title={state.walk ? 'Stop walk mode' : 'Start walk mode'}
          onPress={() => store.setWalk(!state.walk)}
        />
      </View>
      <Text style={{ color: t.muted }}>
        {state.walk
          ? 'Walk mode is on: replies are read aloud and the app keeps listening for your Flic button with the screen off.'
          : 'Turn on walk mode before you pocket the phone: it keeps the app connected in the background, reads replies aloud, and lets your Flic button (or headset button) start and stop talking.'}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {Object.values(state.sessions).map(s => (
          <Chip key={s.name} label={s.name} on={s.name === target} onPress={() => store.setTarget(s.name)} />
        ))}
      </ScrollView>
      <View style={{ alignItems: 'center', gap: 14 }}>
        <Text style={{ color: t.text, fontSize: 16 }}>
          Talking to <Text style={{ fontWeight: '700' }}>{target}</Text>
        </Text>
        <MicButton />
        <Text style={{ color: t.muted, textAlign: 'center', minHeight: 40 }}>
          {state.listening ? state.interim || 'Listening…' : state.settings.pttMode === 'toggle' ? 'Tap to talk, tap again to send' : 'Hold to talk, let go to send'}
        </Text>
        <Button
          title="Stop talking"
          onPress={() => {
            stopSpeaking()
            store.cancelVoice()
          }}
        />
      </View>
      {recent.map(m => (
        <View key={m.id} style={{ backgroundColor: m.from_id === 'user' ? t.accentSoft : t.surface, borderColor: t.border, borderWidth: 1, borderRadius: 14, padding: 12 }}>
          <Text style={{ color: t.muted, fontSize: 12 }}>
            {m.from_id === 'user' ? `You → ${m.to_id}` : m.from_id} · {clock(m.created_at)}
          </Text>
          <RichText text={m.body} color={t.text} style={{ fontSize: 17, lineHeight: 24 }} />
        </View>
      ))}
    </ScrollView>
  )
}
