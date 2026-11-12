import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type pg from 'pg'

/**
 * A server for the Expo Updates protocol (version 1), so the phone app pulls
 * new JavaScript from your own hub instead of from Expo's servers. Publishing
 * an update (`switchboard app publish`) is all it takes for the app to update
 * itself; nothing goes through an app store.
 *
 * Spec: https://docs.expo.dev/technical-specs/expo-updates-1/
 */

export interface UpdateRow {
  id: string
  runtime_version: string
  platforms: string[]
  message: string
  dir: string
  created_at: string
  rolled_back_at: string | null
}

interface PlatformMetadata {
  bundle: string
  assets: { path: string; ext: string }[]
}

export interface ManifestAsset {
  hash: string
  key: string
  fileExtension: string
  contentType: string
  url: string
}

export interface Manifest {
  id: string
  createdAt: string
  runtimeVersion: string
  launchAsset: ManifestAsset
  assets: ManifestAsset[]
  metadata: Record<string, string>
  extra: { expoClient?: Record<string, unknown> }
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  json: 'application/json',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  caf: 'audio/x-caf',
  mp4: 'video/mp4',
  html: 'text/html',
  js: 'application/javascript',
  css: 'text/css',
}

export function updatesRoot(dataDir: string): string {
  return path.join(dataDir, 'updates')
}

/** The update id the protocol uses: the SHA-256 of metadata.json, written as a UUID. */
export function updateIdFor(metadataJson: Buffer | string): string {
  const hex = crypto.createHash('sha256').update(metadataJson).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export async function latestUpdate(db: pg.Pool, runtimeVersion: string, platform: string): Promise<UpdateRow | null> {
  const { rows } = await db.query<UpdateRow>(
    `select * from app_updates where runtime_version = $1 and $2 = any(platforms) and rolled_back_at is null
     order by created_at desc limit 1`,
    [runtimeVersion, platform],
  )
  return rows[0] ?? null
}

function assetMetadata(updateDir: string, relPath: string, ext: string | null, isLaunchAsset: boolean, assetUrl: (p: string) => string): ManifestAsset {
  const file = safeJoin(updateDir, relPath)
  const data = fs.readFileSync(file)
  return {
    hash: crypto.createHash('sha256').update(data).digest('base64url'),
    key: crypto.createHash('md5').update(data).digest('hex'),
    fileExtension: isLaunchAsset ? '.bundle' : `.${ext ?? ''}`,
    contentType: isLaunchAsset ? 'application/javascript' : (MIME[(ext ?? '').toLowerCase()] ?? 'application/octet-stream'),
    url: assetUrl(relPath),
  }
}

export function buildManifest(update: UpdateRow, platform: 'ios' | 'android', baseUrl: string, assetToken?: string): Manifest {
  const metadata = JSON.parse(fs.readFileSync(path.join(update.dir, 'metadata.json'), 'utf8')) as {
    fileMetadata: Record<string, PlatformMetadata>
  }
  const platformMeta = metadata.fileMetadata?.[platform]
  if (!platformMeta) throw new Error(`Update ${update.id} has no ${platform} bundle`)
  let expoClient: Record<string, unknown> | undefined
  try {
    expoClient = JSON.parse(fs.readFileSync(path.join(update.dir, 'expoConfig.json'), 'utf8'))
  } catch {
    expoClient = undefined
  }
  // When the hub keeps updates private, the asset links carry the token the manifest request came with.
  const assetUrl = (p: string) =>
    `${baseUrl}/updates/assets?${new URLSearchParams({ update: update.id, platform, path: p, ...(assetToken ? { token: assetToken } : {}) }).toString()}`
  return {
    id: update.id,
    createdAt: new Date(update.created_at).toISOString(),
    runtimeVersion: update.runtime_version,
    launchAsset: assetMetadata(update.dir, platformMeta.bundle, null, true, assetUrl),
    assets: platformMeta.assets.map(a => assetMetadata(update.dir, a.path, a.ext, false, assetUrl)),
    metadata: {},
    extra: expoClient ? { expoClient } : {},
  }
}

/** A multipart/mixed body the expo-updates client accepts: one JSON part per name. */
export function multipart(parts: { name: string; json: unknown }[]): { body: Buffer; contentType: string } {
  const boundary = `switchboard-${crypto.randomBytes(12).toString('hex')}`
  const chunks: string[] = []
  for (const part of parts) {
    chunks.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${part.name}"\r\n` +
        `Content-Type: application/json; charset=utf-8\r\n\r\n` +
        `${JSON.stringify(part.json)}\r\n`,
    )
  }
  chunks.push(`--${boundary}--\r\n`)
  return { body: Buffer.from(chunks.join(''), 'utf8'), contentType: `multipart/mixed; boundary=${boundary}` }
}

