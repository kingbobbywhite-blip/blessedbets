import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import { AppState, Platform } from 'react-native'
import * as Device from 'expo-device'
import * as Haptics from 'expo-haptics'
import * as Notifications from 'expo-notifications'
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder } from 'expo-audio'
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition'
import Constants from 'expo-constants'
import { connectSocket, makeApi, type Api, type Socket } from './api'
import { CAPABILITIES, runAction } from './actions'
import { defaultSettings, deviceId, loadSettings, saveSettings, savePairing, type AppSettings, type Pairing } from './config'
import { localNotification, pushToken, setupNotifications } from './notifications'
import type { Message, PermissionRequest, Project, Session, Task } from './types'
import { applyUpdate, currentUpdate, fetchNewUpdate } from './updates'
import { chime, isSpeaking, speak, startWalkAudio, stopSpeaking, stopWalkAudio, updateWalkAudio } from './voice'

export type Conn = 'connecting' | 'open' | 'closed'

export interface State {
  conn: Conn
  info: { orchestrator: string; stt: boolean; stt_model: string | null; version: string } | null
  sessions: Record<string, Session>
  threads: Record<string, Message[]>
  feed: Message[]
  pending: PermissionRequest[]
  projects: Project[]
  tasks: Task[] | null
  unread: Record<string, number>
  settings: AppSettings
  target: string | null
  walk: boolean
  listening: boolean
  interim: string
  viewing: string | null
  updateReady: boolean
  toast: { text: string; kind: 'info' | 'error'; at: number } | null
}

const initial: State = {
  conn: 'connecting',
  info: null,
  sessions: {},
  threads: {},
  feed: [],
  pending: [],
  projects: [],
  tasks: null,
  unread: {},
  settings: defaultSettings,
  target: null,
  walk: false,
  listening: false,
  interim: '',
  viewing: null,
  updateReady: false,
  toast: null,
}

type Action =
  | { type: 'set'; patch: Partial<State> }
  | { type: 'hello'; sessions: Session[]; pending: PermissionRequest[]; orchestrator: string }
  | { type: 'session'; session: Session }
  | { type: 'message'; message: Message }
  | { type: 'messages'; name: string | null; messages: Message[] }
  | { type: 'message_update'; id: number; patch: Partial<Message> }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'task'; task: Task }
  | { type: 'task_deleted'; id: number }
  | { type: 'project'; project: Project }
  | { type: 'read'; name: string }

function upsert(list: Message[], m: Message): Message[] {
  const i = list.findIndex(x => x.id === m.id)
  if (i >= 0) {
    const copy = list.slice()
    copy[i] = { ...copy[i], ...m }
    return copy
  }
  const next = [...list, m]
  return list.length && list[list.length - 1].id > m.id ? next.sort((a, b) => a.id - b.id) : next
}

function threadsOf(m: Message): string[] {
  const out = new Set<string>()
  for (const id of [m.from_id, m.to_id]) if (id !== 'user' && id !== 'system') out.add(id)
  const s = (m.meta as { session?: string } | undefined)?.session
  if (m.from_id === 'system' && s) out.add(s)
  return [...out]
}

