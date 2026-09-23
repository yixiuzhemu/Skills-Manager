/**
 * The client's typed transport over the host HTTP seam. Every call targets the
 * `prefix` route the host registers at {@link API_PREFIX} and unwraps the
 * `{ ok, data }` / `{ ok, code, error }` envelope the host always returns.
 * Mutations carry the `x-dsh-skills-manager` marker and a JSON content type so
 * the host accepts them; reads are plain `GET`s.
 *
 * The wire shapes come from `./wire.ts`, the client-local mirror of the host
 * vocabulary (kept host-side-free so no Cordis augmentation enters the browser
 * bundle); `CompanySkillEntry` is defined here because its host definition lives
 * in a Node-only module.
 *
 * @module @dsh-skills-manager/dsh-skills-manager/client/api
 */

import type {
  CompanySkillSource,
  DiffResult,
  RepoConfig,
  RepoSkillItem,
  SkillRecord,
  TrashRecord,
  UpdateInfo,
} from './wire.ts'

/** Absolute prefix the host route is registered under. */
export const API_PREFIX = '/api/skills-manager'

/** Headers every mutation must carry to pass the host's marker + content-type check. */
const MUTATION_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'x-dsh-skills-manager': '1',
}

/** One company-source advertised skill (host `github.ts` shape, restated client-side). */
export interface CompanySkillEntry {
  name: string
  description: string
  rawUrl: string
  version?: string
}

/** The combined opening snapshot the panel renders from. */
export interface Snapshot {
  skills: SkillRecord[]
  trash: TrashRecord[]
  repos: RepoConfig[]
  company: CompanySkillSource[]
}

/** A host-reported failure, surfaced to the UI as a thrown {@link ApiError}. */
export class ApiError extends Error {
  /** Stable machine code from the host envelope (`action`, `forbidden`, …). */
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

/** Unwrap one response envelope into its data, or throw an {@link ApiError}. */
async function unwrap<T>(response: Response): Promise<T> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ApiError('nonJson', `non-JSON response (HTTP ${response.status})`)
  }
  const envelope = payload as { ok?: boolean; data?: T; code?: string; error?: string }
  if (!response.ok || envelope.ok === false) {
    throw new ApiError(envelope.code ?? 'error', envelope.error ?? `request failed (HTTP ${response.status})`)
  }
  return (envelope.data ?? null) as T
}

/** Issue a read-only `GET`, optionally with query parameters. */
function get<T>(path: string, query?: Record<string, string>): Promise<T> {
  const suffix = query !== undefined ? `?${new URLSearchParams(query).toString()}` : ''
  return fetch(`${API_PREFIX}${path}${suffix}`).then(response => unwrap<T>(response))
}

/** Issue a mutating `POST` with a JSON body. */
function post<T>(path: string, body?: unknown): Promise<T> {
  return fetch(`${API_PREFIX}${path}`, {
    method: 'POST',
    headers: MUTATION_HEADERS,
    body: JSON.stringify(body ?? {}),
  }).then(response => unwrap<T>(response))
}

/** The full typed API surface the panel consumes. */
export const api = {
  // reads
  state: (): Promise<Snapshot> => get<Snapshot>('/state'),
  content: (id: string): Promise<string | undefined> => get<string | undefined>('/content', { id }),
  repoSkills: (id: string): Promise<RepoSkillItem[]> => get<RepoSkillItem[]>('/repos/skills', { id }),
  companySkills: (id: string): Promise<CompanySkillEntry[]> => get<CompanySkillEntry[]>('/company/skills', { id }),
  updates: (): Promise<UpdateInfo[]> => get<UpdateInfo[]>('/updates'),
  diff: (id: string): Promise<DiffResult | undefined> => get<DiffResult | undefined>('/diff', { id }),
  // skill mutations
  refresh: (): Promise<void> => post<void>('/refresh'),
  enable: (id: string, enabled: boolean): Promise<void> => post<void>('/enable', { id, enabled }),
  remove: (id: string): Promise<void> => post<void>('/delete', { id }),
  create: (name: string, description: string, content: string): Promise<SkillRecord> =>
    post<SkillRecord>('/create', { name, description, content }),
  importFromPath: (sourcePath: string, type: 'zip' | 'folder' | 'file'): Promise<SkillRecord> =>
    post<SkillRecord>('/import', { sourcePath, type }),
  // trash mutations
  restore: (trashId: string): Promise<void> => post<void>('/restore', { trashId }),
  purge: (trashId: string): Promise<void> => post<void>('/purge', { trashId }),
  emptyTrash: (): Promise<void> => post<void>('/empty-trash'),
  // repository mutations
  addRepo: (url: string, branch: string): Promise<RepoConfig> => post<RepoConfig>('/repos/add', { url, branch }),
  removeRepo: (id: string): Promise<void> => post<void>('/repos/remove', { id }),
  refreshRepo: (id: string): Promise<RepoSkillItem[]> => post<RepoSkillItem[]>('/repos/refresh', { id }),
  installRepoSkill: (repoId: string, path: string): Promise<SkillRecord> =>
    post<SkillRecord>('/repos/install', { repoId, path }),
  // company mutations
  addCompany: (source: Omit<CompanySkillSource, 'id'>): Promise<CompanySkillSource> =>
    post<CompanySkillSource>('/company/add', { source }),
  removeCompany: (id: string): Promise<void> => post<void>('/company/remove', { id }),
  syncCompany: (id: string): Promise<CompanySkillEntry[]> => post<CompanySkillEntry[]>('/company/sync', { id }),
  installCompanySkill: (sourceId: string, name: string): Promise<SkillRecord> =>
    post<SkillRecord>('/company/install', { sourceId, name }),
  // updates
  applyUpdate: (id: string): Promise<void> => post<void>('/update', { id }),
}
