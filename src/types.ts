/**
 * Wire vocabulary for the Skills-Manager plugin: skill records, trash entries,
 * repository configurations, company skill sources, update metadata, and the
 * Cordis events that announce changes so configuration surfaces refresh
 * without polling.
 *
 * @module @dsh-skills-manager/dsh-skills-manager/types
 */

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The managed skill set changed: a skill was imported, deleted, enabled,
     * disabled, or restored from trash. This payload-free notification fires
     * at each commit point; consumers re-read the registry's `listSkills()`
     * for the new state. Observer failures are contained and cannot veto the
     * registry mutation.
     * @mode emit
     */
    'skills-manager/changed'(): void
    /**
     * The trash bin changed: a skill was trashed, restored, or permanently
     * deleted. Consumers re-read `listTrash()` for the new state.
     * @mode emit
     */
    'skills-manager/trash-changed'(): void
    /**
     * A repository was added, removed, or its skill list was refreshed.
     * @mode emit
     */
    'skills-manager/repos-changed'(): void
  }
}

// ── Skill source types ──────────────────────────────────────────────────────

/** Where a skill was discovered or installed from. */
export type SkillSource =
  | 'local'          // Scanned from local machine (non-DSH directories)
  | 'project'        // Current project
  | 'dsh-global'     // DSH global (~/.dsh/skills/)
  | 'managed'        // Managed by this plugin (imported/created)
  | 'repo'           // Installed from a repository
  | 'company'        // Installed from a company skill source
  | 'codex'          // Codex Agent
  | 'claude'         // Claude Code
  | 'copilot'        // Copilot Agent

// ── Skill frontmatter ───────────────────────────────────────────────────────

/** Parsed YAML frontmatter from a SKILL.md file. */
export interface SkillFrontmatter {
  name: string
  description: string
  whenToUse?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  metadata?: Record<string, unknown>
}

// ── Source detail ───────────────────────────────────────────────────────────

/** Additional metadata about where a skill came from. */
export interface SourceDetail {
  repoUrl?: string
  repoBranch?: string
  /** Repository-relative skill directory, used to re-locate upstream for updates/diffs. */
  repoPath?: string
  agentType?: 'codex' | 'claude' | 'copilot' | 'dsh'
  projectPath?: string
  companySourceId?: string
}

// ── Skill record ────────────────────────────────────────────────────────────

/** One managed or discovered skill as the registry tracks it. */
export interface SkillRecord {
  /** Unique identifier: hash of source::relativePath. */
  id: string
  /** Skill name in kebab-case. */
  name: string
  /** Human-readable description from frontmatter. */
  description: string
  /** Where this skill was discovered or installed from. */
  source: SkillSource
  /** Whether this skill is currently active. */
  enabled: boolean
  /** Original file path (read-only reference, never modified). */
  originPath: string
  /** Path to the managed copy, if one exists. */
  managedPath?: string
  /** Parsed YAML frontmatter. */
  frontmatter: SkillFrontmatter
  /** Additional source metadata. */
  sourceDetail?: SourceDetail
  /** Timestamp when this skill was imported. */
  importedAt?: number
  /** Timestamp of the last update. */
  updatedAt?: number
  /** Version string from the source. */
  version?: string
}

// ── Trash record ────────────────────────────────────────────────────────────

/** One entry in the trash bin, wrapping the original skill record. */
export interface TrashRecord {
  /** Unique trash entry identifier. */
  id: string
  /** The skill record at the time of deletion. */
  originalSkill: SkillRecord
  /** Timestamp when the skill was moved to trash. */
  deletedAt: number
  /** Physical path in the trash directory. */
  trashPath: string
  /** Expiration timestamp; defaults to 30 days after deletion. */
  expiresAt?: number
}

// ── Repository ──────────────────────────────────────────────────────────────

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

// ── Company skill source ────────────────────────────────────────────────────

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

// ── Update metadata ─────────────────────────────────────────────────────────

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

// ── Import / create parameters ──────────────────────────────────────────────

/** Parameters for importing a skill from a file or directory. */
export interface ImportParams {
  sourcePath: string
  type: 'zip' | 'folder' | 'file'
}

/** Parameters for creating a new skill. */
export interface CreateParams {
  name: string
  description: string
  content: string
}
