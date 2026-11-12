import { html } from './lib/html.js'
import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { setToken, takeTokenFromUrl } from './lib/api.js'
import { Store, useAppStore, useStore } from './lib/store.js'
import { SessionList } from './views/sessions.js'
import { Chat } from './views/chat.js'
import { Tasks } from './views/tasks.js'
import { Search } from './views/search.js'
import { Walk } from './views/walk.js'
import { Settings } from './views/settings.js'
import { unlockSpeech } from './lib/voice.js'

takeTokenFromUrl()

function useRoute() {
  const [hash, setHash] = useState(location.hash || '#/')
  useEffect(() => {
    const on = () => setHash(location.hash || '#/')
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const parts = hash.replace(/^#\/?/, '').split('/')
  return { view: parts[0] || 'home', arg: parts[1] ? decodeURIComponent(parts[1]) : null }
}

function Approvals() {
  const { state, actions } = useStore()
  const [open, setOpen] = useState(null)
  if (!state.pending.length) return null
  return html`<div class="approvals" role="alert">
    ${state.pending.map(
      p => html`<div class="approval" key=${p.id}>
        <div class="approval-text" onClick=${() => setOpen(open === p.id ? null : p.id)}>
          <strong>${p.session}</strong> wants to use <strong>${p.tool_name}</strong>
          <div class="small">${p.description}</div>
          ${open === p.id && html`<pre class="screen">${p.input_preview}</pre>`}
        </div>
        <div class="approval-actions">
          <button class="btn btn-small danger" onClick=${() => actions.decide(p.id, 'deny')}>Deny</button>
          <button class="btn btn-small btn-primary" onClick=${() => actions.decide(p.id, 'allow')}>Allow</button>
        </div>
      </div>`,
    )}
  </div>`
}

function Pairing() {
  const [token, setT] = useState('')
  return html`<main class="pairing">
    <h1>Switchboard</h1>
    <p>This browser is not paired with the hub yet.</p>
    <p>On the computer running the hub, run <code>switchboard pair</code> and scan the code, or open the link it prints. Or paste the token:</p>
    <form onSubmit=${e => { e.preventDefault(); setToken(token.trim()); location.hash = '#/'; location.reload() }}>
      <input placeholder="token" value=${token} onInput=${e => setT(e.target.value)} autocapitalize="none" />
      <button class="btn btn-primary">Pair</button>
    </form>
  </main>`
}

const TABS = [
  { href: '#/', view: 'home', label: 'Sessions', icon: '💬' },
  { href: '#/tasks', view: 'tasks', label: 'Backlog', icon: '☰' },
  { href: '#/walk', view: 'walk', label: 'Walk', icon: '🎙' },
  { href: '#/search', view: 'search', label: 'Search', icon: '⌕' },
  { href: '#/settings', view: 'settings', label: 'Settings', icon: '⚙' },
]

function Shell() {
  const { state } = useStore()
  const route = useRoute()
  if (state.conn === 'unauthorized') return html`<${Pairing} />`
  const totalUnread = Object.values(state.unread).reduce((a, b) => a + b, 0)
  let main
  switch (route.view) {
    case 's':
      main = html`<${Chat} name=${route.arg} />`
      break
    case 'all':
      main = html`<${Chat} name=${null} />`
      break
    case 'tasks':
      main = html`<${Tasks} />`
      break
    case 'search':
      main = html`<${Search} />`
      break
    case 'walk':
      main = html`<${Walk} />`
      break
    case 'settings':
      main = html`<${Settings} />`
      break
    default:
      main = html`<${SessionList} />`
  }
  const wideChat = route.view === 's' || route.view === 'all'
  return html`<div class=${'shell view-' + route.view} onPointerDown=${once}>
    <aside class="sidebar">
      <div class="brand">Switchboard</div>
      <nav class="side-nav">${TABS.map(t => html`<a class=${route.view === t.view || (t.view === 'home' && wideChat) ? 'on' : ''} href=${t.href}>${t.icon} ${t.label}</a>`)}</nav>
      <${SessionList} compact />
    </aside>
    <main class=${'main' + (wideChat ? ' main-chat' : '')}>
      ${state.conn !== 'open' && html`<div class="conn-banner">${state.conn === 'connecting' ? 'Connecting to the hub…' : 'Hub unreachable, retrying…'}</div>`}
      <${Approvals} />
      ${main}
    </main>
    <nav class="tabbar">
      ${TABS.map(
        t => html`<a class=${route.view === t.view || (t.view === 'home' && wideChat) ? 'on' : ''} href=${t.href}>
          <span class="tab-icon">${t.icon}</span><span>${t.label}</span>${t.view === 'home' && totalUnread > 0 ? html`<span class="badge">${totalUnread}</span>` : ''}
        </a>`,
      )}
    </nav>
    ${state.toast && html`<div class=${'toast toast-' + state.toast.kind}>${state.toast.text}</div>`}
  </div>`
}

// iOS needs one tap before the page may speak.
let unlocked = false
function once() {
  if (!unlocked) {
    unlocked = true
    unlockSpeech()
  }
}

function App() {
  const store = useAppStore()
  return html`<${Store.Provider} value=${store}><${Shell} /><//>`
}

render(html`<${App} />`, document.getElementById('app'))
