/**
 * Unified line diffing for skill update review. Produces the same
 * add/remove/context model a patch viewer expects, grouped into hunks with a
 * configurable context window, so the client can render an inline comparison
 * between a managed skill's current content and its latest upstream version.
 *
 * @module @dsh-skills-manager/dsh-skills-manager/diff
 */

import type { DiffHunk, DiffLine, DiffResult } from './types.ts'

/** Lines of context kept around each change when grouping hunks. */
const DEFAULT_CONTEXT = 3

/**
 * Above this many DP cells the quadratic LCS table is skipped in favor of a
 * whole-file replace, bounding memory for pathologically large inputs.
 */
const MAX_LCS_CELLS = 4_000_000

/**
 * Normalize line endings and split text into lines.
 * @param text - the source text.
 * @returns the line array (a trailing newline yields a final empty line).
 */
export function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n')
}

/**
 * Compute the longest-common-subsequence edit script between two line arrays.
 * Falls back to a plain remove-all/add-all script when the DP table would be
 * too large, keeping memory bounded.
 */
function editScript(oldLines: string[], newLines: string[]): DiffLine[] {
  const n = oldLines.length
  const m = newLines.length
  if (n * m > MAX_LCS_CELLS) {
    const blunt: DiffLine[] = []
    for (let i = 0; i < n; i += 1) blunt.push({ type: 'remove', content: oldLines[i] ?? '', oldLineNo: i + 1 })
    for (let j = 0; j < m; j += 1) blunt.push({ type: 'add', content: newLines[j] ?? '', newLineNo: j + 1 })
    return blunt
  }

  // dp[i][j] = LCS length of oldLines[i:] and newLines[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = dp[i]
      const next = dp[i + 1]
      if (row === undefined || next === undefined) continue
      row[j] = oldLines[i] === newLines[j]
        ? (next[j + 1] ?? 0) + 1
        : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const row = dp[i]
    const next = dp[i + 1]
    if (row === undefined || next === undefined) break
    if (oldLines[i] === newLines[j]) {
      lines.push({ type: 'context', content: oldLines[i] ?? '', oldLineNo: i + 1, newLineNo: j + 1 })
      i += 1
      j += 1
    } else if ((next[j] ?? 0) >= (row[j + 1] ?? 0)) {
      lines.push({ type: 'remove', content: oldLines[i] ?? '', oldLineNo: i + 1 })
      i += 1
    } else {
      lines.push({ type: 'add', content: newLines[j] ?? '', newLineNo: j + 1 })
      j += 1
    }
  }
  while (i < n) {
    lines.push({ type: 'remove', content: oldLines[i] ?? '', oldLineNo: i + 1 })
    i += 1
  }
  while (j < m) {
    lines.push({ type: 'add', content: newLines[j] ?? '', newLineNo: j + 1 })
    j += 1
  }
  return lines
}

/** Group a flat diff line list into hunks, keeping `context` lines around changes. */
function groupHunks(lines: DiffLine[], context: number): DiffHunk[] {
  const changed = lines.map((line, index) => (line.type === 'context' ? -1 : index)).filter(index => index >= 0)
  if (changed.length === 0) return []

  // Merge change indices into [start, end] windows padded by the context size.
  const ranges: [number, number][] = []
  for (const index of changed) {
    const start = Math.max(0, index - context)
    const end = Math.min(lines.length - 1, index + context)
    const last = ranges[ranges.length - 1]
    if (last !== undefined && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  }

  return ranges.map(([start, end]) => {
    const slice = lines.slice(start, end + 1)
    const oldStart = slice.find(line => line.oldLineNo !== undefined)?.oldLineNo ?? 1
    const newStart = slice.find(line => line.newLineNo !== undefined)?.newLineNo ?? 1
    let oldLines = 0
    let newLines = 0
    for (const line of slice) {
      if (line.type !== 'add') oldLines += 1
      if (line.type !== 'remove') newLines += 1
    }
    return { oldStart, newStart, oldLines, newLines, lines: slice }
  })
}

/**
 * Diff two versions of a skill's content into a hunk-grouped result.
 * @param oldContent - the current (managed) content.
 * @param newContent - the candidate (upstream) content.
 * @param context - lines of surrounding context per hunk; defaults to 3.
 * @returns the diff result carrying both inputs and their hunks.
 */
export function computeDiff(oldContent: string, newContent: string, context = DEFAULT_CONTEXT): DiffResult {
  const lines = editScript(splitLines(oldContent), splitLines(newContent))
  return { oldContent, newContent, hunks: groupHunks(lines, context) }
}

/**
 * Return whether two texts differ, ignoring the trailing-newline distinction.
 * @param a - first text.
 * @param b - second text.
 */
export function contentDiffers(a: string, b: string): boolean {
  return splitLines(a).join('\n') !== splitLines(b).join('\n')
}
