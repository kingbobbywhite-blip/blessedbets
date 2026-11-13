// Small shared pieces: markdown, time, badges, modal.
import { html } from './html.js'
import { useEffect } from 'preact/hooks'

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Escape first, then a small, safe subset of markdown. */
export function renderMarkdown(text) {
  const blocks = []
  let s = esc(text).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`)
    return `\u0000${blocks.length - 1}\u0000`
  })
  s = s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>')
    .replace(/^\s*[-*]\s+(.+)$/gm, '• $1')
    .replace(/\n/g, '<br>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)])
}

export function Markdown({ text, class: cls }) {
  return html`<div class=${'md ' + (cls || '')} dangerouslySetInnerHTML=${{ __html: renderMarkdown(text) }}></div>`
}

/** A search snippet: [[match]] becomes highlighted, everything else escaped. */
export function Snippet({ text }) {
  const h = esc(text).replace(/\[\[/g, '<mark>').replace(/\]\]/g, '</mark>')
  return html`<span class="snippet" dangerouslySetInnerHTML=${{ __html: h }}></span>`
}

export function timeAgo(iso) {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d`
  return new Date(iso).toLocaleDateString()
}

export function clock(iso) {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export const STATUS_LABEL = {
  idle: 'idle',
  busy: 'working',
  waiting: 'needs you',
  starting: 'starting',
  attention: 'needs attention',
  offline: 'offline',
  exited: 'exited',
}

/** Status as shown: a session nobody started from here and with no channel is simply offline. */
export function liveStatus(s) {
  if (['offline', 'exited', 'starting', 'attention'].includes(s.status)) return s.status
  return s.connected || s.managed ? s.status : 'offline'
}

/** "idle", or "idle · channel reconnecting" for a running session whose channel is not connected. */
export function statusText(s) {
  const st = liveStatus(s)
  const label = STATUS_LABEL[st] || st
  return s.managed && !s.connected && !['offline', 'exited', 'starting', 'attention'].includes(st) ? `${label} · channel not connected` : label
}

export function StatusDot({ session }) {
  const st = liveStatus(session)
  return html`<span class=${`dot dot-${st}`} title=${statusText(session)}></span>`
}

export const PRIORITIES = [
  { value: 0, label: 'P0', name: 'urgent' },
  { value: 1, label: 'P1', name: 'high' },
  { value: 2, label: 'P2', name: 'medium' },
  { value: 3, label: 'P3', name: 'low' },
]
export const STATUSES = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'todo', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'review', label: 'Review' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
]

export function PriorityBadge({ p }) {
  const x = PRIORITIES[p] ?? PRIORITIES[2]
  return html`<span class=${`prio prio-${x.value}`} title=${x.name}>${x.label}</span>`
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return html`<div class="modal-backdrop" onClick=${e => e.target === e.currentTarget && onClose()}>
    <div class=${'modal' + (wide ? ' modal-wide' : '')} role="dialog" aria-modal="true" aria-label=${title}>
      <header class="modal-head">
        <h2>${title}</h2>
        <button class="icon-btn" onClick=${onClose} aria-label="Close">✕</button>
      </header>
      <div class="modal-body">${children}</div>
    </div>
  </div>`
}

export function copy(text) {
  return navigator.clipboard?.writeText(text).then(
    () => true,
    () => false,
  )
}
