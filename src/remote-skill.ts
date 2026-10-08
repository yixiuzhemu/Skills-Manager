/**
 * On-demand remote skill resolution. When a consumer asks for a skill by its
 * external catalog id and it is not installed locally, the manager consults a
 * single configured resolver endpoint, which answers with a presigned download
 * URL for the skill archive. This module owns the two HTTP steps — resolving
 * the reference and downloading the archive bytes — and is deliberately free of
 * any Cordis or filesystem dependency so it can be unit-tested against a
 * stubbed `fetch`.
 *
 * Two hard rules shape the design:
 * 1. **No fan-out.** Resolution only ever talks to the one configured endpoint;
 *    a miss (404, `success:false`, or a missing `downloadUrl`) yields
 *    `undefined`, never a retry against another server.
 * 2. **Token confinement.** The bearer token is sent to the resolver endpoint
 *    only. The presigned download URL points at a different origin (object
 *    storage), so the archive fetch carries no `authorization` header.
 *
 * @module @dtranx/skills-manager/remote-skill
 */

/** Thrown when the resolver endpoint or download host is unreachable/malformed. */
export class RemoteSkillError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RemoteSkillError'
  }
}

/** Configuration for the single remote skill resolver endpoint. */
export interface RemoteSkillResolverConfig {
  /** Resolver base URL (scheme + host [+ prefix]); an empty value disables resolution. */
  baseUrl: string
  /** Optional bearer token, sent to the resolver endpoint only. */
  token?: string
  /** Per-request timeout in milliseconds; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
}

/** The resolver's answer for one skill id. */
export interface RemoteSkillRef {
  /** Presigned URL of the skill archive (zip). */
  downloadUrl: string
  /** Display name advertised by the resolver (used as a fallback skill name). */
  skillName: string
}

/** Default per-request timeout when none is configured. */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Normalize a configured base URL: prepend `https://` when no scheme is given
 * and strip trailing slashes. An empty/blank value normalizes to `''`.
 * @param baseUrl - the raw configured value (a domain or a full URL).
 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (trimmed.length === 0) return ''
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

/** Whether remote resolution is enabled (a non-empty base URL is configured). */
export function isResolverEnabled(config: Pick<RemoteSkillResolverConfig, 'baseUrl'>): boolean {
  return normalizeBaseUrl(config.baseUrl).length > 0
}

/**
 * Build the resolver download-endpoint URL for one skill id.
 * The fixed path shape is `/skills/skills/{id}/download`.
 * @param baseUrl - the normalized (or raw) resolver base URL.
 * @param id - the external skill catalog id.
 */
export function downloadEndpoint(baseUrl: string, id: string): string {
  return `${normalizeBaseUrl(baseUrl)}/skills/skills/${encodeURIComponent(id)}/download`
}

/** Build an abort signal that fires after the configured (or default) timeout. */
function requestSignal(timeoutMs: number | undefined): AbortSignal {
  const ms = timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  return AbortSignal.timeout(ms)
}

/**
 * Parse the resolver response envelope into a download reference.
 * Accepts `{ success, data: { downloadUrl, skillName } }`; returns `undefined`
 * whenever the envelope reports a miss or carries no usable download URL.
 * @param payload - the parsed JSON body from the resolver endpoint.
 */
export function parseResolverPayload(payload: unknown): RemoteSkillRef | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const envelope = payload as { success?: unknown; data?: unknown }
  if (envelope.success === false) return undefined
  const data = envelope.data
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { downloadUrl?: unknown; skillName?: unknown }
  const downloadUrl = typeof record.downloadUrl === 'string' ? record.downloadUrl.trim() : ''
  if (downloadUrl.length === 0) return undefined
  const skillName = typeof record.skillName === 'string' ? record.skillName : ''
  return { downloadUrl, skillName }
}

/**
 * Ask the resolver endpoint for a skill's download reference.
 * @param id - the external skill catalog id.
 * @param config - resolver base URL, optional token, and optional timeout.
 * @returns the download reference, or `undefined` when the endpoint reports the
 *   skill is not found.
 * @throws {RemoteSkillError} on a network failure, a non-2xx (other than 404)
 *   status, or an unparseable body.
 */
export async function resolveRemoteSkill(id: string, config: RemoteSkillResolverConfig): Promise<RemoteSkillRef | undefined> {
  const base = normalizeBaseUrl(config.baseUrl)
  if (base.length === 0) return undefined
  const url = downloadEndpoint(base, id)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (config.token !== undefined && config.token.length > 0) headers['authorization'] = `Bearer ${config.token}`
  const init: RequestInit = { headers, signal: requestSignal(config.timeoutMs) }
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (cause) {
    throw new RemoteSkillError(`remote skill request failed: ${url}`, { cause })
  }
  if (response.status === 404) return undefined
  if (!response.ok) throw new RemoteSkillError(`HTTP ${response.status} from remote skill resolver: ${url}`)
  let payload: unknown
  try {
    payload = await response.json()
  } catch (cause) {
    throw new RemoteSkillError(`invalid JSON from remote skill resolver: ${url}`, { cause })
  }
  return parseResolverPayload(payload)
}

/**
 * Download the skill archive bytes from a presigned URL. The resolver's bearer
 * token is intentionally NOT forwarded — the download host is a different
 * origin and the URL is already authorized by its signature.
 * @param downloadUrl - the presigned archive URL from the resolver.
 * @param timeoutMs - optional request timeout.
 * @returns the raw archive bytes.
 * @throws {RemoteSkillError} on a network failure or a non-2xx response.
 */
export async function downloadSkillArchive(downloadUrl: string, timeoutMs?: number): Promise<Uint8Array> {
  const init: RequestInit = { signal: requestSignal(timeoutMs) }
  let response: Response
  try {
    response = await fetch(downloadUrl, init)
  } catch (cause) {
    throw new RemoteSkillError(`skill archive download failed: ${downloadUrl}`, { cause })
  }
  if (!response.ok) throw new RemoteSkillError(`HTTP ${response.status} downloading skill archive`)
  const buffer = await response.arrayBuffer()
  return new Uint8Array(buffer)
}
