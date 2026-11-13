import React, { useState } from 'react'
import { FlatList, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { useStore } from '../store'
import type { Session } from '../types'
import { Button, STATUS_LABEL, StatusDot, base, liveStatus, timeAgo, useTheme } from '../ui'

export function SessionsScreen({ open }: { open: (name: string | null) => void }) {
  const t = useTheme()
  const { state } = useStore()
  const [creating, setCreating] = useState(false)
  const sessions = Object.values(state.sessions).sort((a, b) => {
    if (a.role !== b.role) return a.role === 'orchestrator' ? -1 : 1
    return (b.last_message?.id ?? 0) - (a.last_message?.id ?? 0) || a.name.localeCompare(b.name)
  })
  return (
    <View style={{ flex: 1 }}>
      <View style={[base.row, { justifyContent: 'space-between', padding: 16 }]}>
        <Text style={[base.h1, { color: t.text }]}>Sessions</Text>
        <Button title="+ New" kind="primary" onPress={() => setCreating(true)} />
      </View>
      <FlatList
        data={sessions}
        keyExtractor={s => s.name}
        contentContainerStyle={{ paddingHorizontal: 12, gap: 8, paddingBottom: 24 }}
        ListEmptyComponent={<Text style={{ color: t.muted, textAlign: 'center', marginTop: 40 }}>No sessions yet. Start one, or run "switchboard up" on the hub.</Text>}
        renderItem={({ item }) => <Row s={item} unread={state.unread[item.name] ?? 0} onPress={() => open(item.name)} />}
        ListFooterComponent={
          <Pressable onPress={() => open(null)} style={{ padding: 8 }}>
            <Text style={{ color: t.accent }}>Everything, all sessions →</Text>
          </Pressable>
        }
      />
      <NewSession visible={creating} onClose={() => setCreating(false)} onStarted={open} />
    </View>
  )
}

function Row({ s, unread, onPress }: { s: Session; unread: number; onPress: () => void }) {
  const t = useTheme()
  const st = liveStatus(s)
  const last = s.last_message
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: 14, padding: 12, opacity: pressed ? 0.8 : 1 })}>
      <View style={[base.row, { gap: 10 }]}>
        <StatusDot session={s} />
        <Text style={{ color: t.text, fontWeight: '700', fontSize: 16, flex: 1 }}>
          {s.role === 'orchestrator' ? '★ ' : ''}
          {s.name}
        </Text>
        <Text style={{ color: t.muted, fontSize: 12 }}>{last ? timeAgo(last.created_at) : ''}</Text>
        {unread > 0 && (
          <View style={{ backgroundColor: t.accent, borderRadius: 9, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 }}>
            <Text style={{ color: t.accentText, fontSize: 11, fontWeight: '700' }}>{unread}</Text>
          </View>
        )}
      </View>
      <Text style={{ color: st === 'waiting' || st === 'attention' ? t.warn : t.muted, fontSize: 13, marginTop: 3, marginLeft: 20 }}>
        {STATUS_LABEL[st] ?? st}
        {s.managed && !s.connected && !['offline', 'exited', 'starting', 'attention'].includes(st) ? ' · channel not connected' : ''}
        {s.status_text ? ` · ${s.status_text}` : ''}
      </Text>
      {last && (
        <Text numberOfLines={1} style={{ color: t.muted, fontSize: 13, marginTop: 2, marginLeft: 20 }}>
          {last.from_id === 'user' ? 'You: ' : last.from_id !== s.name ? `${last.from_id}: ` : ''}
          {last.body}
        </Text>
      )}
    </Pressable>
  )
}

function NewSession({ visible, onClose, onStarted }: { visible: boolean; onClose: () => void; onStarted: (name: string) => void }) {
  const t = useTheme()
  const { api, toast } = useStore()
  const [f, setF] = useState({ name: '', cwd: '', description: '', prompt: '', model: '' })
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const input = (key: keyof typeof f, placeholder: string, multiline = false) => (
    <TextInput
      placeholder={placeholder}
      placeholderTextColor={t.muted}
      autoCapitalize="none"
      autoCorrect={false}
      multiline={multiline}
      value={f[key]}
      onChangeText={v => setF({ ...f, [key]: v })}
      style={{ borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 11, color: t.text, backgroundColor: t.surface, minHeight: multiline ? 80 : undefined }}
    />
  )
  const start = async () => {
    setBusy(true)
    setNote(null)
    try {
      const r = await api.call('POST', '/api/sessions', { ...f, name: f.name.trim().toLowerCase() }, 150000)
      if (r.ready) {
        toast(`${r.session.name} is ready`)
        onClose()
        onStarted(r.session.name)
      } else setNote(`${r.note}${r.screen ? `\n\n${r.screen}` : ''}`)
    } catch (err) {
      setNote((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 20, gap: 12 }}>
        <Text style={[base.h1, { color: t.text }]}>New session</Text>
        {input('name', 'name, e.g. api')}
        {input('cwd', 'folder on the hub, e.g. ~/code/blessedbets')}
        {input('description', 'what it is for')}
        {input('prompt', 'first message (optional)', true)}
        <View style={[base.row, { flexWrap: 'wrap', gap: 6 }]}>
          {['', 'opus', 'sonnet', 'haiku'].map(m => (
            <Pressable key={m} onPress={() => setF({ ...f, model: m })} style={{ borderWidth: 1, borderColor: f.model === m ? t.accent : t.border, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 11 }}>
              <Text style={{ color: f.model === m ? t.accent : t.text }}>{m || 'default model'}</Text>
            </Pressable>
          ))}
        </View>
        {note && <Text style={{ color: t.text, fontFamily: 'Menlo', fontSize: 11 }}>{note}</Text>}
        <View style={[base.row, { gap: 8, justifyContent: 'flex-end' }]}>
          <Button title="Cancel" onPress={onClose} />
          <Button title={busy ? 'Starting…' : 'Start'} kind="primary" disabled={busy || !f.name} onPress={() => void start()} />
        </View>
      </ScrollView>
    </Modal>
  )
}