function reducer(state: State, a: Action): State {
  switch (a.type) {
    case 'set':
      return { ...state, ...a.patch }
    case 'hello': {
      const sessions: Record<string, Session> = {}
      const unread: Record<string, number> = {}
      for (const s of a.sessions) {
        sessions[s.name] = s
        if (s.unread) unread[s.name] = s.unread
      }
      return { ...state, sessions, unread, pending: a.pending, target: state.target ?? a.orchestrator }
    }
    case 'session':
      return { ...state, sessions: { ...state.sessions, [a.session.name]: a.session } }
    case 'message': {
      const m = a.message
      const threads = { ...state.threads }
      for (const n of threadsOf(m)) threads[n] = upsert(threads[n] ?? [], m)
      const unread = { ...state.unread }
      if (m.to_id === 'user' && m.from_id !== 'system' && state.viewing !== m.from_id) unread[m.from_id] = (unread[m.from_id] ?? 0) + 1
      return { ...state, threads, feed: upsert(state.feed, m).slice(-300), unread }
    }
    case 'messages': {
      if (!a.name) {
        let feed = state.feed
        for (const m of a.messages) feed = upsert(feed, m)
        return { ...state, feed }
      }
      let list = state.threads[a.name] ?? []
      for (const m of a.messages) list = upsert(list, m)
      return { ...state, threads: { ...state.threads, [a.name]: list } }
    }
    case 'message_update': {
      const patch = (m: Message) => (m.id === a.id ? { ...m, ...a.patch } : m)
      const threads: Record<string, Message[]> = {}
      for (const [k, v] of Object.entries(state.threads)) threads[k] = v.some(m => m.id === a.id) ? v.map(patch) : v
      return { ...state, threads, feed: state.feed.map(patch) }
    }
    case 'permission': {
      const others = state.pending.filter(p => p.id !== a.request.id)
      return { ...state, pending: a.request.status === 'pending' ? [...others, a.request] : others }
    }
    case 'task':
      return state.tasks ? { ...state, tasks: [...state.tasks.filter(t => t.id !== a.task.id), a.task] } : state
    case 'task_deleted':
      return state.tasks ? { ...state, tasks: state.tasks.filter(t => t.id !== a.id) } : state
    case 'project':
      return { ...state, projects: [...state.projects.filter(p => p.slug !== a.project.slug), a.project] }
    case 'read':
      return { ...state, unread: { ...state.unread, [a.name]: 0 } }
  }
  return state
}

export interface Store {
  state: State
  api: Api
  pairing: Pairing
  dispatch: React.Dispatch<Action>
  toast(text: string, kind?: 'info' | 'error'): void
  say(text: string): void
  startVoice(): Promise<void>
  stopVoice(): void
  cancelVoice(): void
  toggleVoice(): void
  setWalk(on: boolean): void
  setTarget(name: string): void
  updateSettings(patch: Partial<AppSettings>): void
  loadThread(name: string | null, before?: number): Promise<Message[]>
  send(to: string, body: string): Promise<void>
  markRead(name: string): void
  decide(id: number, behavior: 'allow' | 'deny'): Promise<void>
  loadTasks(): Promise<void>
  unpair(): Promise<void>
  checkForUpdate(manual?: boolean): Promise<void>
}

const Ctx = createContext<Store | null>(null)
export const useStore = (): Store => {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside StoreProvider')
  return s
}

