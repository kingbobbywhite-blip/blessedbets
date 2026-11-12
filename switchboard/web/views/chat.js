import { html } from '../lib/html.js'
import { useEffect, useRef, useState, useLayoutEffect } from 'preact/hooks'
import { useStore } from '../lib/store.js'
import { api } from '../lib/api.js'
import { Markdown, Modal, StatusDot, statusText, clock } from '../lib/ui.js'
import { stopSpeaking } from '../lib/voice.js'
import { MicButton } from './walk.js'

export function Chat({ name }) {
  const { state, actions } = useStore()
  const session = name ? state.sessions[name] : null
  const messages = (name ? state.threads[name] : state.feed) || []
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [screenOpen, setScreenOpen] = useState(false)
  const [menu, setMenu] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const list = useRef(null)
  const stick = useRef(true)

  useEffect(() => {
    actions.dispatch({ type: 'set', patch: { viewing: name || null } })
    actions.loadThread(name || null).catch(err => actions.toast(err.message, 'error'))
    if (name) actions.markRead(name)
    return () => actions.dispatch({ type: 'set', patch: { viewing: null } })
  }, [name])

  useLayoutEffect(() => {
    const el = list.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages.length, name])

  const onScroll = async e => {
    const el = e.currentTarget
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 40 && messages.length && !loadingOlder) {
      setLoadingOlder(true)
      const before = el.scrollHeight
      const older = await actions.loadThread(name || null, messages[0].id).catch(() => [])
      requestAnimationFrame(() => {
        if (older.length) el.scrollTop = el.scrollHeight - before
        setLoadingOlder(false)
      })
    }
  }

  const send = async e => {
    e?.preventDefault()
    const body = text.trim()
    if (!body || !name) return
    setSending(true)
    try {
      await actions.send(name, body)
      setText('')
      stick.current = true
    } catch (err) {
      actions.toast(err.message, 'error')
    } finally {
      setSending(false)
    }
  }

  const control = async (what, body) => {
    setMenu(false)
    try {
      const r = await api('POST', `/api/sessions/${name}/${what}`, body || {})
      if (r?.note) actions.toast(`${name}: ${r.note}`)
      else actions.toast(`${what} sent to ${name}`)
    } catch (err) {
      actions.toast(err.message, 'error')
    }
  }

  return html`<section class="chat">
    <header class="chat-head">
      <a class="icon-btn back" href="#/" aria-label="Back">‹</a>
      ${session
        ? html`<div class="chat-title">
            <div><${StatusDot} session=${session} /> <strong>${session.name}</strong>${session.role === 'orchestrator' ? html` <span class="pill">orchestrator</span>` : ''}</div>
            <div class="muted small">${statusText(session)}${session.status_text ? ` · ${session.status_text}` : ''}${session.cwd ? ` · ${session.cwd}` : ''}</div>
          </div>`
        : html`<div class="chat-title"><strong>Everything</strong><div class="muted small">Every message, every session</div></div>`}
      ${session &&
      html`<div class="chat-actions">
        <button class="btn btn-small" onClick=${() => setScreenOpen(true)} disabled=${!session.managed}>Screen</button>
        <button class="icon-btn" onClick=${() => setMenu(!menu)} aria-label="More">⋯</button>
        ${menu &&
        html`<div class="menu" onMouseLeave=${() => setMenu(false)}>
          <button onClick=${() => control('interrupt')}>Interrupt (Esc)</button>
          <button onClick=${() => control('restart')}>Restart, same conversation</button>
          <button onClick=${() => control('restart', { fresh: true })}>Restart fresh</button>
          <button onClick=${() => actions.dispatch({ type: 'set', patch: { target: name } }) || actions.toast(`Voice now goes to ${name}`)}>Talk to this by voice</button>
          <button class="danger" onClick=${() => confirm(`Stop ${name}?`) && control('stop')}>Stop session</button>
        </div>`}
      </div>`}
    </header>
    <div class="messages" ref=${list} onScroll=${onScroll}>
      ${loadingOlder && html`<div class="muted center small">Loading…</div>`}
      ${messages.length === 0 && html`<div class="empty"><p class="muted">No messages yet.</p></div>`}
      ${messages.map(m => html`<${Bubble} key=${m.id} m=${m} name=${name} />`)}
    </div>
    ${name &&
    html`<form class="composer" onSubmit=${send}>
      <textarea
        rows="1"
        placeholder=${`Message ${name}…`}
        value=${text}
        onInput=${e => {
          setText(e.target.value)
          e.target.style.height = 'auto'
          e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px'
        }}
        onKeyDown=${e => {
          if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) send(e)
        }}
      ></textarea>
      ${text.trim()
        ? html`<button class="btn btn-primary send" disabled=${sending} aria-label="Send">➤</button>`
        : html`<${MicButton} small target=${name} />`}
    </form>`}
    ${screenOpen && html`<${ScreenPeek} name=${name} onClose=${() => setScreenOpen(false)} />`}
  </section>`
}

