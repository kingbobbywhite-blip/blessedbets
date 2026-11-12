import { Platform } from 'react-native'
import * as Updates from 'expo-updates'
import * as IntentLauncher from 'expo-intent-launcher'
import { File, Paths } from 'expo-file-system'
import Constants from 'expo-constants'
import type { Api } from './api'

/**
 * Over-the-air updates: the hub serves new JavaScript for this app
 * (`switchboard app publish`), and the app pulls and applies it on its own.
 */
export const otaAvailable = Updates.isEnabled && !__DEV__

export function currentUpdate() {
  return {
    updateId: Updates.updateId,
    runtimeVersion: Updates.runtimeVersion,
    embedded: Updates.isEmbeddedLaunch,
    createdAt: Updates.createdAt?.toISOString() ?? null,
    appVersion: Constants.expoConfig?.version ?? null,
  }
}

/** Download a newer update if there is one. Returns true when one is ready to apply. */
export async function fetchNewUpdate(): Promise<boolean> {
  if (!otaAvailable) return false
  const check = await Updates.checkForUpdateAsync()
  if (!check.isAvailable) return false
  const fetched = await Updates.fetchUpdateAsync()
  return fetched.isNew
}

export async function applyUpdate(): Promise<void> {
  await Updates.reloadAsync()
}

export interface NativeBuild {
  id: number
  version: string
  runtime_version: string
  message: string
  url: string
  sha256: string
}

/** Android only: a newer installable build the hub is offering (for changes an OTA update cannot carry). */
export async function nativeBuildOffer(api: Api): Promise<NativeBuild | null> {
  if (Platform.OS !== 'android') return null
  const build = await api.call<NativeBuild | null>('GET', '/api/app/native?platform=android').catch(() => null)
  if (!build) return null
  const mine = Constants.expoConfig?.version ?? '0'
  const newerRuntime = build.runtime_version && build.runtime_version !== Updates.runtimeVersion
  return newerRuntime || compareVersions(build.version, mine) > 0 ? build : null
}

export async function installNativeBuild(api: Api, build: NativeBuild): Promise<void> {
  const dest = new File(Paths.cache, `switchboard-${build.version}.apk`)
  if (dest.exists) dest.delete()
  const file = await File.downloadFileAsync(`${build.url}?token=${encodeURIComponent(api.token)}`, dest)
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: file.contentUri,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    type: 'application/vnd.android.package-archive',
  })
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}