export type ManifestResponse =
  | { status: 200; headers: Record<string, string>; body: Buffer }
  | { status: 204 | 400 | 404; headers: Record<string, string>; body: string }

/** Answer GET /updates/manifest. */
export async function manifestResponse(
  db: pg.Pool,
  req: { headers: Record<string, string | string[] | undefined>; query: Record<string, string | undefined> },
  baseUrl: string,
  assetToken?: string,
): Promise<ManifestResponse> {
  const header = (n: string) => {
    const v = req.headers[n]
    return Array.isArray(v) ? v[0] : v
  }
  const protocolVersion = Number(header('expo-protocol-version') ?? '0')
  const platform = (header('expo-platform') ?? req.query.platform ?? '') as 'ios' | 'android'
  const runtimeVersion = header('expo-runtime-version') ?? req.query['runtime-version'] ?? ''
  const base = { 'expo-protocol-version': String(protocolVersion === 1 ? 1 : 0), 'expo-sfv-version': '0', 'cache-control': 'private, max-age=0' }
  if (platform !== 'ios' && platform !== 'android') {
    return { status: 400, headers: base, body: 'expo-platform must be ios or android' }
  }
  if (!runtimeVersion) return { status: 400, headers: base, body: 'expo-runtime-version is required' }

  const update = await latestUpdate(db, runtimeVersion, platform)
  const currentUpdateId = header('expo-current-update-id')
  if (!update || (currentUpdateId && currentUpdateId.toLowerCase() === update.id.toLowerCase())) {
    if (protocolVersion === 1) {
      const { body, contentType } = multipart([{ name: 'directive', json: { type: 'noUpdateAvailable' } }])
      return { status: 200, headers: { ...base, 'content-type': contentType }, body }
    }
    return { status: 204, headers: base, body: '' }
  }
  const manifest = buildManifest(update, platform, baseUrl, assetToken)
  const { body, contentType } = multipart([
    { name: 'manifest', json: manifest },
    { name: 'extensions', json: { assetRequestHeaders: {} } },
  ])
  return { status: 200, headers: { ...base, 'content-type': contentType }, body }
}

/** The file behind GET /updates/assets, kept inside its update's directory. */
export async function assetFile(
  db: pg.Pool,
  query: Record<string, string | undefined>,
): Promise<{ file: string; contentType: string } | null> {
  const { update: id, path: rel } = query
  if (!id || !rel) return null
  const { rows } = await db.query<UpdateRow>('select * from app_updates where id = $1', [id])
  const update = rows[0]
  if (!update) return null
  const metadata = JSON.parse(fs.readFileSync(path.join(update.dir, 'metadata.json'), 'utf8')) as {
    fileMetadata: Record<string, PlatformMetadata>
  }
  for (const meta of Object.values(metadata.fileMetadata ?? {})) {
    if (meta.bundle === rel) return { file: safeJoin(update.dir, rel), contentType: 'application/javascript' }
    const asset = meta.assets.find(a => a.path === rel)
    if (asset) return { file: safeJoin(update.dir, rel), contentType: MIME[asset.ext.toLowerCase()] ?? 'application/octet-stream' }
  }
  return null
}

function safeJoin(root: string, rel: string): string {
  const full = path.resolve(root, rel)
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('path escapes the update directory')
  return full
}

/** Record an update the CLI exported into dataDir/updates/<runtime>/<id>. */
export async function registerUpdate(
  db: pg.Pool,
  dataDir: string,
  input: { dir: string; message?: string },
): Promise<UpdateRow> {
  const root = updatesRoot(dataDir)
  const dir = path.resolve(input.dir)
  if (!dir.startsWith(root + path.sep)) throw new Error(`Updates must live under ${root}`)
  const metadataRaw = fs.readFileSync(path.join(dir, 'metadata.json'))
  const metadata = JSON.parse(metadataRaw.toString('utf8')) as { fileMetadata: Record<string, PlatformMetadata> }
  const expoConfig = JSON.parse(fs.readFileSync(path.join(dir, 'expoConfig.json'), 'utf8')) as { runtimeVersion?: unknown }
  if (typeof expoConfig.runtimeVersion !== 'string') {
    throw new Error('The app config must set runtimeVersion to a plain string (see mobile/app.config.ts).')
  }
  const platforms = Object.keys(metadata.fileMetadata ?? {}).filter(p => p === 'ios' || p === 'android')
  if (!platforms.length) throw new Error('The export has no ios or android bundle')
  const id = updateIdFor(metadataRaw)
  const { rows } = await db.query<UpdateRow>(
    `insert into app_updates (id, runtime_version, platforms, message, dir) values ($1, $2, $3, $4, $5)
     on conflict (id) do update set message = excluded.message, rolled_back_at = null, created_at = now()
     returning *`,
    [id, expoConfig.runtimeVersion, platforms, input.message ?? '', dir],
  )
  return rows[0]
}
