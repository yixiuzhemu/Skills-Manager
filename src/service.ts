/**
 * The Skills-Manager host service: the orchestration core that owns the
 * persistent registry, trash bin, repository list, and company sources, and
 * exposes every management operation to the (future) client over the Typert
 * remote seam. It reconciles freshly scanned skills against persisted enable
 * state, materializes managed copies under `~/.dsh/skills-manager/`, soft-deletes
 * into a retention-bounded trash, and registers a `ctx.skills` provider so every
 * enabled skill becomes live for the harness. Pure discovery, import, diff, and
 * remote-fetch logic lives in sibling modules; this file only sequences them,
 * persists results, and announces commits through Cordis events.
 *
 * @module @dsh-skills-manager/dsh-skills-manager/service
 */

import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SkillCandidate, SkillDefinition, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type {
  CompanySkillSource,
  CreateParams,
  DiffResult,
  ImportParams,
  RepoConfig,
  RepoSkillItem,
  SkillRecord,
  TrashRecord,
  UpdateInfo,
} from './types.ts'
import { JsonFileStore, ensureDir, getBaseDir, pathExists, readTextFile, writeTextFile } from './file-store.ts'
import { parseSkillFile, readVersion, serializeSkillFile, skillId, toKebabCase, SKILL_FILE } from './skill-file.ts'
import { discoverSkills, type ScanPlan } from './scanner.ts'
import { createSkill as createManagedSkill, importSkill as importManagedSkill, managedDirFor } from './importer.ts'
import { computeDiff } from './diff.ts'
import {
  downloadRepoSkillDir,
  fetchCompanySkillContent,
  fetchCompanySkills,
  listRepoSkillItems,
  parseGitHubUrl,
  RemoteSourceError,
  type CompanySkillEntry,
  type RemoteOptions,
} from './github.ts'

/** Cordis service key and Typert wire namespace (segment grammar forbids `/`). */
const SERVICE_KEY = 'skillsManager'
/** Provider name registered into the `ctx.skills` registry. */
const PROVIDER_NAME = 'skills-manager'
/** Precedence rank; lower wins, so managed skills outrank bundled defaults (600). */
const PROVIDER_RANK = 400
/** One day in milliseconds, used for trash retention math. */
const DAY_MS = 86_400_000

/** Resolved plugin configuration handed to {@link SkillsManager}. */
export interface SkillsManagerConfig {
  /** Project root scanned as the `project` source. */
  projectRoot: string
  /** Extra directories scanned as the `local` source. */
  extraDirs: string[]
  /** Per-agent skill directory overrides; empty falls back to the agent default. */
  agentRoots: { codex: string; claude: string; copilot: string }
  /** GitHub REST API base. */
  githubApiBase: string
  /** GitHub raw content base. */
  githubRawBase: string
  /** Optional bearer token for authenticated remote requests. */
  githubToken: string
  /** Days a trashed skill is retained before automatic purge. */
  trashRetentionDays: number
  /** Whether to run a discovery scan during startup. */
  scanOnStart: boolean
}

/** Persisted registry document: the merged skill list plus hidden discovered ids. */
interface RegistryDoc {
  skills: SkillRecord[]
  hidden: string[]
}

/** Persisted trash document. */
interface TrashDoc {
  entries: TrashRecord[]
}

/** Persisted repository document, caching each repo's last-listed skills. */
interface ReposDoc {
  repos: RepoConfig[]
  cache: Record<string, RepoSkillItem[]>
}

/** Persisted company-source document, caching each source's synced entries. */
interface CompanyDoc {
  sources: CompanySkillSource[]
  cache: Record<string, CompanySkillEntry[]>
}

/**
 * Host-side skills manager. Extends {@link TypertRemoteService} so its public,
 * `@Remote`-decorated methods are discoverable by the Typert Gateway once the
 * client half is wired; today the markers are inert but forward-compatible.
 */
export class SkillsManager extends TypertRemoteService {
  private readonly options: SkillsManagerConfig
  private readonly registry: JsonFileStore<RegistryDoc>
  private readonly trash: JsonFileStore<TrashDoc>
  private readonly repos: JsonFileStore<ReposDoc>
  private readonly company: JsonFileStore<CompanyDoc>
  /** Lifecycle control for the registered skill provider, used to invalidate catalogs. */
  private providerControl: SkillProviderControl | undefined
  /** Absolute root of managed skill copies. */
  readonly managedRoot: string
  /** Absolute root of trashed skill copies. */
  readonly trashRoot: string

