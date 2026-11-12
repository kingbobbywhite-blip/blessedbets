import { html } from '../lib/html.js'
import { useState } from 'preact/hooks'
import { useStore } from '../lib/store.js'
import { api } from '../lib/api.js'
import { Modal, StatusDot, liveStatus, statusText, timeAgo } from '../lib/ui.js'

export function SessionList({ compact }) {
  const { state } = useStore()
  const [creating, setCreating] = useState(false)
  const sessions = Object.values(state.sessions).sort((a, b) => {
    if (a.role !== b.role) return a.role === 'orchestrator' ? -1 : 1
    const la = a.last_message?.id ?? 0
    const lb = b.last_message?.id ?? 0
    return lb - la || a.name.localeCompare(b.name)
  })
  return html`<section class=${'sessions' + (compact ? ' compact' : '')}>
    <header class="section-head">
      <h1>Sessions</h1>
      <button class="btn btn-primary" onClick=${() => setCreating(true)}>+ New</button>
    </header>
    ${sessions.length === 0 &&
    html`<div class="empty">
      <p>No sessions yet.</p>
      <p class="muted">Start the orchestrator with <code>switchboard up</code>, or press <strong>New</strong>.</p>
    </div>`}
    <ul class="session-list">
      ${sessions.map(s => html`<${SessionRow} key=${s.name} s=${s} unread=${state.unread[s.name] || 0} active=${state.viewing === s.name} />`)}
    </ul>
    <a class="feed-link" href="#/all">Everything, all sessions →</a>
    ${creating && html`<${NewSession} onClose=${() => setCreating(false)} />`}
  </section>`
}

function SessionRow({ s, unread, active }) {
  const st = liveStatus(s)
  const last = s.last_message
  return html`<li>
    <a class=${'session-row' + (active ? ' active' : '')} href=${`#/s/${s.name}`}>
      <${StatusDot} session=${s} />
      <div class="session-main">
        <div class="session-top">
          <span class="session-name">${s.role === 'orchestrator' ? '★ ' : ''}${s.name}</span>
          <span class="muted small">${last ? timeAgo(last.created_at) : ''}</span>
        </div>
        <div class="session-sub">
          <span class=${`status-label st-${st}`}>${statusText(s)}</span>
          ${s.status_text && html`<span class="muted"> · ${s.status_text}</span>`}
        </div>
        ${last && html`<div class="session-last muted">${last.from_id === 'user' ? 'You: ' : last.from_id !== s.name ? `${last.from_id}: ` : ''}${last.body}</div>`}
      </div>
      ${unread > 0 && html`<span class="badge">${unread}</span>`}
    </a>
  </li>`
}

export function NewSession({ onClose, preset }) {
  const { state, actions } = useStore()
  const [form, setForm] = useState({
    name: preset?.name || '',
    cwd: preset?.cwd || '',
    description: '',
    prompt: '',
    model: '',
    permission_mode: '',
    role: 'worker',
  })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const set = k => e => setForm({ ...form, [k]: e.target.value })
  const submit = async e => {
    e.preventDefault()
    setBusy(true)
    setResult(null)
    try {
      const r = await api('POST', '/api/sessions', { ...form, name: form.name.trim().toLowerCase() })
      setResult(r)
      if (r.ready) {
        actions.toast(`${r.session.name} is ready`)
        location.hash = `#/s/${r.session.name}`
        onClose()
      }
    } catch (err) {
      setResult({ error: err.message })
    } finally {
      setBusy(false)
    }
  }
  return html`<${Modal} title="Start a Claude Code session" onClose=${onClose}>
    <form class="form" onSubmit=${submit}>
      <label>Name <input required pattern="[a-z0-9][a-z0-9_-]{0,39}" placeholder="api" value=${form.name} onInput=${set('name')} autocapitalize="none" /></label>
      <label>Folder <input placeholder="~/code/my-project" value=${form.cwd} onInput=${set('cwd')} autocapitalize="none" /></label>
      <label>What it is for <input placeholder="Backend work on the odds feed" value=${form.description} onInput=${set('description')} /></label>
      <label>First message <textarea rows="3" placeholder="Optional: what to start on" value=${form.prompt} onInput=${set('prompt')}></textarea></label>
      <div class="row">
        <label>Model
          <select value=${form.model} onChange=${set('model')}>
            <option value="">Default</option><option value="opus">Opus</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option><option value="fable">Fable</option>
          </select>
        </label>
        <label>Permissions
          <select value=${form.permission_mode} onChange=${set('permission_mode')}>
            <option value="">Ask (relayed to your phone)</option>
            <option value="acceptEdits">Accept edits</option>
            <option value="auto">Auto</option>
            <option value="plan">Plan</option>
          </select>
        </label>
        <label>Role
          <select value=${form.role} onChange=${set('role')}>
            <option value="worker">Worker</option><option value="orchestrator">Orchestrator</option>
          </select>
        </label>
      </div>
      ${result?.error && html`<p class="error">${result.error}</p>`}
      ${result && !result.error && !result.ready && html`<div class="notice"><p>${result.note}</p>${result.screen && html`<pre class="screen">${result.screen}</pre>`}</div>`}
      <div class="form-actions">
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        <button class="btn btn-primary" disabled=${busy}>${busy ? 'Starting…' : 'Start'}</button>
      </div>
      <p class="muted small">Runs <code>claude</code> in tmux on ${state.info?.base_url || 'the hub'} with the Switchboard channel connected.</p>
    </form>
  <//>`
}
