import React, { useEffect, useState } from 'react'
import { ActivityIndicator, BackHandler, Pressable, Text, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { loadPairing, type Pairing } from './src/config'
import { StoreProvider, useStore } from './src/store'
import { ChatScreen } from './src/screens/ChatScreen'
import { PairScreen } from './src/screens/PairScreen'
import { SearchScreen } from './src/screens/SearchScreen'
import { SessionsScreen } from './src/screens/SessionsScreen'
import { SettingsScreen } from './src/screens/SettingsScreen'
import { TasksScreen } from './src/screens/TasksScreen'
import { WalkScreen } from './src/screens/WalkScreen'
import { Button, useTheme } from './src/ui'

type Tab = 'sessions' | 'tasks' | 'walk' | 'search' | 'settings'
const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'sessions', label: 'Sessions', icon: '💬' },
  { key: 'tasks', label: 'Backlog', icon: '☰' },
  { key: 'walk', label: 'Walk', icon: '🎙' },
  { key: 'search', label: 'Search', icon: '⌕' },
  { key: 'settings', label: 'Settings', icon: '⚙' },
]

function Approvals() {
  const t = useTheme()
  const { state, decide } = useStore()
  if (!state.pending.length) return null
  return (
    <View style={{ padding: 8, gap: 6 }}>
      {state.pending.map(p => (
        <View key={p.id} style={{ backgroundColor: t.surface, borderColor: t.warn, borderWidth: 1, borderRadius: 12, padding: 10, gap: 6 }}>
          <Text style={{ color: t.text }}>
            <Text style={{ fontWeight: '700' }}>{p.session}</Text> wants to use <Text style={{ fontWeight: '700' }}>{p.tool_name}</Text>
          </Text>
          <Text style={{ color: t.muted, fontSize: 13 }}>{p.description}</Text>
          <Text numberOfLines={3} style={{ color: t.muted, fontSize: 11, fontFamily: 'Menlo' }}>
            {p.input_preview}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
            <Button small kind="danger" title="Deny" onPress={() => void decide(p.id, 'deny')} />
            <Button small kind="primary" title="Allow" onPress={() => void decide(p.id, 'allow')} />
          </View>
        </View>
      ))}
    </View>
  )
}

function Main() {
  const t = useTheme()
  const { state } = useStore()
  const [tab, setTab] = useState<Tab>('sessions')
  const [chat, setChat] = useState<{ name: string | null } | null>(null)
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (chat) {
        setChat(null)
        return true
      }
      return false
    })
    return () => sub.remove()
  }, [chat])
  const open = (name: string | null) => setChat({ name })
  const unread = Object.values(state.unread).reduce((a, b) => a + b, 0)
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top', 'left', 'right']}>
      {state.conn !== 'open' && (
        <Text style={{ textAlign: 'center', color: t.muted, backgroundColor: t.surface2, padding: 4, fontSize: 12 }}>
          {state.conn === 'connecting' ? 'Connecting to the hub…' : 'Hub unreachable, retrying…'}
        </Text>
      )}
      <Approvals />
      <View style={{ flex: 1 }}>
        {chat ? (
          <ChatScreen name={chat.name} back={() => setChat(null)} />
        ) : tab === 'sessions' ? (
          <SessionsScreen open={open} />
        ) : tab === 'tasks' ? (
          <TasksScreen />
        ) : tab === 'walk' ? (
          <WalkScreen />
        ) : tab === 'search' ? (
          <SearchScreen open={open} />
        ) : (
          <SettingsScreen />
        )}
      </View>
      {!chat && (
        <SafeAreaView edges={['bottom']} style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: t.border, backgroundColor: t.surface }}>
          {TABS.map(x => (
            <Pressable key={x.key} onPress={() => setTab(x.key)} style={{ flex: 1, alignItems: 'center', paddingVertical: 8 }}>
              <Text style={{ fontSize: 18 }}>{x.icon}</Text>
              <Text style={{ fontSize: 11, color: tab === x.key ? t.accent : t.muted }}>
                {x.label}
                {x.key === 'sessions' && unread ? ` (${unread})` : ''}
                {x.key === 'walk' && state.walk ? ' ●' : ''}
              </Text>
            </Pressable>
          ))}
        </SafeAreaView>
      )}
      {state.toast && (
        <View style={{ position: 'absolute', bottom: 90, left: 16, right: 16, backgroundColor: state.toast.kind === 'error' ? t.danger : t.text, borderRadius: 12, padding: 12 }}>
          <Text style={{ color: state.toast.kind === 'error' ? '#fff' : t.bg }}>{state.toast.text}</Text>
        </View>
      )}
    </SafeAreaView>
  )
}

export default function App() {
  const t = useTheme()
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined)
  useEffect(() => {
    void loadPairing().then(setPairing)
  }, [])
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      {pairing === undefined ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}>
          <ActivityIndicator />
        </View>
      ) : pairing === null ? (
        <PairScreen onPaired={setPairing} />
      ) : (
        <StoreProvider key={pairing.url + pairing.token} pairing={pairing} onUnpair={() => setPairing(null)}>
          <Main />
        </StoreProvider>
      )}
    </SafeAreaProvider>
  )
}