  constructor(ctx: Context, options: SkillsManagerConfig) {
    super(ctx, SERVICE_KEY)
    this.options = options
    this.managedRoot = join(getBaseDir(), 'managed')
    this.trashRoot = join(getBaseDir(), 'trash')
    this.registry = new JsonFileStore<RegistryDoc>('registry.json', () => ({ skills: [], hidden: [] }), () => this.invalidateProvider())
    this.trash = new JsonFileStore<TrashDoc>('trash.json', () => ({ entries: [] }))
    this.repos = new JsonFileStore<ReposDoc>('repos.json', () => ({ repos: [], cache: {} }))
    this.company = new JsonFileStore<CompanyDoc>('company.json', () => ({ sources: [], cache: {} }))
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Open every store, ensure data directories, purge expired trash, and scan. */
  async start(): Promise<void> {
    await this.registry.start()
    await this.trash.start()
    await this.repos.start()
    await this.company.start()
    await ensureDir('managed')
    await ensureDir('trash')
    await this.cleanupExpiredTrash()
    if (this.options.scanOnStart) await this.refresh()
  }

  /** Stop watching every backing document. */
  stop(): void {
    this.registry.stop()
    this.trash.stop()
    this.repos.stop()
    this.company.stop()
  }

  // ── Skill provider (ctx.skills integration) ───────────────────────────────

  /**
   * Build the `ctx.skills` provider backed by this manager's enabled records.
   * Called synchronously during plugin apply; the returned provider lists the
   * live catalog and loads bodies on demand.
   * @param control - registration-scoped invalidation control.
   */
  createProvider(control: SkillProviderControl): SkillProvider {
    this.providerControl = control
    return {
      name: PROVIDER_NAME,
      list: async (): Promise<readonly SkillCandidate[]> =>
        this.listEnabled().map(record => this.toCandidate(record)),
      get: async (candidate: SkillCandidate): Promise<SkillDefinition | undefined> =>
        this.loadDefinition(candidate),
    }
  }

  /** The enabled, non-hidden records the provider advertises. */
  listEnabled(): SkillRecord[] {
    const hidden = new Set(this.registry.data.hidden)
    return this.registry.data.skills.filter(record => record.enabled && !hidden.has(record.id))
  }

  /** Translate a registry record into a skill-registry candidate. */
  private toCandidate(record: SkillRecord): SkillCandidate {
    const base = dirname(record.managedPath ?? record.originPath)
    return {
      name: record.name,
      description: record.description,
      ...(record.frontmatter.whenToUse !== undefined ? { whenToUse: record.frontmatter.whenToUse } : {}),
      invocation: {
        modelInvocable: record.frontmatter.disableModelInvocation !== true,
        userInvocable: record.frontmatter.userInvocable !== false,
      },
      source: record.source,
      provider: PROVIDER_NAME,
      rank: PROVIDER_RANK,
      locator: record.id,
      path: record.originPath,
      resourceBase: { kind: 'directory', path: base },
      ...(record.frontmatter.metadata !== undefined ? { metadata: record.frontmatter.metadata } : {}),
    }
  }

  /** Load a candidate's full body from its managed/original SKILL.md. */
  private async loadDefinition(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
    const id = typeof candidate.locator === 'string' ? candidate.locator : undefined
    const record = id !== undefined ? this.findRecord(id) : undefined
    if (record === undefined) return undefined
    const raw = await readTextFile(record.originPath)
    if (raw === undefined) return undefined
    const parsed = parseSkillFile(raw, record.name)
    return {
      name: record.name,
      description: record.description,
      ...(parsed.frontmatter.whenToUse !== undefined ? { whenToUse: parsed.frontmatter.whenToUse } : {}),
      invocation: {
        modelInvocable: parsed.frontmatter.disableModelInvocation !== true,
        userInvocable: parsed.frontmatter.userInvocable !== false,
      },
      source: record.source,
      provider: PROVIDER_NAME,
      ...(record.managedPath !== undefined ? { resourceBase: { kind: 'directory', path: record.managedPath } } : {}),
      content: parsed.content,
      path: record.originPath,
      ...(parsed.frontmatter.metadata !== undefined ? { metadata: parsed.frontmatter.metadata } : {}),
    }
  }

  // ── Core operations ───────────────────────────────────────────────────────

  /** Every tracked skill record (enabled or not), excluding hidden discoveries. */
  @Remote
  listSkills(): SkillRecord[] {
    const hidden = new Set(this.registry.data.hidden)
    return this.registry.data.skills.filter(record => !hidden.has(record.id))
  }

  /** One record by id, or undefined when absent. */
  findRecord(id: string): SkillRecord | undefined {
    return this.registry.data.skills.find(record => record.id === id)
  }

  /** The raw SKILL.md content behind a record, for preview/edit surfaces. */
  @Remote
  async getSkillContent(id: string): Promise<string | undefined> {
    const record = this.findRecord(id)
    if (record === undefined) return undefined
    return readTextFile(record.originPath)
  }

  /** Re-scan every discovery root and reconcile against persisted enable state. */
  @Remote
  async refresh(): Promise<void> {
    const discovered = await discoverSkills(this.scanPlan())
    const persisted = this.registry.data.skills
    const hidden = this.registry.data.hidden
    const overrides = new Map(persisted.map(record => [record.id, record]))
    const merged = new Map<string, SkillRecord>()
    // Persisted installs (managed/repo/company) are authoritative and always kept.
    for (const record of persisted) {
      if (record.source === 'managed' || record.source === 'repo' || record.source === 'company') {
        merged.set(record.id, record)
      }
    }
    // Fresh discoveries inherit any prior enable flag unless the user hid them.
    for (const record of discovered) {
      if (hidden.includes(record.id)) continue
      const prev = overrides.get(record.id)
      merged.set(record.id, prev !== undefined ? { ...record, enabled: prev.enabled } : record)
    }
    await this.registry.save({ skills: [...merged.values()], hidden })
    this.emitChanged()
  }

  /** Import a skill from a zip archive, folder, or single file. */
  @Remote
  async importSkill(params: ImportParams): Promise<SkillRecord> {
    const record = await importManagedSkill(params, this.managedRoot)
    await this.upsertRecord(record)
    return record
  }

  /** Author a brand-new managed skill. */
  @Remote
  async createSkill(params: CreateParams): Promise<SkillRecord> {
    const record = await createManagedSkill(params, this.managedRoot)
    await this.upsertRecord(record)
    return record
  }

  /** Enable or disable one skill, updating the live catalog. */
  @Remote
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const skills = this.registry.data.skills.map(record => (record.id === id ? { ...record, enabled } : record))
    await this.registry.save({ skills, hidden: this.registry.data.hidden })
    this.emitChanged()
  }

