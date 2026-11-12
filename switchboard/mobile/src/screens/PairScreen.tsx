import React, { useState } from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { builtInHubUrl, parsePairing, savePairing, type Pairing } from '../config'
import { Button, useTheme } from '../ui'

export function PairScreen({ onPaired }: { onPaired: (p: Pairing) => void }) {
  const t = useTheme()
  const [permission, requestPermission] = useCameraPermissions()
  const [scanning, setScanning] = useState(false)
  const [url, setUrl] = useState(builtInHubUrl ?? '')
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const tryPair = async (p: Pairing) => {
    setChecking(true)
    setError(null)
    try {
      const res = await fetch(`${p.url.replace(/\/+$/, '')}/api/info`, { headers: { authorization: `Bearer ${p.token}` } })
      if (res.status === 401) throw new Error('The hub did not accept that token.')
      if (!res.ok) throw new Error(`The hub answered ${res.status}.`)
      await savePairing(p)
      onPaired({ url: p.url.replace(/\/+$/, ''), token: p.token })
    } catch (err) {
      setError(`${(err as Error).message} Check the address is reachable from this phone (Tailscale on?).`)
    } finally {
      setChecking(false)
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 20, gap: 16, paddingTop: 70 }}>
      <Text style={{ color: t.text, fontSize: 28, fontWeight: '700' }}>Switchboard</Text>
      <Text style={{ color: t.muted, fontSize: 15 }}>
        Pair this phone with your hub. On the computer running it, run <Text style={{ fontFamily: 'Menlo' }}>switchboard pair</Text>, or open the web UI's Settings, and scan the code.
      </Text>
      {scanning ? (
        <View style={{ height: 320, borderRadius: 16, overflow: 'hidden' }}>
          <CameraView
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              const p = parsePairing(data)
              if (p) {
                setScanning(false)
                void tryPair(p)
              }
            }}
          />
        </View>
      ) : (
        <Button
          kind="primary"
          title="Scan pairing code"
          onPress={async () => {
            if (!permission?.granted) {
              const r = await requestPermission()
              if (!r.granted) return setError('Camera permission is needed to scan. You can type the details below instead.')
            }
            setScanning(true)
          }}
        />
      )}
      <Text style={{ color: t.muted }}>Or enter them:</Text>
      <TextInput
        placeholder="https://your-mac.tailnet.ts.net"
        placeholderTextColor={t.muted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={url}
        onChangeText={setUrl}
        style={{ borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 11, color: t.text, backgroundColor: t.surface }}
      />
      <TextInput
        placeholder="token"
        placeholderTextColor={t.muted}
        autoCapitalize="none"
        autoCorrect={false}
        value={token}
        onChangeText={text => {
          const p = parsePairing(text)
          if (p) {
            setUrl(p.url)
            setToken(p.token)
          } else setToken(text)
        }}
        style={{ borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 11, color: t.text, backgroundColor: t.surface }}
      />
      <Button title={checking ? 'Checking…' : 'Pair'} kind="primary" disabled={checking || !url || !token} onPress={() => void tryPair({ url: url.trim(), token: token.trim() })} />
      {error && <Text style={{ color: t.danger }}>{error}</Text>}
      <Pressable onPress={() => setScanning(false)}>
        <Text style={{ color: t.muted, fontSize: 12 }}>The token lets this phone talk to your sessions. It is kept in the phone's secure storage.</Text>
      </Pressable>
    </ScrollView>
  )
}
