/**
 * SKILL.md parsing, serialization, and identity helpers shared by the scanner,
 * importer, and the registry service. A skill directory is any folder holding a
 * `SKILL.md` whose optional YAML frontmatter carries the routing metadata; the
 * body after the frontmatter block is the instruction content the model sees.
 *
 * @module @dsh-skills-manager/dsh-skills-manager/skill-file
 */

import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { SkillFrontmatter, SkillSource } from './types.ts'
import { pathExists, readTextFile } from './file-store.ts'

/** The canonical skill manifest filename inside a skill directory. */
export const SKILL_FILE = 'SKILL.md'

/** A parsed SKILL.md: its frontmatter fields plus the raw body content. */
export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter
  /** Markdown body after the frontmatter block (never includes the delimiters). */
  content: string
  /** The raw file text exactly as read, used for diffs and re-serialization. */
  raw: string
}

/**
 * Derive a stable skill identifier from its source and a source-relative ref.
 * The same skill discovered from the same place always hashes to the same id, so
 * re-scans reconcile against persisted records instead of duplicating them.
 * @param source - the discovery or install source bucket.
 * @param ref - source-relative reference (relative path, url, or absolute path).
 * @returns a 16-hex-char identifier.
 */
export function skillId(source: SkillSource, ref: string): string {
  return createHash('sha1').update(`${source}::${ref}`).digest('hex').slice(0, 16)
}

/**
 * Normalize an arbitrary skill name into the public kebab-case grammar.
 * @param name - raw name from frontmatter, a folder name, or user input.
 * @returns a lowercase hyphenated identifier, or an empty string when nothing usable remains.
 */
export function toKebabCase(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Return whether a string is a valid kebab-case skill name.
 * @param name - candidate name.
 */
export function isSkillName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)
}

/**
 * Extract a version string from frontmatter metadata, when one is declared.
 * @param frontmatter - parsed skill frontmatter.
 * @returns the declared version, or undefined when absent/non-string.
 */
export function readVersion(frontmatter: SkillFrontmatter): string | undefined {
  const value = frontmatter.metadata?.['version']
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Split a raw SKILL.md into its YAML frontmatter data and remaining body.
 * A file without a leading `---` block yields `undefined` data and the whole
 * text as content.
 * @param raw - the complete file text.
 * @returns the parsed (untyped) frontmatter data and the body content.
 */
export function splitFrontmatter(raw: string): { data: unknown; content: string } {
  const normalized = raw.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---')) return { data: undefined, content: normalized }
  // The closing fence must sit on its own line; accept CRLF or LF.
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalized)
  if (match === null) return { data: undefined, content: normalized }
  const block = match[1] ?? ''
  const content = normalized.slice(match[0].length)
  try {
    return { data: parseYaml(block), content }
  } catch {
    // Malformed YAML frontmatter degrades to a body-only skill rather than throwing.
    return { data: undefined, content: normalized }
  }
}

/** Coerce an unknown frontmatter value into a plain metadata record. */
function toMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Read an optional string field, returning undefined for absent/non-string values. */
function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read an optional boolean field, returning undefined for absent/non-boolean values. */
function optionalBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key]
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Normalize arbitrary frontmatter data into a {@link SkillFrontmatter}, falling
 * back to the provided directory name when the data names no skill.
 * @param data - parsed YAML frontmatter (may be undefined).
 * @param fallbackName - folder-derived name used when frontmatter omits `name`.
 * @returns a frontmatter record with required fields guaranteed present.
 */
export function normalizeFrontmatter(data: unknown, fallbackName: string): SkillFrontmatter {
  const source: Record<string, unknown> =
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {}
  const name = toKebabCase(optionalString(source, 'name') ?? fallbackName)
  const description = optionalString(source, 'description') ?? ''
  const whenToUse = optionalString(source, 'whenToUse') ?? optionalString(source, 'when_to_use')
  const disableModelInvocation = optionalBoolean(source, 'disableModelInvocation')
  const userInvocable = optionalBoolean(source, 'userInvocable')
  const metadata = toMetadata(source['metadata'])
  return {
    name: name.length > 0 ? name : toKebabCase(fallbackName),
    description,
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
    ...(userInvocable !== undefined ? { userInvocable } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  }
}

/**
 * Parse a complete SKILL.md text into frontmatter and body.
 * @param raw - the file text.
 * @param fallbackName - folder-derived name used when frontmatter omits `name`.
 */
export function parseSkillFile(raw: string, fallbackName: string): ParsedSkillFile {
  const { data, content } = splitFrontmatter(raw)
  return { frontmatter: normalizeFrontmatter(data, fallbackName), content, raw }
}

/**
 * Serialize a SKILL.md from frontmatter fields and body content. Used when
 * creating a new skill; only defined optional fields are emitted so the YAML
 * block stays minimal.
 * @param frontmatter - the metadata to write.
 * @param content - the markdown body.
 * @returns the complete file text with a trailing newline.
 */
export function serializeSkillFile(frontmatter: SkillFrontmatter, content: string): string {
  const data: Record<string, unknown> = {
    name: frontmatter.name,
    description: frontmatter.description,
  }
  if (frontmatter.whenToUse !== undefined) data['whenToUse'] = frontmatter.whenToUse
  if (frontmatter.disableModelInvocation !== undefined) data['disableModelInvocation'] = frontmatter.disableModelInvocation
  if (frontmatter.userInvocable !== undefined) data['userInvocable'] = frontmatter.userInvocable
  if (frontmatter.metadata !== undefined) data['metadata'] = frontmatter.metadata
  const yaml = stringifyYaml(data).trimEnd()
  const body = content.replace(/^\r?\n/, '')
  return `---\n${yaml}\n---\n\n${body.endsWith('\n') ? body : `${body}\n`}`
}

/**
 * Read and parse the SKILL.md inside a directory, if one exists.
 * @param dir - absolute path to the candidate skill directory.
 * @returns the parsed manifest, or undefined when the directory holds no SKILL.md.
 */
export async function readSkillDir(dir: string): Promise<ParsedSkillFile | undefined> {
  const filePath = join(dir, SKILL_FILE)
  if (!pathExists(filePath)) return undefined
  const raw = await readTextFile(filePath)
  if (raw === undefined) return undefined
  return parseSkillFile(raw, basename(dir))
}
