import React, { useEffect, useState } from 'react'
import { Alert, ScrollView, Switch, Text, View } from 'react-native'
import type { Voice } from 'expo-speech'
import { useStore } from '../store'
import type { AppSettings } from '../config'
import { Button, Chip, base, useTheme } from '../ui'
import { currentUpdate, installNativeBuild, nativeBuildOffer, otaAvailable, type NativeBuild } from '../updates'
import { voices } from '../voice'

export function SettingsScreen() {
  const t = useTheme()
  const store = useStore()
  const { state } = store
  const s = state.settings
  const [voiceList, setVoiceList] = useState<Voice[]>([])
  const [native, setNative] = useState<NativeBuild | null>(null)
  useEffect(() => {
    void voices().then(v => setVoiceList(v.filter(x => x.language?.startsWith('en')).slice(0, 30)))
    void nativeBuildOffer(store.api).then(setNative)
  }, [])
  const toggle = (key: keyof AppSettings, label: string, hint?: string) => (
    <View style={[base.row, { justifyContent: 'space-between', gap: 12, paddingVertical: 6 }]}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontSize: 15 }}>{label}</Text>
        {hint && <Text style={{ color: t.muted, fontSize: 12 }}>{hint}</Text>}
      </View>
      <Switch value={Boolean(s[key])} onValueChange={v => store.updateSettings({ [key]: v } as Partial<AppSettings>)} />
    </View>
  )
  const panel = (title: string, children: React.ReactNode) => (
    <View style={{ backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: 14, padding: 14, gap: 6 }}>
      <Text style={[base.h2, { color: t.text, marginBottom: 4 }]}>{title}</Text>
      {children}
    </View>
  )
  const update = currentUpdate()
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
      <Text style={[base.h1, { color: t.text }]}>Settings</Text>
      {panel(
        'Voice',
        <>
          {toggle('autoSpeak', 'Read every reply aloud', 'Walk mode always does')}
          {toggle('announceSender', 'Say who is talking')}
          {toggle('readBack', 'Read back what I said before it goes')}
          {toggle('mediaButton', 'Headset or Flic media button toggles talking', 'In walk mode, play/pause starts and stops a recording')}
          {toggle('notifyInWalk', 'Also show replies as notifications in walk mode')}
          <Text style={{ color: t.muted, marginTop: 6 }}>Push-to-talk</Text>
          <View style={base.row}>
            <Chip label="Tap to start, tap to send" on={s.pttMode === 'toggle'} onPress={() => store.updateSettings({ pttMode: 'toggle' })} />
            <Chip label="Hold to talk" on={s.pttMode === 'hold'} onPress={() => store.updateSettings({ pttMode: 'hold' })} />
          </View>
          <Text style={{ color: t.muted, marginTop: 6 }}>Transcription</Text>
          <View style={[base.row, { flexWrap: 'wrap', gap: 4 }]}>
            <Chip label={`Automatic (${state.info?.stt ? 'hub' : 'phone'})`} on={s.transcribe === 'auto'} onPress={() => store.updateSettings({ transcribe: 'auto' })} />
            <Chip label="On the phone" on={s.transcribe === 'device'} onPress={() => store.updateSettings({ transcribe: 'device' })} />
            {state.info?.stt && <Chip label={`On the hub (${state.info.stt_model})`} on={s.transcribe === 'hub'} onPress={() => store.updateSettings({ transcribe: 'hub' })} />}
          </View>
          <Text style={{ color: t.muted, marginTop: 6 }}>Speed {s.rate.toFixed(1)}×</Text>
          <View style={base.row}>
            {[0.9, 1.0, 1.1, 1.25, 1.5].map(r => (
              <Chip key={r} label={`${r}×`} on={Math.abs(s.rate - r) < 0.01} onPress={() => store.updateSettings({ rate: r })} />
            ))}
          </View>
          <Text style={{ color: t.muted, marginTop: 6 }}>Voice</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Chip label="System" on={!s.voice} onPress={() => store.updateSettings({ voice: null })} />
            {voiceList.map(v => (
              <Chip key={v.identifier} label={v.name} on={s.voice === v.identifier} onPress={() => store.updateSettings({ voice: v.identifier })} />
            ))}
          </ScrollView>
          <Button title="Test voice" onPress={() => store.say('This is how replies will sound.')} style={{ marginTop: 6 }} />
        </>,
      )}
      {panel(
        'Flic button',
        <>
          <Text style={{ color: t.text }}>
            In the Flic app, give the button an Internet Request action for Click (toggle talking), Double click (cancel) and Hold (start). The exact links, with
            your token, are in the hub's web UI under Settings → Flic, or printed by "switchboard flic".
          </Text>
          <Text style={{ color: t.muted, fontSize: 12 }}>
            The press reaches this phone through the hub, so keep walk mode on. With a Flic Hub, the script in switchboard/flic gives real hold-to-talk.
          </Text>
        </>,
      )}
      {panel(
        'What sessions may do on this phone',
        <>
          {toggle('allowLocation', 'Read my location')}
          {toggle('allowClipboard', 'Read my clipboard')}
          {toggle('allowCalendar', 'Read and add calendar events')}
          <Text style={{ color: t.muted, fontSize: 12 }}>Speaking, notifications, vibration, opening links, and drafting texts and emails (you press send) are always allowed.</Text>
        </>,
      )}
      {panel(
        'App updates',
        <>
          {toggle('autoUpdate', 'Update myself automatically', 'New versions published by your sessions are applied when you are not talking')}
          <Text style={{ color: t.muted, fontSize: 12 }}>
            Version {update.appVersion} · runtime {update.runtimeVersion ?? '—'} · {update.embedded ? 'built-in bundle' : `update ${update.updateId?.slice(0, 8)}`}
            {update.createdAt ? ` from ${new Date(update.createdAt).toLocaleString()}` : ''}
            {otaAvailable ? '' : ' · over-the-air updates are off in this build (development build, or no hub URL at build time)'}
          </Text>
          <Button title={state.updateReady ? 'Restart into the new version' : 'Check for an update now'} onPress={() => void store.checkForUpdate(true)} />
          {native && (
            <View style={{ gap: 6, marginTop: 6 }}>
              <Text style={{ color: t.text }}>A new build of the app is available ({native.version}). {native.message}</Text>
              <Button
                kind="primary"
                title="Download and install"
                onPress={() => void installNativeBuild(store.api, native).catch(err => store.toast((err as Error).message, 'error'))}
              />
            </View>
          )}
        </>,
      )}
      {panel(
        'Hub',
        <>
          <Text style={{ color: t.text }}>{store.pairing.url}</Text>
          <Text style={{ color: t.muted, fontSize: 12 }}>
            Connection {state.conn} · hub {state.info?.version ?? '?'} · orchestrator {state.info?.orchestrator ?? '?'}
          </Text>
          <Button
            kind="danger"
            title="Unpair this phone"
            onPress={() =>
              Alert.alert('Unpair?', 'You will need the pairing code again.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Unpair', style: 'destructive', onPress: () => void store.unpair() },
              ])
            }
          />
        </>,
      )}
    </ScrollView>
  )
}