function Bubble({ m, name }) {
  const { actions } = useStore()
  const mine = m.from_id === 'user'
  const system = m.from_id === 'system'
  const between = !mine && !system && m.to_id !== 'user'
  const cls = system ? 'bubble system' : mine ? 'bubble mine' : between ? 'bubble between' : 'bubble theirs'
  const label = mine ? (name ? '' : `You → ${m.to_id}`) : system ? '' : between || !name ? `${m.from_id} → ${m.to_id === 'user' ? 'you' : m.to_id}` : ''
  return html`<div class=${cls}>
    ${label && html`<div class="bubble-label">${label}</div>`}
    <${Markdown} text=${m.body} />
    <div class="bubble-meta">
      ${m.kind === 'voice' && html`<span title="spoken">🎙</span>`}
      <span>${clock(m.created_at)}</span>
      ${mine && !system && html`<span class="ticks" title=${m.seen_at ? 'Claude has it in context' : m.delivered_at ? 'Pushed into the session' : 'Waiting for the session to connect'}>${m.seen_at ? '✓✓ seen' : m.delivered_at ? '✓✓' : '✓'}</span>`}
      ${!mine && html`<button class="link-btn" onClick=${() => { stopSpeaking(); actions.say(m.body) }} aria-label="Read aloud">🔊</button>`}
    </div>
  </div>`
}

const KEYS = ['Escape', 'Enter', 'Up', 'Down', 'Tab', '1', '2', '3', 'y', 'n', 'C-c']

function ScreenPeek({ name, onClose }) {
  const { actions } = useStore()
  const [screen, setScreen] = useState('')
  const [text, setText] = useState('')
  const [auto, setAuto] = useState(true)
  const load = () =>
    api('GET', `/api/sessions/${name}/screen?lines=60`)
      .then(r => setScreen(r.screen))
      .catch(err => setScreen(`(${err.message})`))
  useEffect(() => {
    load()
    if (!auto) return
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [name, auto])
  const key = async k => {
    await api('POST', `/api/sessions/${name}/keys`, { keys: [k] }).catch(err => actions.toast(err.message, 'error'))
    setTimeout(load, 300)
  }
  const type = async e => {
    e.preventDefault()
    await api('POST', `/api/sessions/${name}/keys`, { text, enter: true }).catch(err => actions.toast(err.message, 'error'))
    setText('')
    setTimeout(load, 400)
  }
  return html`<${Modal} title=${`${name} — terminal`} onClose=${onClose} wide>
    <pre class="screen tall">${screen}</pre>
    <div class="keys">
      ${KEYS.map(k => html`<button class="btn btn-small" onClick=${() => key(k)}>${k === 'Escape' ? 'Esc' : k}</button>`)}
      <label class="small"><input type="checkbox" checked=${auto} onChange=${e => setAuto(e.target.checked)} /> live</label>
    </div>
    <form class="row" onSubmit=${type}>
      <input placeholder="Type into the terminal and press Enter" value=${text} onInput=${e => setText(e.target.value)} />
      <button class="btn">Send</button>
    </form>
    <p class="muted small">This is the session's real terminal. Use it to answer prompts the session can't relay (startup questions, menus).</p>
  <//>`
}
