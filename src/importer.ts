/**
 * Skill import and creation. Materializes a managed copy of a skill under
 * `~/.dsh/skills-manager/managed/<id>/` from three shapes — a directory holding
 * a `SKILL.md`, a lone markdown file, or a zip archive — plus authoring a brand
 * new skill from a name/description/body. Every path returns the resulting
 * {@link SkillRecord}; persistence and event emission belong to the caller.
 *
 * @module @dsh-skills-manager/dsh-skills-manager/importer
 */

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import type { CreateParams, ImportParams, SkillRecord } from './types.ts'
import { pathExists, readTextFile, writeTextFile } from './file-store.ts'
import { parseSkillFile, readVersion, serializeSkillFile, skillId, toKebabCase, SKILL_FILE } from './skill-file.ts'

/** Thrown when an import source is missing, malformed, or holds no SKILL.md. */
export class ImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportError'
  }
}

/** The managed directory a skill id lives in under the managed root. */
export function managedDirFor(managedRoot: string, id: string): string {
  return join(managedRoot, id)
}

/** Build a managed record from an already-materialized managed directory. */
function managedRecord(
  id: string,
  originPath: string,
  managedDir: string,
  raw: string,
  fallbackName: string,
): SkillRecord {
  const parsed = parseSkillFile(raw, fallbackName)
  const version = readVersion(parsed.frontmatter)
  const now = Date.now()
  return {
    id,
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    source: 'managed',
    enabled: true,
    originPath,
    managedPath: managedDir,
    frontmatter: parsed.frontmatter,
    importedAt: now,
    updatedAt: now,
    ...(version !== undefined ? { version } : {}),
  }
}

/** Import a directory that directly holds a SKILL.md by copying it wholesale. */
async function importFolder(sourcePath: string, managedRoot: string): Promise<SkillRecord> {
  const abs = resolve(sourcePath)
  const skillFile = join(abs, SKILL_FILE)
  const raw = await readTextFile(skillFile)
  if (raw === undefined) throw new ImportError(`no ${SKILL_FILE} found in folder: ${abs}`)
  const id = skillId('managed', abs)
  const managedDir = managedDirFor(managedRoot, id)
  await mkdir(managedDir, { recursive: true })
  // Copy every sibling resource alongside the manifest, overwriting a prior import.
  await cp(abs, managedDir, { recursive: true, force: true })
  return managedRecord(id, skillFile, managedDir, raw, dirname(abs))
}

/** Import a single markdown file as a standalone managed skill. */
async function importFile(sourcePath: string, managedRoot: string): Promise<SkillRecord> {
  const abs = resolve(sourcePath)
  const raw = await readTextFile(abs)
  if (raw === undefined) throw new ImportError(`file not found: ${abs}`)
  const id = skillId('managed', abs)
  const managedDir = managedDirFor(managedRoot, id)
  const skillFile = join(managedDir, SKILL_FILE)
  await writeTextFile(skillFile, raw)
  const fallback = toKebabCase(dirname(abs)) || 'skill'
  return managedRecord(id, abs, managedDir, raw, fallback)
}

/** Import a zip archive, extracting the subtree rooted at its SKILL.md. */
async function importZip(sourcePath: string, managedRoot: string): Promise<SkillRecord> {
  const abs = resolve(sourcePath)
  if (!pathExists(abs)) throw new ImportError(`archive not found: ${abs}`)
  const zip = await JSZip.loadAsync(await readFile(abs))
  const filePaths = Object.keys(zip.files).filter(name => zip.files[name]?.dir !== true)
  const manifest = filePaths.find(name => name === SKILL_FILE)
    ?? filePaths.find(name => name.endsWith(`/${SKILL_FILE}`))
  if (manifest === undefined) throw new ImportError(`no ${SKILL_FILE} inside archive: ${abs}`)
  const base = manifest === SKILL_FILE ? '' : manifest.slice(0, manifest.length - SKILL_FILE.length)

  const id = skillId('managed', abs)
  const managedDir = managedDirFor(managedRoot, id)
  await mkdir(managedDir, { recursive: true })

  let rawManifest: string | undefined
  for (const name of filePaths) {
    if (!name.startsWith(base)) continue
    const relative = name.slice(base.length)
    if (relative.length === 0) continue
    const entry = zip.files[name]
    if (entry === undefined) continue
    const target = join(managedDir, relative)
    const bytes = await entry.async('uint8array')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
    if (relative === SKILL_FILE) rawManifest = new TextDecoder().decode(bytes)
  }
  if (rawManifest === undefined) throw new ImportError(`failed to extract ${SKILL_FILE} from: ${abs}`)
  return managedRecord(id, abs, managedDir, rawManifest, toKebabCase(base) || 'skill')
}

/**
 * Import a skill from a zip archive, a directory, or a single file.
 * @param params - the source path and its shape.
 * @param managedRoot - absolute managed-copy root directory.
 * @returns the record for the newly materialized managed skill.
 * @throws {ImportError} when the source is missing or holds no SKILL.md.
 */
export async function importSkill(params: ImportParams, managedRoot: string): Promise<SkillRecord> {
  switch (params.type) {
    case 'folder':
      return importFolder(params.sourcePath, managedRoot)
    case 'file':
      return importFile(params.sourcePath, managedRoot)
    case 'zip':
      return importZip(params.sourcePath, managedRoot)
    default:
      throw new ImportError(`unsupported import type: ${String(params.type)}`)
  }
}

/**
 * Author a new managed skill from a name, description, and markdown body.
 * @param params - the new skill's fields.
 * @param managedRoot - absolute managed-copy root directory.
 * @returns the record for the created skill.
 * @throws {ImportError} when the name normalizes to an empty identifier.
 */
export async function createSkill(params: CreateParams, managedRoot: string): Promise<SkillRecord> {
  const name = toKebabCase(params.name)
  if (name.length === 0) throw new ImportError('skill name must contain at least one alphanumeric character')
  const id = skillId('managed', `created:${name}`)
  const managedDir = managedDirFor(managedRoot, id)
  const skillFile = join(managedDir, SKILL_FILE)
  const raw = serializeSkillFile({ name, description: params.description }, params.content)
  await writeTextFile(skillFile, raw)
  return managedRecord(id, skillFile, managedDir, raw, name)
}