  /**
   * Soft-delete a skill: move its managed copy (if any) into the trash and hide
   * it from discovery so a rescan will not silently restore it.
   */
  @Remote
  async delete(id: string): Promise<void> {
    const record = this.findRecord(id)
    if (record === undefined) return
    const trashId = skillId('managed', `trash:${id}:${Date.now()}:${Math.random()}`)
    let trashPath = ''
    if (record.managedPath !== undefined && pathExists(record.managedPath)) {
      trashPath = join(this.trashRoot, trashId)
      await mkdir(this.trashRoot, { recursive: true })
      await rename(record.managedPath, trashPath)
    }
    const now = Date.now()
    const entry: TrashRecord = {
      id: trashId,
      originalSkill: record,
      deletedAt: now,
      trashPath,
      expiresAt: now + this.options.trashRetentionDays * DAY_MS,
    }
    const skills = this.registry.data.skills.filter(item => item.id !== id)
    const hidden = this.registry.data.hidden.includes(id) ? this.registry.data.hidden : [...this.registry.data.hidden, id]
    await this.registry.save({ skills, hidden })
    await this.trash.save({ entries: [...this.trash.data.entries, entry] })
    this.emitChanged()
    this.emitTrashChanged()
  }

  // ── Trash ─────────────────────────────────────────────────────────────────

  /** Every trash entry, newest deletion first. */
  @Remote
  listTrash(): TrashRecord[] {
    return [...this.trash.data.entries].sort((a, b) => b.deletedAt - a.deletedAt)
  }

  /** Restore a trashed skill, moving its copy back and un-hiding it. */
  @Remote
  async restore(trashId: string): Promise<void> {
    const entry = this.trash.data.entries.find(item => item.id === trashId)
    if (entry === undefined) return
    const record = entry.originalSkill
    if (entry.trashPath.length > 0 && pathExists(entry.trashPath) && record.managedPath !== undefined) {
      await mkdir(dirname(record.managedPath), { recursive: true })
      await rename(entry.trashPath, record.managedPath)
    }
    const hidden = this.registry.data.hidden.filter(item => item !== record.id)
    const skills = [...this.registry.data.skills.filter(item => item.id !== record.id), record]
    await this.registry.save({ skills, hidden })
    await this.trash.save({ entries: this.trash.data.entries.filter(item => item.id !== trashId) })
    this.emitChanged()
    this.emitTrashChanged()
  }

