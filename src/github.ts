/**
 * Remote skill sources: GitHub repositories and company skill endpoints. All
 * network access funnels through the platform `fetch`, honoring an abort signal
 * and an optional bearer token. Repository browsing reads the Git trees API to
 * locate `SKILL.md` manifests and the raw host to download a skill's files;
 * company `api` sources read a small JSON contract, and company `git` sources
 * reuse the repository path.
 *
 * @module @dsh-skills-manager/dsh-skills-manager/github
 */

import type { CompanySkillSource, RepoSkillItem, SkillFrontmatter } from './types.ts'
import { parseSkillFile, readVersion, SKILL_FILE } from './skill-file.ts'

/** Thrown when a remote source is unreachable, unauthorized, or malformed. */
export class RemoteSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RemoteSourceError'
  }
}

/** A parsed `owner/repo` reference from a GitHub URL. */
export interface RepoRef {
  owner: string
  repo: string
}

/** Transport options shared by every remote call. */
export interface RemoteOptions {
  /** GitHub REST API base, e.g. `https://api.github.com`. */
  apiBase: string
  /** Raw content base, e.g. `https://raw.githubusercontent.com`. */
  rawBase: string
  /** Optional bearer token for authenticated/higher-limit requests. */
  token?: string
  /** Optional cancellation signal. */
  signal?: AbortSignal
}

/** One skill advertised by a company `api` source. */
export interface CompanySkillEntry {
  name: string
  description: string
  /** Inline body when the endpoint returns it directly. */
  content?: string
  /** Raw download URL when the endpoint references external content. */
  rawUrl?: string
  version?: string
  frontmatter?: SkillFrontmatter
}

/**
 * Parse a GitHub repository URL (https or ssh) into its owner and repo.
 * @param url - the repository URL.
 * @throws {RemoteSourceError} when the URL is not a recognizable GitHub repo.
 */
export function parseGitHubUrl(url: string): RepoRef {
  const trimmed = url.trim().replace(/\.git$/, '')
  const patterns = [
    /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)$/,
    /^git@[^:]+:([^/]+)\/([^/]+)$/,
    /^([^/]+)\/([^/]+)$/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed)
    if (match !== null) {
      const owner = match[1]
      const repo = match[2]
      if (owner !== undefined && repo !== undefined) return { owner, repo }
    }
  }
  throw new RemoteSourceError(`not a recognizable GitHub repository url: ${url}`)
}

/** Build request headers, adding bearer auth when a token is present. */
function headers(options: RemoteOptions, accept: string): Record<string, string> {
  const base: Record<string, string> = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' }
  if (options.token !== undefined && options.token.length > 0) base['Authorization'] = `Bearer ${options.token}`
  return base
}

/** GET a URL and return its text body, throwing a typed error on failure. */
async function fetchText(url: string, options: RemoteOptions, accept: string): Promise<string> {
  const init: RequestInit = { headers: headers(options, accept) }
  if (options.signal !== undefined) init.signal = options.signal
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (cause) {
    throw new RemoteSourceError(`request failed: ${url}`, { cause })
  }
  if (!response.ok) throw new RemoteSourceError(`HTTP ${response.status} for ${url}`)
  return response.text()
}

/** GET a URL and parse its JSON body. */
async function fetchJson(url: string, options: RemoteOptions): Promise<unknown> {
  const text = await fetchText(url, options, 'application/vnd.github+json')
  try {
    return JSON.parse(text) as unknown
  } catch (cause) {
    throw new RemoteSourceError(`invalid JSON from ${url}`, { cause })
  }
}

/** The raw content URL for one repository path. */
export function rawUrl(options: RemoteOptions, ref: RepoRef, branch: string, path: string): string {
  return `${options.rawBase.replace(/\/$/, '')}/${ref.owner}/${ref.repo}/${branch}/${path}`
}

interface GitTreeEntry {
  path?: string
  type?: string
}

