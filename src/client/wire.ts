/**
 * Client-local copies of the host wire vocabulary. The host `src/types.ts`
 * carries a `declare module '@deepseek-ai/cordis'` event augmentation that the
 * browser program must not pull in, so the panel restates the pure data shapes
 * it renders here. These mirror the host interfaces field-for-field; the host
 * remains the source of truth and the two are kept in sync by hand.
 *
 * @module @dsh-skills-manager/dsh-skills-manager/client/wire
 */

/** Where a skill was discovered or installed from. */
export type SkillSource =
  | 'local'
  | 'project'
  | 'dsh-global'
  | 'managed'
  | 'repo'
  | 'company'
  | 'codex'
  | 'claude'
  | 'copilot'

/** Parsed YAML frontmatter from a SKILL.md file. */
export interface SkillFrontmatter {
  name: string
  description: string
  whenToUse?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  metadata?: Record<string, unknown>
}

/** Additional metadata about where a skill came from. */
export interface SourceDetail {
  repoUrl?: string
  repoBranch?: string
  repoPath?: string
  agentType?: 'codex' | 'claude' | 'copilot' | 'dsh'
  projectPath?: string
  companySourceId?: string
}

/** One managed or discovered skill as the registry tracks it. */
export interface SkillRecord {
  id: string
  name: string
  description: string
  source: SkillSource
  enabled: boolean
  originPath: string
  managedPath?: string
  frontmatter: SkillFrontmatter
  sourceDetail?: SourceDetail
  importedAt?: number
  updatedAt?: number
  version?: string
}

/** One entry in the trash bin, wrapping the original skill record. */
export interface TrashRecord {
  id: string
  originalSkill: SkillRecord
  deletedAt: number
  trashPath: string
  expiresAt?: number
}

/** A configured GitHub repository for browsing and installing skills. */
export interface RepoConfig {
  id: string
  url: string
  name: string
  branch: string
  addedAt: number
  lastFetchedAt?: number
}

/** One skill discovered inside a repository. */
export interface RepoSkillItem {
  name: string
  description: string
  path: string
  rawUrl: string
  frontmatter?: SkillFrontmatter
}

/** A configured company skill management endpoint. */
export interface CompanySkillSource {
  id: string
  name: string
  type: 'api' | 'git'
  endpoint?: string
  repoUrl?: string
  authType?: 'none' | 'token'
  lastSyncedAt?: number
}

/** Information about an available update for one skill. */
export interface UpdateInfo {
  skillId: string
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
}

/** A unified diff result between two versions of a skill. */
export interface DiffResult {
  oldContent: string
  newContent: string
  hunks: DiffHunk[]
}

/** One hunk in a unified diff. */
export interface DiffHunk {
  oldStart: number
  newStart: number
  oldLines: number
  newLines: number
  lines: DiffLine[]
}

/** One line in a diff hunk. */
export interface DiffLine {
  type: 'add' | 'remove' | 'context'
  content: string
  oldLineNo?: number
  newLineNo?: number
}