  /** Permanently delete one trash entry and its physical copy. */
  @Remote
  async purge(trashId: string): Promise<void> {
    const entry = this.trash.data.entries.find(item => item.id === trashId)
    if (entry === undefined) return
    if (entry.trashPath.length > 0) await rm(entry.trashPath, { recursive: true, force: true })
    await this.trash.save({ entries: this.trash.data.entries.filter(item => item.id !== trashId) })
    this.emitTrashChanged()
  }

  /** Permanently delete every trash entry. */
  @Remote
  async emptyTrash(): Promise<void> {
    await rm(this.trashRoot, { recursive: true, force: true })
    await mkdir(this.trashRoot, { recursive: true })
    await this.trash.save({ entries: [] })
    this.emitTrashChanged()
  }

  /** Drop trash entries whose retention window has elapsed. */
  private async cleanupExpiredTrash(): Promise<void> {
    const now = Date.now()
    const expired = this.trash.data.entries.filter(entry => entry.expiresAt !== undefined && entry.expiresAt <= now)
    if (expired.length === 0) return
    for (const entry of expired) {
      if (entry.trashPath.length > 0) await rm(entry.trashPath, { recursive: true, force: true })
    }
    const kept = this.trash.data.entries.filter(entry => !(entry.expiresAt !== undefined && entry.expiresAt <= now))
    await this.trash.save({ entries: kept })
  }

  // ── Repository sources ────────────────────────────────────────────────────

  /** Every configured repository. */
  @Remote
  listRepos(): RepoConfig[] {
    return this.repos.data.repos
  }

  /** Add a GitHub repository as a browsable skill source. */
  @Remote
  async addRepo(url: string, branch = 'main'): Promise<RepoConfig> {
    const ref = parseGitHubUrl(url)
    const config: RepoConfig = {
      id: skillId('repo', url),
      url,
      name: `${ref.owner}/${ref.repo}`,
      branch,
      addedAt: Date.now(),
    }
    const repos = [...this.repos.data.repos.filter(item => item.id !== config.id), config]
    await this.repos.save({ repos, cache: this.repos.data.cache })
    this.emitReposChanged()
    return config
  }

  /** Remove a repository and its cached skill list. */
  @Remote
  async removeRepo(id: string): Promise<void> {
    const cache = { ...this.repos.data.cache }
    delete cache[id]
    await this.repos.save({ repos: this.repos.data.repos.filter(item => item.id !== id), cache })
    this.emitReposChanged()
  }

  /** Re-fetch a repository's skill list over the network and cache it. */
  @Remote
  async refreshRepo(id: string): Promise<RepoSkillItem[]> {
    const repo = this.repos.data.repos.find(item => item.id === id)
    if (repo === undefined) throw new RemoteSourceError(`unknown repository: ${id}`)
    const items = await listRepoSkillItems(parseGitHubUrl(repo.url), repo.branch, this.remoteOptions())
    const cache = { ...this.repos.data.cache, [id]: items }
    const repos = this.repos.data.repos.map(item => (item.id === id ? { ...item, lastFetchedAt: Date.now() } : item))
    await this.repos.save({ repos, cache })
    this.emitReposChanged()
    return items
  }

  /** The cached skill list for a repository (empty until first refresh). */
  @Remote
  listRepoSkills(id: string): RepoSkillItem[] {
    return this.repos.data.cache[id] ?? []
  }

  /** Download one repository skill into the managed store. */
  @Remote
  async installRepoSkill(repoId: string, path: string): Promise<SkillRecord> {
    const repo = this.repos.data.repos.find(item => item.id === repoId)
    if (repo === undefined) throw new RemoteSourceError(`unknown repository: ${repoId}`)
    const files = await downloadRepoSkillDir(parseGitHubUrl(repo.url), repo.branch, path, this.remoteOptions())
    const manifest = files.find(file => file.path === SKILL_FILE)
    if (manifest === undefined) throw new RemoteSourceError(`no ${SKILL_FILE} in repository skill: ${path}`)
    const id = skillId('repo', `${repo.url}#${repo.branch}#${path}`)
    const dir = await this.writeManagedFiles(id, files)
    const fallback = path.length > 0 ? path.slice(path.lastIndexOf('/') + 1) : repo.name
    const parsed = parseSkillFile(manifest.content, fallback.length > 0 ? fallback : 'skill')
    const version = readVersion(parsed.frontmatter)
    const now = Date.now()
    const record: SkillRecord = {
      id,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      source: 'repo',
      enabled: true,
      originPath: join(dir, SKILL_FILE),
      managedPath: dir,
      frontmatter: parsed.frontmatter,
      sourceDetail: { repoUrl: repo.url, repoBranch: repo.branch, repoPath: path },
      importedAt: now,
      updatedAt: now,
      ...(version !== undefined ? { version } : {}),
    }
    await this.upsertRecord(record)
    return record
  }

