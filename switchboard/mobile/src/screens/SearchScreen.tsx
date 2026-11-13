import React, { useState } from 'react'
import { FlatList, Pressable, Text, TextInput, View } from 'react-native'
import { useStore } from '../store'
import type { SearchHit } from '../types'
import { base, clock, useTheme } from '../ui'

export function SearchScreen({ open }: { open: (name: string | null) => void }) {
  const t = useTheme()
  const { api, toast } = useStore()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const run = async () => {
    if (!q.trim()) return
    try {
      setHits(await api.call<SearchHit[]>('GET', `/api/search?${new URLSearchParams({ q, limit: '60' })}`))
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }
  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 16, gap: 10 }}>
        <Text style={[base.h1, { color: t.text }]}>Search history</Text>
        <TextInput
          placeholder="What did we decide about…"
          placeholderTextColor={t.muted}
          returnKeyType="search"
          autoCapitalize="none"
          value={q}
          onChangeText={setQ}
          onSubmitEditing={() => void run()}
          style={{ borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 11, color: t.text, backgroundColor: t.surface }}
        />
      </View>
      <FlatList
        data={hits ?? []}
        keyExtractor={h => `${h.source}:${h.ref}`}
        contentContainerStyle={{ paddingHorizontal: 12, gap: 8, paddingBottom: 24 }}
        ListEmptyComponent={hits ? <Text style={{ color: t.muted, textAlign: "center" }}>Nothing found.</Text> : undefined}
        renderItem={({ item: h }) => (
          <Pressable onPress={() => h.source !== 'task' && h.session && open(h.session)} style={{ backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: 12, padding: 11, gap: 4 }}>
            <Text style={{ color: t.muted, fontSize: 12 }}>
              {h.source} · {h.source === 'task' ? `#${h.ref} ${h.title}` : `${h.from_id} → ${h.to_id}`} · {clock(h.created_at)}
            </Text>
            <Text style={{ color: t.text }}>
              {h.snippet.split(/(\[\[[^\]]*\]\])/g).map((part, i) =>
                part.startsWith('[[') ? (
                  <Text key={i} style={{ backgroundColor: t.accentSoft, fontWeight: '700' }}>
                    {part.slice(2, -2)}
                  </Text>
                ) : (
                  part
                ),
              )}
            </Text>
          </Pressable>
        )}
      />
    </View>
  )
}
