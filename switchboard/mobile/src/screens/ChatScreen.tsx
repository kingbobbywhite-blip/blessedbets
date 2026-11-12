import React, { useEffect, useRef, useState } from 'react'
import { Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { useStore } from '../store'
import type { Message } from '../types'
import { Button, RichText, STATUS_LABEL, StatusDot, base, clock, liveStatus, useTheme } from '../ui'
import { stopSpeaking } from '../voice'

export function ChatScreen({ name, back }: { name: string | null; back: () => void }) {
  const t = useTheme()
  const store = useStore()
  const { state } = store
  const session = name ? state.sessions[name] : null
  const messages = (name ? state.threads[name] : state.feed) ?? []
  const [text, setText] = useState('')
  const [screen, setScreen] = useState(false)
  const list = useRef<FlatList<Message>>(null)

  useEffect(() => {
    store.dispatch({ type: 'set', patch: { viewing: name } })
    void store.loadThread(name).catch(err => store.toast((err as Error).message, 'error'))
    if (name) store.markRead(name)
    return () => store.dispatch({ type: 'set', patch: { viewing: null } })
  }, [name])

  const send = async () => {
    const body = text.trim()
    if (!body || !name) return
    setText('')
    try {
      await store.send(name, body)
    } catch (err) {
      setText(body)
      store.toast((err as Error).message, 'error')
    }
  }

  const control = async (what: string, body: object = {}) => {
    try {
      const r = await store.api.call('POST', `/api/sessions/${name}/${what}`, body, 150000)
      store.toast(r?.note ? `${name}: ${r.note}` : `${what} sent`)
    } catch (err) {
      store.toast((err as Error).message, 'error')
    }
  }
  const more = () =>
    Alert.alert(name ?? '', undefined, [
      { text: 'Interrupt (Esc)', onPress: () => void control('interrupt') },
      { text: 'Restart, same conversation', onPress: () => void control('restart') },
      { text: 'Talk to it by voice', onPress: () => store.setTarget(name!) },
      { text: 'Stop session', style: 'destructive', onPress: () => void control('stop') },
      { text: 'Cancel', style: 'cancel' },
    ])

  const st = session ? liveStatus(session) : null
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      <View style={[base.row, { gap: 8, padding: 10, borderBottomWidth: 1, borderColor: t.border, backgroundColor: t.surface }]}>
        <Pressable onPress={back} hitSlop={12}>
          <Text style={{ color: t.accent, fontSize: 28, paddingHorizontal: 6 }}>‹</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <View style={[base.row, { gap: 6 }]}>
            {session && <StatusDot session={session} />}
            <Text style={{ color: t.text, fontWeight: '700', fontSize: 17 }}>{name ?? 'Everything'}</Text>
          </View>
          <Text numberOfLines={1} style={{ color: t.muted, fontSize: 12 }}>
            {session ? `${STATUS_LABEL[st!] ?? st}${session.status_text ? ` · ${session.status_text}` : ''}` : 'Every message, every session'}
          </Text>
        </View>
        {session?.managed && <Button small title="Screen" onPress={() => setScreen(true)} />}
        {session && <Button small title="⋯" onPress={more} />}
      </View>
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={m => String(m.id)}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        onRefresh={() => void (messages[0] && store.loadThread(name, messages[0].id))}
        refreshing={false}
        renderItem={({ item }) => <Bubble m={item} name={name} />}
      />
      {name && (
        <View style={[base.row, { gap: 8, padding: 8, borderTopWidth: 1, borderColor: t.border, backgroundColor: t.surface }]}>
          <TextInput
            placeholder={`Message ${name}…`}
            placeholderTextColor={t.muted}
            multiline
            value={text}
            onChangeText={setText}
            style={{ flex: 1, maxHeight: 140, borderWidth: 1, borderColor: t.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9, color: t.text, backgroundColor: t.bg }}
          />
          {text.trim() ? (
            <Button kind="primary" title="Send" onPress={() => void send()} />
          ) : (
            <MicButton small target={name} />
          )}
        </View>
      )}
      {name && <ScreenPeek name={name} visible={screen} onClose={() => setScreen(false)} />}
    </KeyboardAvoidingView>
  )
}

