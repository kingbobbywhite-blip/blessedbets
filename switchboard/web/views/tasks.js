import { html } from '../lib/html.js'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { useStore } from '../lib/store.js'
import { api } from '../lib/api.js'
import { Markdown, Modal, PRIORITIES, PriorityBadge, STATUSES, clock, timeAgo } from '../lib/ui.js'

const LS = 'switchboard.taskFilters'
const loadFilters = () => {
  try {
    return { project: '', assignee: '', priority: '', q: '', closed: false, ...JSON.parse(localStorage.getItem(LS) || '{}') }
  } catch {
    return { project: '', assignee: '', priority: '', q: '', closed: false }
  }
}

export function Tasks() {
  const { state, actions } = useStore()
  const [f, setF] = useState(loadFilters)
  const [editing, setEditing] = useState(null) // task id, or 'new'
  const [newProject, setNewProject] = useState(false)
  useEffect(() => {
    actions.loadTasks().catch(err => actions.toast(err.message, 'error'))
  }, [])
  useEffect(() => {
    try {
      localStorage.setItem(LS, JSON.stringify(f))
    } catch {
      // ignore
    }
  }, [f])
  const tasks = state.tasks || []
  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase()
    return tasks
      .filter(t => !f.project || t.project === f.project)
      .filter(t => !f.assignee || (f.assignee === '-' ? !t.assignee : t.assignee === f.assignee))
      .filter(t => f.priority === '' || t.priority === Number(f.priority))
      .filter(t => !q || t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q) || `#${t.id}` === q)
      .sort((a, b) => a.priority - b.priority || a.position - b.position || a.id - b.id)
  }, [tasks, f])
  const columns = STATUSES.filter(s => f.closed || (s.value !== 'cancelled' && s.value !== 'done') || s.value === 'done')
  const assignees = [...new Set(tasks.map(t => t.assignee).filter(Boolean))].sort()
  const counts = useMemo(() => {
    const c = {}
    for (const t of tasks) if (t.status !== 'done' && t.status !== 'cancelled') c[t.project] = (c[t.project] || 0) + 1
    return c
  }, [tasks])
  const set = k => e => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  return html`<section class="tasks">
    <header class="section-head">
      <h1>Backlog</h1>
      <div class="row-inline">
        <button class="btn" onClick=${() => setNewProject(true)}>+ Project</button>
        <button class="btn btn-primary" onClick=${() => setEditing('new')}>+ Task</button>
      </div>
    </header>
    <div class="project-strip">
      <button class=${'chip' + (!f.project ? ' on' : '')} onClick=${() => setF({ ...f, project: '' })}>All <span>${Object.values(counts).reduce((a, b) => a + b, 0)}</span></button>
      ${state.projects.map(
        p => html`<button class=${'chip' + (f.project === p.slug ? ' on' : '')} onClick=${() => setF({ ...f, project: f.project === p.slug ? '' : p.slug })} title=${p.description}>
          ${p.name} <span>${counts[p.slug] || 0}</span>
        </button>`,
      )}
    </div>
    <div class="filters">
      <input type="search" placeholder="Filter tasks" value=${f.q} onInput=${set('q')} />
      <select value=${f.priority} onChange=${set('priority')} aria-label="Priority">
        <option value="">Any priority</option>
        ${PRIORITIES.map(p => html`<option value=${p.value}>${p.label} ${p.name}</option>`)}
      </select>
      <select value=${f.assignee} onChange=${set('assignee')} aria-label="Assignee">
        <option value="">Anyone</option><option value="-">Unassigned</option>
        ${assignees.map(a => html`<option value=${a}>${a}</option>`)}
      </select>
      <label class="small"><input type="checkbox" checked=${f.closed} onChange=${set('closed')} /> cancelled</label>
    </div>
    ${state.tasks === null && html`<p class="muted center">Loading…</p>`}
    <div class="board">
      ${columns.map(col => {
        const items = filtered.filter(t => t.status === col.value)
        const shown = col.value === 'done' && !f.closed ? items.sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || '')).slice(0, 15) : items
        return html`<div class="column" key=${col.value}>
          <h3>${col.label} <span class="muted">${items.length}</span></h3>
          ${shown.map(t => html`<${TaskCard} key=${t.id} t=${t} project=${state.projects.find(p => p.slug === t.project)} onOpen=${() => setEditing(t.id)} />`)}
          ${items.length === 0 && html`<p class="muted small center">—</p>`}
        </div>`
      })}
    </div>
    ${editing && html`<${TaskEditor} id=${editing} defaults=${{ project: f.project || 'inbox' }} onClose=${() => setEditing(null)} />`}
    ${newProject && html`<${ProjectEditor} onClose=${() => setNewProject(false)} />`}
  </section>`
}

function TaskCard({ t, project, onOpen }) {
  return html`<button class=${`card prio-border-${t.priority}`} onClick=${onOpen}>
    <div class="card-top"><${PriorityBadge} p=${t.priority} /><span class="muted small">#${t.id}</span></div>
    <div class="card-title">${t.title}</div>
    <div class="card-meta">
      <span class="chip small">${project?.name || t.project}</span>
      ${t.assignee && html`<span class="chip small assignee">@${t.assignee}</span>`}
      ${t.tags.map(tag => html`<span class="chip small tag">${tag}</span>`)}
      <span class="muted small">${timeAgo(t.updated_at)}</span>
    </div>
  </button>`
}

