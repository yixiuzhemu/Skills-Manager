/**
 * JSON-backed file stores for the Skills-Manager plugin. Each store manages
 * one JSON document under `~/.dsh/skills-manager/`, providing read/write
 * with a monotonic revision for stale-write detection and a file watcher so
 * external changes are picked up without a restart.
 *
 * @module @dsh-skills-manager/dsh-skills-manager/file-store
 */

import { watchFile, unwatchFile, existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { homedir } from 'node:os'

/** Base directory for all Skills-Manager data. */
const BASE_DIR = resolve(homedir(), '.dsh', 'skills-manager')

/**
 * Generic JSON file store with revision tracking and file watching.
 * One instance per document; started at mount, stopped at dispose.
 */
export class JsonFileStore<T> {
  /** Absolute path of the backing JSON document. */
  readonly path: string

  /** The current data last observed in the document. */
  private current: T
  /** Monotonic revision: bumps on every observed or applied change. */
  private rev = 0
  private readonly onChange: () => void
  private readonly defaultData: () => T

  /**
   * @param filename - document name under the base directory.
   * @param defaultData - factory for the initial value when the document is absent.
   * @param onChange - invoked after each observed change.
   */
  constructor(filename: string, defaultData: () => T, onChange: () => void = () => {}) {
    this.path = resolve(BASE_DIR, filename)
    this.defaultData = defaultData
    this.current = defaultData()
    this.onChange = onChange
  }

  /** The data as last observed. */
  get data(): T {
    return this.current
  }

  /** The revision the current view was read at. */
  get revision(): number {
    return this.rev
  }

  /** Load the document (absent/invalid reads as default) and start watching it. */
  async start(): Promise<void> {
    await this.reload()
    watchFile(this.path, { interval: 1000 }, () => { void this.reload() })
  }

  /** Stop watching the document. */
  stop(): void {
    unwatchFile(this.path)
  }

  /** Replace the document's content wholesale and bump the revision. */
  async save(data: T): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    this.current = data
    this.rev += 1
    this.onChange()
  }

  /** Re-read the document from disk, bumping the revision and announcing it. */
  private async reload(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as T
      this.current = raw !== null && raw !== undefined ? raw : this.defaultData()
    } catch {
      // An absent or unparseable document reads as the default value.
      this.current = this.defaultData()
    }
    this.rev += 1
    this.onChange()
  }
}

/**
 * Ensure a subdirectory exists under the base directory.
 * @param subPath - relative path under the base directory.
 */
export async function ensureDir(subPath: string): Promise<string> {
  const full = resolve(BASE_DIR, subPath)
  await mkdir(full, { recursive: true })
  return full
}

/**
 * List entries in a subdirectory under the base directory.
 * @param subPath - relative path under the base directory.
 * @returns array of absolute paths for each entry.
 */
export async function listDir(subPath: string): Promise<string[]> {
  const full = resolve(BASE_DIR, subPath)
  if (!existsSync(full)) return []
  const entries = await readdir(full)
  return entries.map(e => join(full, e))
}

/**
 * Check whether a path exists.
 * @param fullPath - absolute path to check.
 */
export function pathExists(fullPath: string): boolean {
  return existsSync(fullPath)
}

/**
 * Get file stats for a path.
 * @param fullPath - absolute path.
 */
export async function getStats(fullPath: string): Promise<{ size: number; mtime: number } | undefined> {
  try {
    const s = await stat(fullPath)
    return { size: s.size, mtime: s.mtimeMs }
  } catch {
    return undefined
  }
}

/** The base directory for all Skills-Manager data. */
export function getBaseDir(): string {
  return BASE_DIR
}

/**
 * Read a text file's content.
 * @param fullPath - absolute path to the file.
 * @returns the file content as a string, or undefined if the file does not exist.
 */
export async function readTextFile(fullPath: string): Promise<string | undefined> {
  try {
    return await readFile(fullPath, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Write a text file, creating parent directories as needed.
 * @param fullPath - absolute path to the file.
 * @param content - the text content to write.
 */
export async function writeTextFile(fullPath: string, content: string): Promise<void> {
  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(fullPath, content, 'utf8')
}