  // ── Company sources ───────────────────────────────────────────────────────

  /** Every configured company skill source. */
  @Remote
  listCompanySources(): CompanySkillSource[] {
    return this.company.data.sources
  }

  /** The cached entries a company source last synced (empty until first sync). */
  @Remote
  listCompanySkills(id: string): CompanySkillEntry[] {
    return this.company.data.cache[id] ?? []
  }

  /** Register a new company skill source. */
  @Remote
  async addCompanySource(source: Omit<CompanySkillSource, 'id'>): Promise<CompanySkillSource> {
    const record: CompanySkillSource = { ...source, id: skillId('company', `${source.type}:${source.name}:${source.endpoint ?? source.repoUrl ?? ''}`) }
    const sources = [...this.company.data.sources.filter(item => item.id !== record.id), record]
    await this.company.save({ sources, cache: this.company.data.cache })
    return record
  }

  /** Remove a company source and its cached entries. */
  @Remote
  async removeCompanySource(id: string): Promise<void> {
    const cache = { ...this.company.data.cache }
    delete cache[id]
    await this.company.save({ sources: this.company.data.sources.filter(item => item.id !== id), cache })
  }

  /** Sync a company source's advertised skills over the network and cache them. */
  @Remote
  async syncCompanySource(id: string): Promise<CompanySkillEntry[]> {
    const source = this.company.data.sources.find(item => item.id === id)
    if (source === undefined) throw new RemoteSourceError(`unknown company source: ${id}`)
    const options = this.remoteOptions()
    let entries: CompanySkillEntry[]
    if (source.type === 'git' && source.repoUrl !== undefined) {
      const items = await listRepoSkillItems(parseGitHubUrl(source.repoUrl), 'main', options)
      entries = items.map(item => ({
        name: item.name,
        description: item.description,
        rawUrl: item.rawUrl,
        ...(item.frontmatter !== undefined ? { frontmatter: item.frontmatter } : {}),
      }))
    } else {
      entries = await fetchCompanySkills(source, options)
    }
    const cache = { ...this.company.data.cache, [id]: entries }
    const sources = this.company.data.sources.map(item => (item.id === id ? { ...item, lastSyncedAt: Date.now() } : item))
    await this.company.save({ sources, cache })
    return entries
  }

  /** Install one advertised company skill into the managed store. */
  @Remote
  async installCompanySkill(sourceId: string, name: string): Promise<SkillRecord> {
    const source = this.company.data.sources.find(item => item.id === sourceId)
    if (source === undefined) throw new RemoteSourceError(`unknown company source: ${sourceId}`)
    const cached = this.company.data.cache[sourceId]
    const entries = cached ?? await this.syncCompanySource(sourceId)
    const entry = entries.find(item => item.name === name)
    if (entry === undefined) throw new RemoteSourceError(`company skill not found: ${name}`)
    const body = await fetchCompanySkillContent(entry, this.remoteOptions())
    const id = skillId('company', `${sourceId}#${name}`)
    const dir = managedDirFor(this.managedRoot, id)
    const skillFile = join(dir, SKILL_FILE)
    const raw = serializeSkillFile({ name: toKebabCase(entry.name), description: entry.description }, body)
    await writeTextFile(skillFile, raw)
    const parsed = parseSkillFile(raw, name)
    const version = entry.version ?? readVersion(parsed.frontmatter)
    const now = Date.now()
    const record: SkillRecord = {
      id,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      source: 'company',
      enabled: true,
      originPath: skillFile,
      managedPath: dir,
      frontmatter: parsed.frontmatter,
      sourceDetail: { companySourceId: sourceId },
      importedAt: now,
      updatedAt: now,
      ...(version !== undefined ? { version } : {}),
    }
    await this.upsertRecord(record)
    return record
  }

  // ── Updates and diffs ─────────────────────────────────────────────────────