export function StoreProvider({ pairing, onUnpair, children }: { pairing: Pairing; onUnpair: () => void; children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial)
  const ref = useRef(state)
  ref.current = state
  const api = useMemo(() => makeApi(pairing), [pairing])
  const socket = useRef<Socket | null>(null)
  const device = useRef<string>('')
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY)
  const capture = useRef<{ kind: 'hub' | 'device'; cancelled: boolean; text: string; resolve?: () => void } | null>(null)

  const toast = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    dispatch({ type: 'set', patch: { toast: { text, kind, at: Date.now() } } })
    setTimeout(() => {
      if (ref.current.toast?.text === text) dispatch({ type: 'set', patch: { toast: null } })
    }, 4000)
  }, [])

  const say = useCallback((text: string) => {
    void speak(text, ref.current.settings)
  }, [])

  const reportState = useCallback(() => {
    const s = ref.current
    socket.current?.send({
      type: 'state',
      voice: s.walk || s.settings.autoSpeak,
      walk: s.walk,
      foreground: AppState.currentState === 'active',
      target: s.target,
    })
  }, [])

  // ---- applying updates without interrupting a conversation ---------------
  const maybeApplyUpdate = useCallback(async () => {
    const s = ref.current
    if (!s.updateReady || !s.settings.autoUpdate) return
    if (s.listening || isSpeaking()) {
      setTimeout(maybeApplyUpdate, 5000)
      return
    }
    if (s.walk) say('Updating the Switchboard app. Back in a second.')
    setTimeout(() => void applyUpdate().catch(() => {}), s.walk ? 2500 : 300)
  }, [say])

  const checkForUpdate = useCallback(
    async (manual = false) => {
      try {
        const ready = await fetchNewUpdate()
        if (ready) {
          dispatch({ type: 'set', patch: { updateReady: true } })
          setTimeout(() => void maybeApplyUpdate(), 0)
        } else if (manual) toast('The app is up to date.')
      } catch (err) {
        if (manual) toast(`Update check failed: ${(err as Error).message}`, 'error')
      }
    },
    [maybeApplyUpdate, toast],
  )

  // ---- voice ----------------------------------------------------------------
  const handleResult = useCallback(
    (r: any, said: string) => {
      const intent = r?.intent
      if (!intent || intent.kind === 'empty') {
        chime('error')
        say("Sorry, I didn't catch that.")
        return
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      if (intent.kind === 'switch') {
        dispatch({ type: 'set', patch: { target: intent.target } })
        chime('sent')
        say(`Now talking to ${intent.target}.`)
      } else if (intent.kind === 'permission') {
        chime('sent')
        say(intent.behavior === 'allow' ? 'Approved.' : 'Denied.')
      } else {
        chime('sent')
        if (ref.current.settings.readBack) say(`Sent to ${intent.to}: ${said}`)
        else if (intent.to !== ref.current.target) say(`Sent to ${intent.to}.`)
      }
      setTimeout(reportState, 0)
    },
    [say, reportState],
  )

  useSpeechRecognitionEvent('result', ev => {
    const c = capture.current
    if (!c || c.kind !== 'device') return
    const text = ev.results?.[0]?.transcript ?? ''
    c.text = text
    dispatch({ type: 'set', patch: { interim: text } })
  })
  useSpeechRecognitionEvent('end', () => capture.current?.kind === 'device' && capture.current.resolve?.())
  useSpeechRecognitionEvent('error', ev => {
    if (capture.current?.kind === 'device') {
      if (ev.error !== 'no-speech' && ev.error !== 'aborted') toast(`Speech recognition: ${ev.message || ev.error}`, 'error')
      capture.current.resolve?.()
    }
  })

  const startVoice = useCallback(async () => {
    if (capture.current) return
    stopSpeaking()
    const s = ref.current
    const useHub = s.settings.transcribe === 'hub' || (s.settings.transcribe === 'auto' && Boolean(s.info?.stt))
    const kind: 'hub' | 'device' = useHub ? 'hub' : 'device'
    const c: { kind: 'hub' | 'device'; cancelled: boolean; text: string; resolve?: () => void } = { kind, cancelled: false, text: '' }
    capture.current = c
    try {
      if (kind === 'hub') {
        const perm = await requestRecordingPermissionsAsync()
        if (!perm.granted) throw new Error('Microphone permission is off')
        await recorder.prepareToRecordAsync()
        recorder.record()
      } else {
        const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
        if (!perm.granted) throw new Error('Speech recognition permission is off')
        ExpoSpeechRecognitionModule.start({ lang: 'en-US', interimResults: true, continuous: true, addsPunctuation: true })
      }
    } catch (err) {
      capture.current = null
      chime('error')
      toast((err as Error).message, 'error')
      return
    }
    chime('start')
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    dispatch({ type: 'set', patch: { listening: true, interim: '' } })
  }, [recorder, toast])

  const finishVoice = useCallback(
    async (cancel: boolean) => {
      const c = capture.current
      if (!c) return
      c.cancelled = cancel
      const to = ref.current.target || ref.current.info?.orchestrator || 'boss'
      try {
        if (c.kind === 'hub') {
          await recorder.stop()
          dispatch({ type: 'set', patch: { listening: false } })
          if (cancel) return chime('stop')
          const uri = recorder.uri
          if (!uri) return chime('error')
          const form = new FormData()
          form.append('to', to)
          form.append('device', device.current)
          form.append('audio', { uri, name: 'voice.m4a', type: 'audio/m4a' } as unknown as Blob)
          handleResult(await api.call('POST', '/api/voice', form, 90000), '')
        } else {
          const ended = new Promise<void>(resolve => {
            c.resolve = resolve
            setTimeout(resolve, 2500)
          })
          if (cancel) ExpoSpeechRecognitionModule.abort()
          else ExpoSpeechRecognitionModule.stop()
          await ended
          dispatch({ type: 'set', patch: { listening: false } })
          if (cancel) return chime('stop')
          const text = c.text.trim()
          if (!text) return chime('error')
          handleResult(await api.call('POST', '/api/utterance', { text, to, device: device.current }), text)
        }
      } catch (err) {
        chime('error')
        toast((err as Error).message, 'error')
        if (ref.current.walk) say(`That did not send: ${(err as Error).message}`)
      } finally {
        capture.current = null
        dispatch({ type: 'set', patch: { listening: false, interim: '' } })
      }
    },
    [api, recorder, handleResult, toast, say],
  )

  const stopVoice = useCallback(() => void finishVoice(false), [finishVoice])
  const cancelVoice = useCallback(() => void finishVoice(true), [finishVoice])
  const toggleVoice = useCallback(() => (capture.current ? stopVoice() : void startVoice()), [startVoice, stopVoice])

  // ---- walk mode --------------------------------------------------------------
  const setWalk = useCallback(
    (on: boolean) => {
      dispatch({ type: 'set', patch: { walk: on } })
      const target = ref.current.target ?? 'boss'
      if (on) {
        void startWalkAudio({
          title: 'Switchboard',
          subtitle: `Talking to ${target}`,
          onMediaButton: () => ref.current.settings.mediaButton && toggleVoice(),
        }).catch(err => toast(`Walk mode audio: ${err.message}`, 'error'))
      } else void stopWalkAudio().catch(() => {})
      setTimeout(reportState, 0)
    },
    [reportState, toggleVoice, toast],
  )

  // ---- hub events ---------------------------------------------------------------
  const onEvent = useCallback(
    async (ev: any) => {
      const s = ref.current
      switch (ev.type) {
        case 'hello':
          dispatch({ type: 'hello', sessions: ev.sessions, pending: ev.pending_permissions, orchestrator: ev.orchestrator })
          break
        case 'message': {
          const m: Message = ev.message
          dispatch({ type: 'message', message: m })
          if (m.to_id === 'user' && m.from_id !== 'user' && m.kind !== 'permission') {
            const background = AppState.currentState !== 'active'
            if (s.walk || s.settings.autoSpeak || m.speak) {
              const who = m.from_id === 'system' || (m.from_id === s.target && !s.settings.announceSender) ? '' : `${m.from_id} says: `
              say(who + m.body)
            } else if (!background) chime('message')
            if (background && (!s.walk || s.settings.notifyInWalk)) {
              void localNotification(m.from_id === 'system' ? 'Switchboard' : m.from_id, m.body.slice(0, 240), { kind: 'message', session: m.from_id }, 'message')
            }
          }
          if (s.viewing && m.from_id === s.viewing && m.to_id === 'user') void api.call('POST', `/api/sessions/${s.viewing}/read`).catch(() => {})
          break
        }
        case 'message_update': {
          const patch: Partial<Message> = {}
          for (const k of ['delivered_at', 'seen_at', 'read_at'] as const) if (k in ev) patch[k] = ev[k]
          dispatch({ type: 'message_update', id: ev.id, patch })
          break
        }
        case 'session':
          dispatch({ type: 'session', session: ev.session })
          break
        case 'task':
          dispatch({ type: 'task', task: ev.task })
          break
        case 'task_deleted':
          dispatch({ type: 'task_deleted', id: ev.id })
          break
        case 'project':
          dispatch({ type: 'project', project: ev.project })
          break
        case 'permission': {
          const r: PermissionRequest = ev.request
          dispatch({ type: 'permission', request: r })
          if (r.status === 'pending') {
            if (s.walk || s.settings.autoSpeak) say(`${r.session} wants to use ${r.tool_name}: ${r.description}. Say approve or deny.`)
            if (AppState.currentState !== 'active') {
              void localNotification(`${r.session} needs approval`, `${r.tool_name}: ${r.description}`, { kind: 'permission', permission_id: r.id }, 'permission')
            }
          }
          break
        }
        case 'ptt':
          if (ev.target) dispatch({ type: 'set', patch: { target: ev.target } })
          if (ev.action === 'start') void startVoice()
          else if (ev.action === 'stop') stopVoice()
          else if (ev.action === 'cancel') {
            cancelVoice()
            stopSpeaking()
          } else toggleVoice()
          break
        case 'device_command': {
          try {
            const result = await runAction(ev.action, ev.params ?? {}, s.settings)
            socket.current?.send({ type: 'device_result', id: ev.id, ok: true, result })
          } catch (err) {
            socket.current?.send({ type: 'device_result', id: ev.id, ok: false, error: (err as Error).message })
          }
          break
        }
        case 'app_update':
          if (s.settings.autoUpdate) void checkForUpdate()
          break
      }
    },
    [api, say, startVoice, stopVoice, cancelVoice, toggleVoice, checkForUpdate],
  )

  // ---- start up -----------------------------------------------------------------
  useEffect(() => {
    let disposed = false
    ;(async () => {
      const settings = await loadSettings()
      dispatch({ type: 'set', patch: { settings } })
      device.current = await deviceId()
      await setupNotifications().catch(() => {})
      const name = `${Device.modelName ?? 'Phone'} (${Platform.OS})`
      const update = currentUpdate()
      const token = await pushToken()
      await api
        .call('POST', '/api/devices', {
          id: device.current,
          name,
          platform: Platform.OS,
          push_token: token,
          app_version: Constants.expoConfig?.version,
          runtime_version: update.runtimeVersion,
          update_id: update.updateId,
          capabilities: CAPABILITIES,
        })
        .catch(() => {})
      api.call('GET', '/api/info').then(info => dispatch({ type: 'set', patch: { info } })).catch(() => {})
      api.call('GET', '/api/projects').then(projects => dispatch({ type: 'set', patch: { projects } })).catch(() => {})
      if (disposed) return
      socket.current = connectSocket({
        pairing,
        device: device.current,
        platform: Platform.OS,
        name,
        onEvent: ev => void onEvent(ev),
        onStatus: conn => {
          dispatch({ type: 'set', patch: { conn } })
          if (conn === 'open') setTimeout(reportState, 50)
        },
      })
      if (settings.autoUpdate) void checkForUpdate()
    })()
    const sub = AppState.addEventListener('change', st => {
      if (st === 'active') {
        socket.current?.reconnect()
        if (ref.current.settings.autoUpdate) void checkForUpdate()
      }
      reportState()
    })
    const notifSub = Notifications.addNotificationResponseReceivedListener(r => void onNotificationResponse(r))
    return () => {
      disposed = true
      sub.remove()
      notifSub.remove()
      socket.current?.close()
    }
  }, [])

  const onNotificationResponse = async (r: Notifications.NotificationResponse) => {
    const data = r.notification.request.content.data as Record<string, any>
    try {
      if (r.actionIdentifier === 'reply' && r.userText && data?.session) {
        await api.call('POST', '/api/messages', { to: data.session === 'system' ? ref.current.target : data.session, body: r.userText, meta: { via: 'notification' } })
      } else if ((r.actionIdentifier === 'allow' || r.actionIdentifier === 'deny') && data?.permission_id) {
        await api.call('POST', `/api/permissions/${data.permission_id}`, { behavior: r.actionIdentifier, by: 'notification' })
      }
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  useEffect(() => {
    reportState()
    if (state.walk) updateWalkAudio('Switchboard', `Talking to ${state.target ?? 'boss'}`)
  }, [state.walk, state.target, state.settings.autoSpeak])

  const store: Store = {
    state,
    api,
    pairing,
    dispatch,
    toast,
    say,
    startVoice,
    stopVoice,
    cancelVoice,
    toggleVoice,
    setWalk,
    setTarget: name => dispatch({ type: 'set', patch: { target: name } }),
    updateSettings: patch => {
      const settings = { ...ref.current.settings, ...patch }
      dispatch({ type: 'set', patch: { settings } })
      void saveSettings(settings)
    },
    async loadThread(name, before) {
      const q = new URLSearchParams({ limit: '80' })
      if (name) q.set('with', name)
      if (before) q.set('before', String(before))
      const messages = await api.call<Message[]>('GET', `/api/messages?${q}`)
      dispatch({ type: 'messages', name, messages })
      return messages
    },
    async send(to, body) {
      const m = await api.call<Message>('POST', '/api/messages', { to, body, meta: { via: 'app' } })
      dispatch({ type: 'message', message: m })
    },
    markRead(name) {
      dispatch({ type: 'read', name })
      void api.call('POST', `/api/sessions/${name}/read`).catch(() => {})
    },
    async decide(id, behavior) {
      try {
        await api.call('POST', `/api/permissions/${id}`, { behavior, by: 'app' })
      } catch (err) {
        toast((err as Error).message, 'error')
      }
    },
    async loadTasks() {
      const [tasks, projects] = await Promise.all([
        api.call<Task[]>('GET', '/api/tasks?closed=1&limit=2000'),
        api.call<Project[]>('GET', '/api/projects'),
      ])
      dispatch({ type: 'set', patch: { tasks, projects } })
    },
    async unpair() {
      socket.current?.close()
      await stopWalkAudio().catch(() => {})
      await savePairing(null)
      onUnpair()
    },
    checkForUpdate,
  }
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}
