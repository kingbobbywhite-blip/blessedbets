import { html } from '../lib/html.js'
import { useState } from 'preact/hooks'
import { useStore } from '../lib/store.js'
import { api } from '../lib/api.js'
import { Snippet, clock } from '../lib/ui.js'

export function Search() {
  const { actions } = useStore()
  const [q, setQ] = useState('')
  const [sources, setSources] = useState({ message: true, transcript: true, task: true })
  const [hits, setHits] = useState(null)
  const [busy, setBusy] = useState(false)
  const run = async e => {
    e?.preventDefault()
    if (!q.trim()) return
    setBusy(true)
    try {
      const src = Object.entries(sources).filter(([, v]) => v).map(([k]) => k).join(',')
      setHits(await api('GET', `/api/search?${new URLSearchParams({ q, limit: '60', sources: src })}`))
    } catch (err) {
      actions.toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const open = h => {
    if (h.source === 'task') location.hash = '#/tasks'
    else if (h.session) location.hash = `#/s/${h.session}`
  }
  return html`<section class="search">
    <header class="section-head"><h1>Search history</h1></header>
    <form class="search-bar" onSubmit=${run}>
      <input type="search" autofocus placeholder='What did we decide about the odds cache? "exact phrase" -excluded' value=${q} onInput=${e => setQ(e.target.value)} />
      <button class="btn btn-primary" disabled=${busy}>${busy ? '…' : 'Search'}</button>
    </form>
    <div class="row-inline small">
      ${['message', 'transcript', 'task'].map(
        s => html`<label><input type="checkbox" checked=${sources[s]} onChange=${e => setSources({ ...sources, [s]: e.target.checked })} /> ${s === 'message' ? 'messages' : s === 'transcript' ? 'session transcripts' : 'tasks'}</label>`,
      )}
    </div>
    ${hits && hits.length === 0 && html`<p class="muted">Nothing found.</p>`}
    <ul class="hits">
      ${(hits || []).map(
        h => html`<li><button class="hit" onClick=${() => open(h)}>
          <div class="hit-head">
            <span class="pill">${h.source}</span>
            <strong>${h.source === 'task' ? `#${h.ref} ${h.title}` : `${h.from_id} → ${h.to_id}`}</strong>
            <span class="muted small">${clock(h.created_at)}</span>
          </div>
          <${Snippet} text=${h.snippet} />
        </button></li>`,
      )}
    </ul>
    <p class="muted small">Every message between you and every session, sessions' own transcripts and the backlog are kept in Postgres for good. Sessions search the same history with their search_history tool.</p>
  </section>`
}