/** Read a repository's recursive file list from the Git trees API. */
async function fetchTreePaths(ref: RepoRef, branch: string, options: RemoteOptions): Promise<string[]> {
  const url = `${options.apiBase.replace(/\/$/, '')}/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  const payload = await fetchJson(url, options) as { tree?: GitTreeEntry[] }
  if (!Array.isArray(payload.tree)) throw new RemoteSourceError(`unexpected tree payload from ${url}`)
  return payload.tree
    .filter((entry): entry is GitTreeEntry => entry.type === 'blob' && typeof entry.path === 'string')
    .map(entry => entry.path as string)
}

/** The directory holding a SKILL.md path, or '' for a repo-root manifest. */
function skillDirOf(manifestPath: string): string {
  const index = manifestPath.lastIndexOf('/')
  return index === -1 ? '' : manifestPath.slice(0, index)
}

/**
 * List the skills discoverable in a repository by locating every `SKILL.md`
 * and reading its frontmatter for the description.
 * @param ref - the parsed repository reference.
 * @param branch - the branch to read.
 * @param options - transport options.
 * @returns one item per discovered skill directory.
 */
export async function listRepoSkillItems(ref: RepoRef, branch: string, options: RemoteOptions): Promise<RepoSkillItem[]> {
  const paths = await fetchTreePaths(ref, branch, options)
  const manifests = paths.filter(path => path === SKILL_FILE || path.endsWith(`/${SKILL_FILE}`))
  const items: RepoSkillItem[] = []
  for (const manifest of manifests) {
    const dir = skillDirOf(manifest)
    const fallbackName = dir.length > 0 ? dir.slice(dir.lastIndexOf('/') + 1) : ref.repo
    let frontmatter: SkillFrontmatter | undefined
    try {
      const raw = await fetchText(rawUrl(options, ref, branch, manifest), options, 'text/plain')
      frontmatter = parseSkillFile(raw, fallbackName).frontmatter
    } catch {
      // A manifest that cannot be read still lists, just without frontmatter.
    }
    const name = frontmatter?.name ?? fallbackName
    const description = frontmatter?.description ?? ''
    items.push({
      name,
      description,
      path: dir,
      rawUrl: rawUrl(options, ref, branch, manifest),
      ...(frontmatter !== undefined ? { frontmatter } : {}),
    })
  }
  return items
}

/** One downloaded file: its repo-relative path and text content. */
export interface DownloadedFile {
  path: string
  content: string
}

/**
 * Download every text file under one repository skill directory.
 * @param ref - the parsed repository reference.
 * @param branch - the branch to read.
 * @param dir - the skill directory (repo-relative; '' for the repo root).
 * @param options - transport options.
 * @returns the downloaded files with paths relative to the skill directory.
 */
export async function downloadRepoSkillDir(ref: RepoRef, branch: string, dir: string, options: RemoteOptions): Promise<DownloadedFile[]> {
  const paths = await fetchTreePaths(ref, branch, options)
  const prefix = dir.length > 0 ? `${dir}/` : ''
  const members = paths.filter(path => path.startsWith(prefix))
  const files: DownloadedFile[] = []
  for (const path of members) {
    const content = await fetchText(rawUrl(options, ref, branch, path), options, 'text/plain')
    files.push({ path: path.slice(prefix.length), content })
  }
  return files
}

/**
 * Fetch a company `api` source's advertised skills. The endpoint is expected to
 * return either a bare array or an object with a `skills` array.
 * @param source - the company source configuration.
 * @param options - transport options.
 * @returns the advertised skill entries.
 * @throws {RemoteSourceError} when the source has no endpoint or returns an unexpected shape.
 */
export async function fetchCompanySkills(source: CompanySkillSource, options: RemoteOptions): Promise<CompanySkillEntry[]> {
  if (source.endpoint === undefined || source.endpoint.length === 0) {
    throw new RemoteSourceError(`company source "${source.name}" has no endpoint`)
  }
  const payload = await fetchJson(source.endpoint, options)
  const list = Array.isArray(payload)
    ? payload
    : (payload !== null && typeof payload === 'object' && Array.isArray((payload as { skills?: unknown }).skills)
      ? (payload as { skills: unknown[] }).skills
      : undefined)
  if (list === undefined) throw new RemoteSourceError(`unexpected company payload from ${source.endpoint}`)
  const entries: CompanySkillEntry[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const name = typeof record['name'] === 'string' ? record['name'] : ''
    if (name.length === 0) continue
    const description = typeof record['description'] === 'string' ? record['description'] : ''
    const content = typeof record['content'] === 'string' ? record['content'] : undefined
    const url = typeof record['rawUrl'] === 'string' ? record['rawUrl'] : undefined
    const version = typeof record['version'] === 'string' ? record['version'] : undefined
    entries.push({
      name,
      description,
      ...(content !== undefined ? { content } : {}),
      ...(url !== undefined ? { rawUrl: url } : {}),
      ...(version !== undefined ? { version } : {}),
    })
  }
  return entries
}

/**
 * Download a company skill entry's content, preferring inline content and
 * falling back to its raw URL.
 * @param entry - the advertised entry.
 * @param options - transport options.
 * @returns the skill body text.
 * @throws {RemoteSourceError} when neither inline content nor a URL is available.
 */
export async function fetchCompanySkillContent(entry: CompanySkillEntry, options: RemoteOptions): Promise<string> {
  if (entry.content !== undefined) return entry.content
  if (entry.rawUrl !== undefined && entry.rawUrl.length > 0) {
    return fetchText(entry.rawUrl, options, 'text/plain')
  }
  throw new RemoteSourceError(`company skill "${entry.name}" has no downloadable content`)
}
