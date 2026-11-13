import { html } from '../lib/html.js'
import { useEffect, useState } from 'preact/hooks'
import { useStore } from '../lib/store.js'
import { api, setToken } from '../lib/api.js'
import { allowed, setAllowed } from '../lib/actions.js'
import { deviceSpeechRecognition, unlockSpeech, voices } from '../lib/voice.js'
import { copy, clock, timeAgo } from '../lib/ui.js'

export function Settings() {
  const { state, actions } = useStore()
  const [pair, setPair] = useState(null)
  const [code, setCode] = useState(null)
  const newCode = () =>
    api('POST', '/api/pair/codes', {})
      .then(setCode)
      .catch(() => {})
  const [devices, setDevices] = useState([])
  const [updates, setUpdates] = useState([])
  const [perms, setPerms] = useState(allowed())
  const [voiceList, setVoiceList] = useState(voices())
  useEffect(() => {
    api('GET', '/api/pair').then(setPair).catch(() => {})
    newCode()
    api('GET', '/api/devices').then(setDevices).catch(() => {})
    api('GET', '/api/app/updates').then(setUpdates).catch(() => {})
    const t = setTimeout(() => setVoiceList(voices()), 500)
    if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = () => setVoiceList(voices())
    return () => clearTimeout(t)
  }, [])
  const v = state.voice
  const setV = patch => actions.dispatch({ type: 'voice', patch })
  const english = voiceList.filter(x => x.lang?.startsWith((navigator.language || 'en').slice(0, 2)))
  const copyBtn = text => html`<button class="btn btn-small" onClick=${() => copy(text).then(ok => actions.toast(ok ? 'Copied' : 'Copy failed'))}>Copy</button>`

  return html`<section class="settings">
    <header class="section-head"><h1>Settings</h1></header>

    <div class="panel">
      <h2>Voice</h2>
      <label class="switch"><input type="checkbox" checked=${v.autoSpeak} onChange=${e => setV({ autoSpeak: e.target.checked })} /> Read every reply aloud (Walk mode always does)</label>
      <label class="switch"><input type="checkbox" checked=${v.announceSender} onChange=${e => setV({ announceSender: e.target.checked })} /> Say who is talking</label>
      <label class="switch"><input type="checkbox" checked=${v.readBack} onChange=${e => setV({ readBack: e.target.checked })} /> Read back what I said before it goes</label>
      <label>Push-to-talk
        <select value=${v.pttMode} onChange=${e => setV({ pttMode: e.target.value })}>
          <option value="hold">Hold to talk</option><option value="toggle">Tap to start, tap to send</option>
        </select>
      </label>
      <label>Transcription
        <select value=${v.transcribe} onChange=${e => setV({ transcribe: e.target.value })}>
          <option value="auto">Automatic (${state.info?.stt ? `hub: ${state.info.stt_model}` : 'this device'})</option>
          <option value="device" disabled=${!deviceSpeechRecognition()}>On this device${deviceSpeechRecognition() ? '' : ' (not supported here)'}</option>
          <option value="hub" disabled=${!state.info?.stt}>On the hub${state.info?.stt ? '' : ' (not configured)'}</option>
        </select>
      </label>
      <label>Voice
        <select value=${v.voiceURI} onChange=${e => setV({ voiceURI: e.target.value })}>
          <option value="">System default</option>
          ${(english.length ? english : voiceList).map(x => html`<option value=${x.voiceURI}>${x.name}</option>`)}
        </select>
      </label>
      <label>Speed ${v.rate.toFixed(2)}×<input type="range" min="0.7" max="1.6" step="0.05" value=${v.rate} onInput=${e => setV({ rate: Number(e.target.value) })} /></label>
      <button class="btn" onClick=${() => { unlockSpeech(); actions.say('This is how replies will sound.') }}>Test voice</button>
    </div>

    <div class="panel">
      <h2>Pair a phone</h2>
      <p>Point the phone's camera at this code and tap the link it shows. Switchboard opens in the phone's browser, signed in; then use Share → <strong>Add to Home Screen</strong>. The Switchboard app's <strong>Scan pairing code</strong> button reads the same code.</p>
      ${code ? html`<div class="qr" dangerouslySetInnerHTML=${{ __html: code.qr_svg }}></div>` : html`<p class="muted">Loading…</p>`}
      ${code && html`<p class="small">Or type this into the phone's browser: <code>${code.url}</code> ${copyBtn(code.url)}</p>`}
      <p class="muted small">
        ${code ? `Works until ${clock(code.expires_at)}. ` : ''}The phone needs the Tailscale app switched on.
        <button class="link-btn" onClick=${newCode}>New code</button>
      </p>
      ${!state.info?.public_url && html`<p class="muted small">No phone address is set, so this code only works on this computer. Run <code>switchboard tailscale</code>, then restart the hub.</p>`}
      <h3>Paired devices</h3>
      <ul class="plain">
        ${devices.map(d => html`<li>${d.online ? '🟢' : '⚪'} ${d.name} <span class="muted small">${d.platform}${d.app_version ? ` ${d.app_version}` : ''} · seen ${timeAgo(d.last_seen_at)} · push ${d.push_token ? 'on' : 'off'}</span></li>`)}
      </ul>
    </div>

    <div class="panel">
      <h2>Flic button (push to talk)</h2>
      <p>In the Flic app, give your button an <strong>Internet Request</strong> action (method GET or POST) for each gesture:</p>
      ${pair &&
      html`<dl class="urls">
        <dt>Click: start or stop talking</dt><dd><code>${pair.flic.toggle}</code> ${copyBtn(pair.flic.toggle)}</dd>
        <dt>Double click: cancel, and stop reading aloud</dt><dd><code>${pair.flic.cancel}</code> ${copyBtn(pair.flic.cancel)}</dd>
        <dt>Hold: start talking (pair with a Flic Hub for true hold-to-talk)</dt><dd><code>${pair.flic.start}</code> ${copyBtn(pair.flic.start)}</dd>
      </dl>`}
      <p class="muted small">The press goes to whichever device has Walk mode open (or voice on). With a Flic Hub, <code>switchboard/flic/hub-sdk-ptt.js</code> gives real hold-to-talk: recording while the button is down.</p>
    </div>

    <div class="panel">
      <h2>What sessions may do on this device</h2>
      <label class="switch"><input type="checkbox" checked=${perms.location} onChange=${e => { setAllowed({ location: e.target.checked }); setPerms(allowed()) }} /> Read my location</label>
      <label class="switch"><input type="checkbox" checked=${perms.clipboard} onChange=${e => { setAllowed({ clipboard: e.target.checked }); setPerms(allowed()) }} /> Read my clipboard</label>
      <p class="muted small">Speaking, notifications, vibration and opening links are always allowed. The phone app can also use your calendar and draft texts and emails.</p>
    </div>

    <div class="panel">
      <h2>Phone app updates</h2>
      <p class="muted small">Sessions publish new versions of the app with <code>switchboard app publish</code>; phones fetch them on their own.</p>
      <ul class="plain">
        ${updates.length === 0 && html`<li class="muted">Nothing published yet.</li>`}
        ${updates.slice(0, 8).map(u => html`<li>${u.rolled_back_at ? '↩︎' : '•'} ${clock(u.created_at)} <span class="muted small">runtime ${u.runtime_version} · ${u.platforms.join(', ')}</span> ${u.message}</li>`)}
      </ul>
    </div>

    <div class="panel">
      <h2>This browser</h2>
      <p class="muted small">Hub ${state.info?.version} · orchestrator <strong>${state.orchestrator}</strong> · tmux ${state.info?.tmux || 'not found'} · connection ${state.conn}</p>
      <button class="btn danger" onClick=${() => { if (confirm('Forget the token? You will need the QR code again.')) { setToken(null); location.reload() } }}>Forget token</button>
    </div>
  </section>`
}