function Bubble({ m, name }: { m: Message; name: string | null }) {
  const t = useTheme()
  const { say } = useStore()
  const mine = m.from_id === 'user'
  const system = m.from_id === 'system'
  const between = !mine && !system && m.to_id !== 'user'
  if (system) return <Text style={{ color: t.muted, fontSize: 13, textAlign: 'center', marginVertical: 2 }}>{m.body}</Text>
  const label = mine ? (name ? '' : `You → ${m.to_id}`) : between || !name ? `${m.from_id} → ${m.to_id === 'user' ? 'you' : m.to_id}` : ''
  return (
    <Pressable
      onLongPress={() => {
        stopSpeaking()
        say(m.body)
      }}
      style={{
        alignSelf: mine ? 'flex-end' : 'flex-start',
        maxWidth: '85%',
        backgroundColor: mine ? t.mine : between ? t.between : t.surface,
        borderColor: t.border,
        borderWidth: mine ? 0 : 1,
        borderRadius: 16,
        paddingHorizontal: 12,
        paddingVertical: 8,
      }}
    >
      {label ? <Text style={{ color: mine ? '#fff' : t.muted, fontSize: 11, fontWeight: '600', marginBottom: 2 }}>{label}</Text> : null}
      <RichText text={m.body} color={mine ? '#ffffff' : t.text} />
      <Text style={{ color: mine ? 'rgba(255,255,255,0.75)' : t.muted, fontSize: 10, alignSelf: 'flex-end', marginTop: 3 }}>
        {m.kind === 'voice' ? '🎙 ' : ''}
        {clock(m.created_at)}
        {mine ? (m.seen_at ? '  ✓✓ seen' : m.delivered_at ? '  ✓✓' : '  ✓') : ''}
      </Text>
    </Pressable>
  )
}

export function MicButton({ small, target }: { small?: boolean; target?: string | null }) {
  const t = useTheme()
  const store = useStore()
  const { state } = store
  const toggle = state.settings.pttMode === 'toggle'
  const size = small ? 42 : 168
  return (
    <Pressable
      accessibilityLabel={toggle ? 'Tap to talk' : 'Hold to talk'}
      onPressIn={() => {
        if (target && state.target !== target) store.setTarget(target)
        if (toggle) store.toggleVoice()
        else void store.startVoice()
      }}
      onPressOut={() => {
        if (!toggle) store.stopVoice()
      }}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: state.listening ? t.danger : t.accent,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: small ? 18 : 56, color: '#fff' }}>{state.listening ? '●' : '🎙'}</Text>
    </Pressable>
  )
}

const KEYS = ['Escape', 'Enter', 'Up', 'Down', 'Tab', '1', '2', '3', 'y', 'n', 'C-c']

function ScreenPeek({ name, visible, onClose }: { name: string; visible: boolean; onClose: () => void }) {
  const t = useTheme()
  const { api, toast } = useStore()
  const [screen, setScreen] = useState('')
  const [text, setText] = useState('')
  const load = () =>
    api
      .call('GET', `/api/sessions/${name}/screen?lines=60`)
      .then(r => setScreen(r.screen))
      .catch(err => setScreen(`(${(err as Error).message})`))
  useEffect(() => {
    if (!visible) return
    void load()
    const timer = setInterval(() => void load(), 2000)
    return () => clearInterval(timer)
  }, [visible, name])
  const keys = async (body: object) => {
    await api.call('POST', `/api/sessions/${name}/keys`, body).catch(err => toast((err as Error).message, 'error'))
    setTimeout(() => void load(), 350)
  }
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.bg, padding: 14, gap: 10 }}>
        <View style={[base.row, { justifyContent: 'space-between' }]}>
          <Text style={[base.h2, { color: t.text }]}>{name}: terminal</Text>
          <Button small title="Close" onPress={onClose} />
        </View>
        <ScrollView style={{ flex: 1, backgroundColor: '#0b0d12', borderRadius: 10 }} horizontal={false}>
          <ScrollView horizontal>
            <Text style={{ color: '#d7dbe3', fontFamily: 'Menlo', fontSize: 10, padding: 8 }}>{screen}</Text>
          </ScrollView>
        </ScrollView>
        <View style={[base.row, { flexWrap: 'wrap', gap: 6 }]}>
          {KEYS.map(k => (
            <Button key={k} small title={k === 'Escape' ? 'Esc' : k} onPress={() => void keys({ keys: [k] })} />
          ))}
        </View>
        <View style={[base.row, { gap: 8 }]}>
          <TextInput
            placeholder="Type into the terminal"
            placeholderTextColor={t.muted}
            autoCapitalize="none"
            value={text}
            onChangeText={setText}
            style={{ flex: 1, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 10, color: t.text, backgroundColor: t.surface }}
          />
          <Button
            title="Send"
            onPress={() => {
              void keys({ text, enter: true })
              setText('')
            }}
          />
        </View>
      </View>
    </Modal>
  )
}
