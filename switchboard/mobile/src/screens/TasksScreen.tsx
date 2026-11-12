import React, { useEffect, useMemo, useState } from 'react'
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { useStore } from '../store'
import type { Task } from '../types'
import { Button, Chip, base, timeAgo, useTheme } from '../ui'

const STATUSES = [
  ['backlog', 'Backlog'],
  ['todo', 'To do'],
  ['in_progress', 'In progress'],
  ['blocked', 'Blocked'],
  ['review', 'Review'],
  ['done', 'Done'],
] as const
const PRIORITY = ['P0 urgent', 'P1 high', 'P2 medium', 'P3 low']

export function TasksScreen() {
  const t = useTheme()
  const store = useStore()
  const { state } = store
  const [project, setProject] = useState('')
  const [status, setStatus] = useState<string>('in_progress')
  const [editing, setEditing] = useState<Task | 'new' | null>(null)
  useEffect(() => {
    void store.loadTasks().catch(err => store.toast((err as Error).message, 'error'))
  }, [])
  const tasks = state.tasks ?? []
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const x of tasks) if (!project || x.project === project) c[x.status] = (c[x.status] ?? 0) + 1
    return c
  }, [tasks, project])
  const shown = tasks
    .filter(x => (!project || x.project === project) && x.status === status)
    .sort((a, b) => a.priority - b.priority || a.position - b.position || a.id - b.id)
  return (
    <View style={{ flex: 1 }}>
      <View style={[base.row, { justifyContent: 'space-between', padding: 16 }]}>
        <Text style={[base.h1, { color: t.text }]}>Backlog</Text>
        <Button title="+ Task" kind="primary" onPress={() => setEditing('new')} />
      </View>
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8 }}>
          <Chip label="All projects" on={!project} onPress={() => setProject('')} />
          {state.projects.map(p => (
            <Chip key={p.slug} label={`${p.name} ${p.open_tasks ?? ''}`} on={project === p.slug} onPress={() => setProject(project === p.slug ? '' : p.slug)} />
          ))}
        </ScrollView>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8 }}>
          {STATUSES.map(([value, label]) => (
            <Chip key={value} label={`${label} ${counts[value] ?? 0}`} on={status === value} onPress={() => setStatus(value)} />
          ))}
        </ScrollView>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
        {state.tasks === null && <Text style={{ color: t.muted }}>Loading…</Text>}
        {state.tasks !== null && shown.length === 0 && <Text style={{ color: t.muted, textAlign: 'center', marginTop: 30 }}>Nothing here.</Text>}
        {shown.map(x => (
          <Pressable
            key={x.id}
            onPress={() => setEditing(x)}
            style={{ backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderLeftWidth: 4, borderLeftColor: t.p[x.priority] ?? t.p[2], borderRadius: 12, padding: 11, gap: 4 }}
          >
            <View style={[base.row, { justifyContent: 'space-between' }]}>
              <Text style={{ color: t.p[x.priority], fontWeight: '700', fontSize: 12 }}>P{x.priority}</Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>#{x.id} · {timeAgo(x.updated_at)}</Text>
            </View>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: '500' }}>{x.title}</Text>
            <Text style={{ color: t.muted, fontSize: 12 }}>
              {state.projects.find(p => p.slug === x.project)?.name ?? x.project}
              {x.assignee ? ` · @${x.assignee}` : ''}
              {x.tags.length ? ` · ${x.tags.join(', ')}` : ''}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {editing && <TaskEditor task={editing === 'new' ? null : editing} defaults={{ project: project || 'inbox' }} onClose={() => setEditing(null)} />}
    </View>
  )
}

function TaskEditor({ task, defaults, onClose }: { task: Task | null; defaults: { project: string }; onClose: () => void }) {
  const t = useTheme()
  const { api, state, toast } = useStore()
  const [f, setF] = useState({
    title: task?.title ?? '',
    body: task?.body ?? '',
    project: task?.project ?? defaults.project,
    status: task?.status ?? 'todo',
    priority: task?.priority ?? 2,
    assignee: task?.assignee ?? '',
    comment: '',
  })
  const save = async () => {
    try {
      if (task) await api.call('PATCH', `/api/tasks/${task.id}`, { ...f, comment: f.comment || undefined, by: 'user' })
      else await api.call('POST', '/api/tasks', { ...f, by: 'user' })
      onClose()
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }
  const field = (key: 'title' | 'body' | 'comment', placeholder: string, multiline = false) => (
    <TextInput
      placeholder={placeholder}
      placeholderTextColor={t.muted}
      multiline={multiline}
      value={f[key]}
      onChangeText={v => setF({ ...f, [key]: v })}
      style={{ borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 11, color: t.text, backgroundColor: t.surface, minHeight: multiline ? 90 : undefined }}
    />
  )
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 20, gap: 12 }}>
        <Text style={[base.h1, { color: t.text }]}>{task ? `Task #${task.id}` : 'New task'}</Text>
        {field('title', 'Title')}
        {field('body', 'Details', true)}
        <Text style={{ color: t.muted }}>Project</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {state.projects.map(p => (
            <Chip key={p.slug} label={p.name} on={f.project === p.slug} onPress={() => setF({ ...f, project: p.slug })} />
          ))}
        </ScrollView>
        <Text style={{ color: t.muted }}>Status</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {[...STATUSES, ['cancelled', 'Cancelled'] as const].map(([v, l]) => (
            <Chip key={v} label={l} on={f.status === v} onPress={() => setF({ ...f, status: v })} />
          ))}
        </ScrollView>
        <Text style={{ color: t.muted }}>Priority</Text>
        <View style={[base.row, { flexWrap: 'wrap', gap: 6 }]}>
          {PRIORITY.map((l, i) => (
            <Chip key={l} label={l} on={f.priority === i} onPress={() => setF({ ...f, priority: i })} />
          ))}
        </View>
        <Text style={{ color: t.muted }}>Assignee</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {['', 'user', ...Object.keys(state.sessions)].map(a => (
            <Chip key={a || 'none'} label={a === '' ? 'nobody' : a === 'user' ? 'me' : a} on={f.assignee === a} onPress={() => setF({ ...f, assignee: a })} />
          ))}
        </ScrollView>
        {task && field('comment', 'Add a comment', true)}
        <View style={[base.row, { gap: 8, justifyContent: 'flex-end' }]}>
          <Button title="Cancel" onPress={onClose} />
          <Button title="Save" kind="primary" disabled={!f.title.trim()} onPress={() => void save()} />
        </View>
      </ScrollView>
    </Modal>
  )
}
