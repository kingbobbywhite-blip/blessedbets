// App state: one object, updated by hub events and by what you do.
import { createContext } from 'preact'
import { useContext, useEffect, useReducer, useRef, useCallback } from 'preact/hooks'
import { api, connectSocket, deviceId, getToken } from './api.js'
import { chime, loadVoiceSettings, saveVoiceSettings, speak, speakable, stopSpeaking, startListening, keepAwake } from './voice.js'
import { runWebAction, webCapabilities } from './actions.js'

export const Store = createContext(null)
export const useStore = () => useContext(Store)

const initial = () => ({
  conn: 'connecting',
  info: null,
  orchestrator: 'boss',
  sessions: {},
  threads: {}, // session name -> messages, oldest first
  feed: [], // every message, newest last
  pending: [],
  projects: [],
  tasks: null,
  unread: {},
  voice: loadVoiceSettings(),
  target: null,
  walk: false,
  listening: false,
  interim: '',
  busyVoice: false,
  toast: null,
  viewing: null, // session whose chat is open
})

function upsertMessage(list, m) {
  const i = list.findIndex(x => x.id === m.id)
  if (i >= 0) {
    const copy = list.slice()
    copy[i] = { ...copy[i], ...m }
    return copy
  }
  if (list.length && list[list.length - 1].id > m.id) return [...list, m].sort((a, b) => a.id - b.id)
  return [...list, m]
}

/** Which session threads a message belongs to: the session(s) it is from or to. */
function threadsOf(m) {
  const out = []
  for (const id of [m.from_id, m.to_id]) if (id !== 'user' && id !== 'system') out.push(id)
  if (m.from_id === 'system' && m.meta?.session) out.push(m.meta.session)
  return [...new Set(out)]
}

function reducer(state, action) {
  switch (action.type) {
    case 'set':
      return { ...state, ...action.patch }
    case 'hello': {
      const sessions = {}
      for (const s of action.sessions) sessions[s.name] = s
      const unread = {}
      for (const s of action.sessions) if (s.unread) unread[s.name] = s.unread
      return {
        ...state,
        sessions,
        pending: action.pending_permissions,
        orchestrator: action.orchestrator,
        target: state.target || action.orchestrator,
        unread: { ...unread, ...Object.fromEntries(Object.entries(state.unread).filter(([k]) => k === state.viewing)) },
      }
    }
    case 'session':
      return { ...state, sessions: { ...state.sessions, [action.session.name]: action.session } }
    case 'session_removed': {
      const sessions = { ...state.sessions }
      delete sessions[action.name]
      return { ...state, sessions }
    }
    case 'messages': {
      // a page of history for one thread (or the feed when name is null)
      if (!action.name) {
        let feed = state.feed
        for (const m of action.messages) feed = upsertMessage(feed, m)
        return { ...state, feed }
      }
      let list = state.threads[action.name] || []
      for (const m of action.messages) list = upsertMessage(list, m)
      return { ...state, threads: { ...state.threads, [action.name]: list } }
    }
    case 'message': {
      const m = action.message
      const threads = { ...state.threads }
      for (const name of threadsOf(m)) threads[name] = upsertMessage(threads[name] || [], m)
      const unread = { ...state.unread }
      if (m.to_id === 'user' && m.from_id !== 'system' && state.viewing !== m.from_id) unread[m.from_id] = (unread[m.from_id] || 0) + 1
      return { ...state, threads, feed: upsertMessage(state.feed, m).slice(-500), unread }
    }
    case 'message_update': {
      const patch = m => (m.id === action.id ? { ...m, ...action.patch } : m)
      const threads = {}
      for (const [k, v] of Object.entries(state.threads)) threads[k] = v.some(m => m.id === action.id) ? v.map(patch) : v
      return { ...state, threads, feed: state.feed.map(patch) }
    }
    case 'permission': {
      const others = state.pending.filter(p => p.id !== action.request.id)
      return { ...state, pending: action.request.status === 'pending' ? [...others, action.request] : others }
    }
    case 'task': {
      if (!state.tasks) return state
      const others = state.tasks.filter(t => t.id !== action.task.id)
      return { ...state, tasks: [...others, action.task] }
    }
    case 'task_deleted':
      return state.tasks ? { ...state, tasks: state.tasks.filter(t => t.id !== action.id) } : state
    case 'project': {
      const others = state.projects.filter(p => p.slug !== action.project.slug)
      return { ...state, projects: [...others, action.project].sort((a, b) => (a.slug === 'inbox' ? -1 : b.slug === 'inbox' ? 1 : a.name.localeCompare(b.name))) }
    }
    case 'read':
      return { ...state, unread: { ...state.unread, [action.name]: 0 } }
    case 'voice':
      saveVoiceSettings({ ...state.voice, ...action.patch })
      return { ...state, voice: { ...state.voice, ...action.patch } }
  }
  return state
}

