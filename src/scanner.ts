/**
 * Multi-source skill discovery. Walks configured filesystem roots — the DSH
 * global skills directory, the current project, per-agent directories (Codex,
 * Claude, Copilot), and any extra user directories — and turns every folder
 * holding a `SKILL.md` into a discovered {@link SkillRecord}. Discovery is
 * read-only: it never writes to a scanned location, and the reconciled enable
 * state lives with the registry service, not here.
 *
 * @module @dsh-skills-manager/dsh-skills-manager/scanner
 */

import { stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import type { SkillRecord, SkillSource } from './types.ts'
import { listDir, pathExists } from './file-store.ts'
import { readSkillDir, readVersion, skillId, toKebabCase, SKILL_FILE } from './skill-file.ts'

/** One filesystem root to scan, tagged with the source bucket it feeds. */
export interface ScanRoot {
  source: SkillSource
  /** Absolute directory to walk; skipped silently when absent. */
  root: string
}

/** Resolved scan configuration handed to {@link discoverSkills}. */
export interface ScanPlan {
  /** The project root treated as the `project` source. */
  projectRoot: string
  /** Extra user directories scanned as the `local` source. */
  extraDirs: readonly string[]
  /** Per-agent override roots; an empty string falls back to the agent default. */
  agentRoots: { codex: string; claude: string; copilot: string }
}

/** Default per-agent skill directories under the user home. */
const DEFAULT_AGENT_ROOTS = {
  codex: ['.codex', 'skills'],
  claude: ['.claude', 'skills'],
  copilot: ['.copilot', 'skills'],
} as const

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Build a discovered record for one skill directory under a scan root. */
async function recordForDir(source: SkillSource, root: string, dir: string): Promise<SkillRecord | undefined> {
  const parsed = await readSkillDir(dir)
  if (parsed === undefined) return undefined
  const ref = relative(root, dir).split(sep).join('/') || toKebabCase(dir)
  const version = readVersion(parsed.frontmatter)
  return {
    id: skillId(source, ref),
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    source,
    enabled: true,
    originPath: join(dir, SKILL_FILE),
    frontmatter: parsed.frontmatter,
    ...(version !== undefined ? { version } : {}),
  }
}

/**
 * Scan one root, matching both a flat layout (each child folder is a skill) and
 * a grouped layout (skills nested one level deeper). The root itself is also
 * probed so a single-skill directory scans directly.
 * @param source - the bucket discovered records are tagged with.
 * @param root - absolute directory to walk.
 * @returns every skill record discovered under the root.
 */
export async function scanRoot(source: SkillSource, root: string): Promise<SkillRecord[]> {
  const abs = resolve(root)
  if (!pathExists(abs) || !(await isDirectory(abs))) return []
  const found: SkillRecord[] = []
  const seen = new Set<string>()

  const push = async (dir: string): Promise<void> => {
    if (seen.has(dir)) return
    const record = await recordForDir(source, abs, dir)
    if (record === undefined || seen.has(record.id)) return
    seen.add(record.id)
    found.push(record)
  }

  // The root may itself be a single skill directory.
  if (pathExists(join(abs, SKILL_FILE))) {
    await push(abs)
    return found
  }

  for (const entry of await listDir(abs)) {
    if (!(await isDirectory(entry))) continue
    if (pathExists(join(entry, SKILL_FILE))) {
      await push(entry)
      continue
    }
    // One nesting level for grouped layouts (e.g. a repo checkout of many skills).
    for (const nested of await listDir(entry)) {
      if (await isDirectory(nested)) await push(nested)
    }
  }
  return found
}

/**
 * Expand a scan plan into the concrete (source, root) pairs to walk, resolving
 * the home-relative agent defaults and skipping empty extra directories.
 * @param plan - the resolved scan configuration.
 * @returns the ordered list of roots to scan.
 */
export function buildScanRoots(plan: ScanPlan): ScanRoot[] {
  const home = homedir()
  const roots: ScanRoot[] = [
    { source: 'dsh-global', root: join(home, '.dsh', 'skills') },
    { source: 'project', root: join(resolve(plan.projectRoot), '.dsh', 'skills') },
  ]
  const agents: [SkillSource, readonly string[], string][] = [
    ['codex', DEFAULT_AGENT_ROOTS.codex, plan.agentRoots.codex],
    ['claude', DEFAULT_AGENT_ROOTS.claude, plan.agentRoots.claude],
    ['copilot', DEFAULT_AGENT_ROOTS.copilot, plan.agentRoots.copilot],
  ]
  for (const [source, fallback, override] of agents) {
    const root = override.length > 0 ? override : join(home, ...fallback)
    roots.push({ source, root })
  }
  for (const dir of plan.extraDirs) {
    if (dir.length > 0) roots.push({ source: 'local', root: resolve(dir) })
  }
  return roots
}

/**
 * Discover skills across every root in a scan plan.
 * @param plan - the resolved scan configuration.
 * @returns all discovered records, de-duplicated by id (first source wins).
 */
export async function discoverSkills(plan: ScanPlan): Promise<SkillRecord[]> {
  const records: SkillRecord[] = []
  const seen = new Set<string>()
  for (const { source, root } of buildScanRoots(plan)) {
    for (const record of await scanRoot(source, root)) {
      if (seen.has(record.id)) continue
      seen.add(record.id)
      records.push(record)
    }
  }
  return records
}