  /** Check every repo-sourced skill against its upstream version. */
  @Remote
  async checkUpdates(): Promise<UpdateInfo[]> {
    const infos: UpdateInfo[] = []
    const options = this.remoteOptions()
    for (const record of this.registry.data.skills) {
      const detail = record.sourceDetail
      if (record.source !== 'repo' || detail?.repoUrl === undefined || detail.repoPath === undefined) continue
      if (record.version === undefined) continue
      try {
        const items = await listRepoSkillItems(parseGitHubUrl(detail.repoUrl), detail.repoBranch ?? 'main', options)
        const match = items.find(item => item.path === detail.repoPath)
        const latest = match?.frontmatter !== undefined ? readVersion(match.frontmatter) : undefined
        if (latest !== undefined && latest !== record.version) {
          infos.push({ skillId: record.id, currentVersion: record.version, latestVersion: latest, hasUpdate: true })
        }
      } catch {
        // An unreachable upstream simply yields no update info for that skill.
      }
    }
    return infos
  }

  /** Diff a repo-sourced skill's managed content against its upstream version. */
  @Remote
  async getDiff(id: string): Promise<DiffResult | undefined> {
    const record = this.findRecord(id)
    const detail = record?.sourceDetail
    if (record === undefined || record.source !== 'repo' || detail?.repoUrl === undefined || detail.repoPath === undefined) {
      return undefined
    }
    const files = await downloadRepoSkillDir(parseGitHubUrl(detail.repoUrl), detail.repoBranch ?? 'main', detail.repoPath, this.remoteOptions())
    const upstream = files.find(file => file.path === SKILL_FILE)?.content
    if (upstream === undefined) return undefined
    const current = await readTextFile(record.originPath)
    if (current === undefined) return undefined
    return computeDiff(current, upstream)
  }

  /** Re-download a repo-sourced skill's upstream files over its managed copy. */
  @Remote
  async applyUpdate(id: string): Promise<void> {
    const record = this.findRecord(id)
    const detail = record?.sourceDetail
    if (record === undefined || record.source !== 'repo' || detail?.repoUrl === undefined || detail.repoPath === undefined) {
      return
    }
    const files = await downloadRepoSkillDir(parseGitHubUrl(detail.repoUrl), detail.repoBranch ?? 'main', detail.repoPath, this.remoteOptions())
    const manifest = files.find(file => file.path === SKILL_FILE)
    if (manifest === undefined) return
    await this.writeManagedFiles(id, files)
    const parsed = parseSkillFile(manifest.content, record.name)
    const version = readVersion(parsed.frontmatter)
    const updated: SkillRecord = {
      ...record,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      frontmatter: parsed.frontmatter,
      updatedAt: Date.now(),
      ...(version !== undefined ? { version } : {}),
    }
    await this.upsertRecord(updated)
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Write a set of managed files under `managed/<id>/`, returning that directory. */
  private async writeManagedFiles(id: string, files: readonly { path: string; content: string }[]): Promise<string> {
    const dir = managedDirFor(this.managedRoot, id)
    for (const file of files) {
      await writeTextFile(join(dir, file.path), file.content)
    }
    return dir
  }

  /** Insert or replace one record in the registry, then announce the change. */
  private async upsertRecord(record: SkillRecord): Promise<void> {
    const skills = [...this.registry.data.skills.filter(item => item.id !== record.id), record]
    const hidden = this.registry.data.hidden.filter(item => item !== record.id)
    await this.registry.save({ skills, hidden })
    this.emitChanged()
  }

  /** Build the discovery plan from resolved configuration. */
  private scanPlan(): ScanPlan {
    return {
      projectRoot: this.options.projectRoot,
      extraDirs: this.options.extraDirs,
      agentRoots: this.options.agentRoots,
    }
  }

  /** Transport options for every remote call, adding the token when present. */
  private remoteOptions(): RemoteOptions {
    return {
      apiBase: this.options.githubApiBase,
      rawBase: this.options.githubRawBase,
      ...(this.options.githubToken.length > 0 ? { token: this.options.githubToken } : {}),
    }
  }

  /** Ask the skill registry to re-collect, then announce a skill-set change. */
  private invalidateProvider(): void {
    this.providerControl?.invalidate()
  }

  private emitChanged(): void {
    this.invalidateProvider()
    this.ctx.emit('skills-manager/changed')
  }

  private emitTrashChanged(): void {
    this.ctx.emit('skills-manager/trash-changed')
  }

  private emitReposChanged(): void {
    this.ctx.emit('skills-manager/repos-changed')
  }
}
