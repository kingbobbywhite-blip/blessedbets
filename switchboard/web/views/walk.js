import { html } from '../lib/html.js'
import { useEffect, useRef } from 'preact/hooks'
import { useStore } from '../lib/store.js'
import { stopSpeaking, unlockSpeech } from '../lib/voice.js'
import { Markdown, StatusDot, clock } from '../lib/ui.js'

/** Hold to talk (or tap to start and tap to send, in toggle mode). */
export function MicButton({ small, target }) {
  const { state, actions } = useStore()
  const holding = useRef(false)
  const toggle = state.voice.pttMode === 'toggle'
  const down = e => {
    e.preventDefault()
    if (target && state.target !== target) actions.dispatch({ type: 'set', patch: { target } })
    if (toggle) return actions.toggleVoice()
    holding.current = true
    actions.startVoice()
  }
  const up = e => {
    e.preventDefault()
    if (toggle || !holding.current) return
    holding.current = false
    actions.stopVoice()
  }
  return html`<button
    type="button"
    class=${'mic' + (small ? ' mic-small' : '') + (state.listening ? ' live' : '')}
    onPointerDown=${down}
    onPointerUp=${up}
    onPointerLeave=${e => holding.current && up(e)}
    onContextMenu=${e => e.preventDefault()}
    aria-label=${toggle ? 'Tap to talk' : 'Hold to talk'}
  >
    ${state.listening ? '●' : '🎙'}
  </button>`
}

export function Walk() {
  const { state, actions } = useStore()
  useEffect(() => {
    actions.setWalk(true)
    actions.loadThread(null).catch(() => {})
    return () => actions.setWalk(false)
  }, [])
  useEffect(() => {
    // Space bar works as a push-to-talk key on a computer.
    const down = e => {
      if (e.code === 'Space' && !e.repeat && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
        e.preventDefault()
        actions.startVoice()
      }
    }
    const up = e => e.code === 'Space' && actions.stopVoice()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])
  const sessions = Object.values(state.sessions)
  const target = state.target || state.orchestrator
  const recent = (state.feed.length ? state.feed : []).filter(m => m.to_id === 'user' || m.from_id === 'user').slice(-4)
  return html`<section class="walk">
    <div class="walk-targets">
      ${sessions.map(
        s => html`<button class=${'chip' + (s.name === target ? ' on' : '')} onClick=${() => actions.dispatch({ type: 'set', patch: { target: s.name } })}>
          <${StatusDot} session=${s} /> ${s.name}
        </button>`,
      )}
    </div>
    <div class="walk-center">
      <div class="walk-to">Talking to <strong>${target}</strong></div>
      <${MicButton} />
      <div class="walk-hint">
        ${state.listening
          ? state.interim || 'Listening…'
          : state.voice.pttMode === 'toggle'
            ? 'Tap to talk, tap again to send'
            : 'Hold to talk, let go to send'}
      </div>
      <div class="row-inline center">
        <button class="btn" onClick=${() => { stopSpeaking(); actions.cancelVoice() }}>Stop talking</button>
        <button class="btn" onClick=${() => unlockSpeech()}>Test sound</button>
      </div>
    </div>
    <ul class="walk-feed">
      ${recent.map(
        m => html`<li class=${m.from_id === 'user' ? 'mine' : ''}>
          <span class="muted small">${m.from_id === 'user' ? `You → ${m.to_id}` : m.from_id} · ${clock(m.created_at)}</span>
          <${Markdown} text=${m.body} />
        </li>`,
      )}
    </ul>
    <p class="muted small center">Replies are read aloud here. A Flic button press toggles talking (Settings → Flic). Keep this screen open; the phone app keeps working in your pocket.</p>
  </section>`
}