function TaskEditor({ id, defaults, onClose }) {
  const { state, actions } = useStore()
  const isNew = id === 'new'
  const [task, setTask] = useState(isNew ? { title: '', body: '', project: defaults.project, status: 'todo', priority: 2, assignee: '', tags: [] } : null)
  const [detail, setDetail] = useState(null)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!isNew)
      api('GET', `/api/tasks/${id}`).then(t => {
        setDetail(t)
        setTask({ ...t, assignee: t.assignee || '', tags: t.tags || [] })
      })
  }, [id])
  if (!task) return html`<${Modal} title="Task" onClose=${onClose}><p class="muted">Loading…</p><//>`
  const set = k => e => setTask({ ...task, [k]: k === 'priority' ? Number(e.target.value) : e.target.value })
  const save = async e => {
    e.preventDefault()
    setBusy(true)
    try {
      const body = { ...task, tags: typeof task.tags === 'string' ? task.tags.split(',').map(s => s.trim()).filter(Boolean) : task.tags, by: 'user' }
      if (isNew) await api('POST', '/api/tasks', body)
      else await api('PATCH', `/api/tasks/${id}`, { ...body, comment: comment || undefined })
      onClose()
    } catch (err) {
      actions.toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!confirm('Delete this task for good? (Cancelled keeps its history.)')) return
    await api('DELETE', `/api/tasks/${id}`).catch(err => actions.toast(err.message, 'error'))
    onClose()
  }
  const sessions = Object.keys(state.sessions)
  return html`<${Modal} title=${isNew ? 'New task' : `Task #${id}`} onClose=${onClose} wide>
    <form class="form" onSubmit=${save}>
      <label>Title <input required value=${task.title} onInput=${set('title')} /></label>
      <label>Details <textarea rows="5" value=${task.body} onInput=${set('body')}></textarea></label>
      <div class="row">
        <label>Project
          <select value=${task.project} onChange=${set('project')}>${state.projects.map(p => html`<option value=${p.slug}>${p.name}</option>`)}</select>
        </label>
        <label>Status
          <select value=${task.status} onChange=${set('status')}>${STATUSES.map(s => html`<option value=${s.value}>${s.label}</option>`)}</select>
        </label>
        <label>Priority
          <select value=${task.priority} onChange=${set('priority')}>${PRIORITIES.map(p => html`<option value=${p.value}>${p.label} ${p.name}</option>`)}</select>
        </label>
        <label>Assignee
          <select value=${task.assignee} onChange=${set('assignee')}>
            <option value="">Nobody</option><option value="user">Me</option>
            ${sessions.map(s => html`<option value=${s}>${s}</option>`)}
          </select>
        </label>
      </div>
      <label>Tags <input placeholder="comma, separated" value=${Array.isArray(task.tags) ? task.tags.join(', ') : task.tags} onInput=${e => setTask({ ...task, tags: e.target.value })} /></label>
      ${!isNew && html`<label>Add a comment <textarea rows="2" value=${comment} onInput=${e => setComment(e.target.value)}></textarea></label>`}
      <div class="form-actions">
        ${!isNew && html`<button type="button" class="btn danger" onClick=${remove}>Delete</button>`}
        <span class="spacer"></span>
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        <button class="btn btn-primary" disabled=${busy}>Save</button>
      </div>
    </form>
    ${detail &&
    html`<div class="history">
      ${detail.subtasks.length > 0 && html`<h3>Subtasks</h3><ul>${detail.subtasks.map(s => html`<li>#${s.id} [${s.status}] ${s.title}</li>`)}</ul>`}
      <h3>History</h3>
      <ul>
        ${detail.events.map(
          ev => html`<li>
            <span class="muted small">${clock(ev.created_at)} · ${ev.actor}</span>
            ${ev.kind === 'comment'
              ? html`<${Markdown} text=${ev.body} />`
              : ev.kind === 'created'
                ? html`<div>created</div>`
                : html`<div>${Object.entries(ev.data).map(([k, v]) => html`<span class="change">${k}: ${String(v?.from ?? '—')} → <strong>${String(v?.to ?? '—')}</strong></span> `)}</div>`}
          </li>`,
        )}
      </ul>
    </div>`}
  <//>`
}

function ProjectEditor({ onClose }) {
  const { actions } = useStore()
  const [p, setP] = useState({ slug: '', name: '', description: '', path: '' })
  const set = k => e => setP({ ...p, [k]: e.target.value })
  const save = async e => {
    e.preventDefault()
    try {
      await api('POST', '/api/projects', { ...p, slug: p.slug.trim().toLowerCase(), path: p.path || null })
      onClose()
    } catch (err) {
      actions.toast(err.message, 'error')
    }
  }
  return html`<${Modal} title="New project" onClose=${onClose}>
    <form class="form" onSubmit=${save}>
      <label>Short id <input required pattern="[a-z0-9][a-z0-9_-]{0,39}" placeholder="blessedbets" value=${p.slug} onInput=${set('slug')} autocapitalize="none" /></label>
      <label>Name <input placeholder="BlessedBets" value=${p.name} onInput=${set('name')} /></label>
      <label>Description <input value=${p.description} onInput=${set('description')} /></label>
      <label>Folder <input placeholder="~/code/blessedbets" value=${p.path} onInput=${set('path')} autocapitalize="none" /></label>
      <div class="form-actions"><button type="button" class="btn" onClick=${onClose}>Cancel</button><button class="btn btn-primary">Create</button></div>
    </form>
  <//>`
}