export function useAppStore() {
  const [state, dispatch] = useReducer(reducer, null, initial)
  const ref = useRef(state)
  ref.current = state
  const socket = useRef(null)
  const capture = useRef(null)
  const device = useRef(deviceId())

  const toast = useCallback((text, kind = 'info') => {
    dispatch({ type: 'set', patch: { toast: { text, kind, at: Date.now() } } })
    setTimeout(() => {
      if (ref.current.toast?.text === text) dispatch({ type: 'set', patch: { toast: null } })
    }, 4500)
  }, [])

  const reportState = useCallback(() => {
    const s = ref.current
    socket.current?.send({
      type: 'state',
      voice: s.walk || s.voice.autoSpeak,
      walk: s.walk,
      foreground: document.visibilityState === 'visible',
      target: s.target,
    })
  }, [])

  // ---- voice --------------------------------------------------------------
  const say = useCallback((text, opts = {}) => {
    const s = ref.current
    if (!text) return
    dispatch({ type: 'set', patch: { busyVoice: true } })
    speak(speakable(text), s.voice).then(() => dispatch({ type: 'set', patch: { busyVoice: false } }))
  }, [])

  const handleUtteranceResult = useCallback(
    r => {
      const intent = r?.intent
      if (!intent || intent.kind === 'empty') {
        chime('error')
        say("Sorry, I didn't catch that.")
        return
      }
      if (intent.kind === 'switch') {
        dispatch({ type: 'set', patch: { target: intent.target } })
        chime('sent')
        say(`Now talking to ${intent.target}.`)
      } else if (intent.kind === 'permission') {
        chime('sent')
        say(intent.behavior === 'allow' ? 'Approved.' : 'Denied.')
      } else {
        chime('sent')
        if (ref.current.voice.readBack) say(`Sent to ${intent.to}: ${r.text}`)
        else if (intent.to !== ref.current.target) say(`Sent to ${intent.to}.`)
      }
      setTimeout(reportState, 0)
    },
    [say, reportState],
  )

  const startVoice = useCallback(async () => {
    if (capture.current) return
    stopSpeaking()
    const s = ref.current
    const hubStt = Boolean(s.info?.stt)
    const mode = s.voice.transcribe === 'device' ? 'device' : s.voice.transcribe === 'hub' ? 'hub' : hubStt ? 'hub' : 'device'
    try {
      capture.current = startListening({ mode, onInterim: text => dispatch({ type: 'set', patch: { interim: text } }) })
    } catch (err) {
      chime('error')
      toast(err.message, 'error')
      return
    }
    chime('start')
    if (navigator.vibrate) navigator.vibrate(30)
    dispatch({ type: 'set', patch: { listening: true, interim: '' } })
    const c = capture.current
    try {
      const r = await c.done
      dispatch({ type: 'set', patch: { listening: false } })
      if (r.cancelled) return chime('stop')
      const to = ref.current.target || ref.current.orchestrator
      if (r.blob) {
        if (r.blob.size < 1200) return chime('error')
        const form = new FormData()
        form.append('to', to)
        form.append('device', device.current)
        form.append('audio', r.blob, `voice.${r.blob.type.includes('mp4') ? 'm4a' : 'webm'}`)
        handleUtteranceResult(await api('POST', '/api/voice', form))
      } else {
        if (!r.text) return chime('error')
        handleUtteranceResult(await api('POST', '/api/utterance', { text: r.text, to, device: device.current }))
      }
    } catch (err) {
      chime('error')
      toast(err.message, 'error')
      dispatch({ type: 'set', patch: { listening: false } })
    } finally {
      capture.current = null
      dispatch({ type: 'set', patch: { interim: '' } })
    }
  }, [toast, handleUtteranceResult])

  const stopVoice = useCallback(() => capture.current?.stop(), [])
  const cancelVoice = useCallback(() => capture.current?.cancel(), [])
  const toggleVoice = useCallback(() => (capture.current ? capture.current.stop() : startVoice()), [startVoice])

  // ---- hub events -----------------------------------------------------------
  const onEvent = useCallback(
    async ev => {
      const s = ref.current
      switch (ev.type) {
        case 'hello':
          dispatch(ev)
          break
        case 'message': {
          dispatch(ev)
          const m = ev.message
          if (m.to_id === 'user' && m.from_id !== 'user') {
            const shouldSpeak = s.walk || s.voice.autoSpeak || m.speak
            if (shouldSpeak && m.kind !== 'permission') {
              const who = m.from_id === 'system' ? '' : m.from_id === s.target && !s.voice.announceSender ? '' : `${m.from_id} says: `
              say(who + m.body)
            } else if (document.visibilityState === 'visible') chime('message')
          }
          if (s.viewing && (m.from_id === s.viewing) && m.to_id === 'user') api('POST', `/api/sessions/${s.viewing}/read`).catch(() => {})
          break
        }
        case 'message_update':
          dispatch({ type: 'message_update', id: ev.id, patch: Object.fromEntries(Object.entries(ev).filter(([k]) => k.endsWith('_at'))) })
          break
        case 'session':
        case 'session_removed':
        case 'task':
        case 'task_deleted':
        case 'project':
          dispatch(ev)
          break
        case 'permission':
          dispatch(ev)
          if (ev.request.status === 'pending' && (s.walk || s.voice.autoSpeak)) {
            say(`${ev.request.session} wants to use ${ev.request.tool_name}: ${ev.request.description}. Say approve or deny.`)
          }
          break
        case 'ptt':
          if (ev.target) dispatch({ type: 'set', patch: { target: ev.target } })
          if (ev.action === 'start') startVoice()
          else if (ev.action === 'stop') stopVoice()
          else if (ev.action === 'cancel') {
            cancelVoice()
            stopSpeaking()
          } else toggleVoice()
          break
        case 'device_command': {
          try {
            const result = await runWebAction(ev.action, ev.params || {}, { say, settings: s.voice })
            socket.current?.send({ type: 'device_result', id: ev.id, ok: true, result })
          } catch (err) {
            socket.current?.send({ type: 'device_result', id: ev.id, ok: false, error: err.message })
          }
          break
        }
      }
    },
    [say, startVoice, stopVoice, cancelVoice, toggleVoice],
  )

  useEffect(() => {
    if (!getToken()) {
      dispatch({ type: 'set', patch: { conn: 'unauthorized' } })
      return
    }
    api('GET', '/api/info')
      .then(info => dispatch({ type: 'set', patch: { info } }))
      .catch(err => err.status === 401 && dispatch({ type: 'set', patch: { conn: 'unauthorized' } }))
    api('GET', '/api/projects').then(projects => dispatch({ type: 'set', patch: { projects } })).catch(() => {})
    const name = `Browser (${navigator.platform || 'web'})`
    api('POST', '/api/devices', { id: device.current, name, platform: 'web', capabilities: webCapabilities() }).catch(() => {})
    socket.current = connectSocket({
      device: device.current,
      name,
      onEvent,
      onStatus: conn => {
        dispatch({ type: 'set', patch: { conn } })
        if (conn === 'open') setTimeout(reportState, 50)
      },
    })
    const onVis = () => reportState()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      socket.current?.close()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  useEffect(() => {
    reportState()
    keepAwake(state.walk)
  }, [state.walk, state.voice.autoSpeak, state.target])

  const actions = {
    dispatch,
    toast,
    say,
    startVoice,
    stopVoice,
    cancelVoice,
    toggleVoice,
    async loadThread(name, before) {
      const q = new URLSearchParams({ limit: '80' })
      if (name) q.set('with', name)
      if (before) q.set('before', String(before))
      const messages = await api('GET', `/api/messages?${q}`)
      dispatch({ type: 'messages', name, messages })
      return messages
    },
    async send(to, body) {
      const m = await api('POST', '/api/messages', { to, body, meta: { via: 'web' } })
      dispatch({ type: 'message', message: m })
      return m
    },
    async markRead(name) {
      dispatch({ type: 'read', name })
      await api('POST', `/api/sessions/${name}/read`).catch(() => {})
    },
    async decide(id, behavior) {
      try {
        await api('POST', `/api/permissions/${id}`, { behavior, by: 'web' })
      } catch (err) {
        toast(err.message, 'error')
        dispatch({ type: 'permission', request: { id, status: 'expired' } })
      }
    },
    async loadTasks() {
      const [tasks, projects] = await Promise.all([api('GET', '/api/tasks?closed=1&limit=2000'), api('GET', '/api/projects')])
      dispatch({ type: 'set', patch: { tasks, projects } })
    },
    setWalk(walk) {
      dispatch({ type: 'set', patch: { walk } })
    },
  }
  return { state, actions }
}
