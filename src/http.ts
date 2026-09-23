/**
 * The HTTP transport seam between the host {@link SkillsManager} and the
 * browser client. A standalone plugin cannot reach the client through the
 * Typert remote assembly (that facade mounts a fixed, codegen-built namespace
 * set owned by the harness monorepo and requires `dsh-api-gateway`), so the
 * host instead registers one `prefix` route on `ctx.webServer` and the client
 * calls it with `fetch`. Every response is a JSON envelope —
 * `{ ok: true, data }` on success, `{ ok: false, code, error }` on failure —
 * so the client has one parse path.
 *
 * Security mirrors the harness convention: requests must originate from a
 * loopback host (or declare a same-origin/none `sec-fetch-site`), and every
 * mutating `POST` must carry the `x-dsh-skills-manager` client marker and a
 * `application/json` content type. Read-only `GET` routes are exempt from the
 * marker but still origin-checked.
 *
 * @module @dsh-skills-manager/dsh-skills-manager/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SkillsManager } from './service.ts'
import type { CompanySkillSource, CreateParams, ImportParams } from './types.ts'

/** Absolute prefix the client fetches against; must have no trailing slash. */
export const API_PREFIX = '/api/skills-manager'
/** Custom header a mutating request must carry to prove it is our client. */
const CLIENT_MARKER_HEADER = 'x-dsh-skills-manager'
/** Upper bound on a request body; import payloads are JSON metadata only. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** A parsed JSON request body for a mutation. */
type Body = Record<string, unknown>

/**
 * Register the manager's HTTP surface on the host web server.
 * @param manager - the host service whose methods the routes forward to.
 * @param register - the `ctx.webServer.register` binding (kept as a parameter
 *   so this module stays free of a hard Cordis import edge).
 * @returns the disposer that removes the route.
 */
export function registerHttpApi(
  manager: SkillsManager,
  register: (route: WebRoute) => () => void,
): () => void {
  return register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => {
      void handle(req, res, manager)
    },
  })
}

// ── Request lifecycle ───────────────────────────────────────────────────────

/** Route one request: origin check, then method dispatch. */
async function handle(req: IncomingMessage, res: ServerResponse, manager: SkillsManager): Promise<void> {
  if (!isAllowedOrigin(req)) {
    sendJson(res, 403, { ok: false, code: 'forbiddenHost', error: 'forbidden request origin' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const action = normalizeAction(url.pathname)
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') {
    await handleRead(action, url, res, manager)
    return
  }
  if (method === 'POST') {
    await handleMutation(action, req, res, manager)
    return
  }
  sendJson(res, 405, { ok: false, code: 'method', error: 'method not allowed' })
}

/** Dispatch a read-only route. */
async function handleRead(action: string, url: URL, res: ServerResponse, manager: SkillsManager): Promise<void> {
  const id = url.searchParams.get('id') ?? ''
  switch (action) {
    case '/state':
      await run(res, () => snapshot(manager))
      return
    case '/content':
      await run(res, () => manager.getSkillContent(id))
      return
    case '/repos/skills':
      await run(res, () => manager.listRepoSkills(id))
      return
    case '/company/skills':
      await run(res, () => manager.listCompanySkills(id))
      return
    case '/updates':
      await run(res, () => manager.checkUpdates())
      return
    case '/diff':
      await run(res, () => manager.getDiff(id))
      return
    default:
      sendJson(res, 404, { ok: false, code: 'unknownAction', error: `unknown action: ${action}` })
  }
}

/** Dispatch a mutating route after validating the marker, content type, and body. */
async function handleMutation(action: string, req: IncomingMessage, res: ServerResponse, manager: SkillsManager): Promise<void> {
  if (req.headers[CLIENT_MARKER_HEADER] !== '1') {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'missing client marker' })
    return
  }
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.includes('application/json')) {
    sendJson(res, 400, { ok: false, code: 'contentType', error: 'content type must be application/json' })
    return
  }
  let raw: string
  try {
    raw = await readBody(req)
  } catch {
    sendJson(res, 413, { ok: false, code: 'bodyTooLarge', error: 'request body too large' })
    return
  }
  let body: Body
  try {
    body = raw.length === 0 ? {} : (JSON.parse(raw) as Body)
  } catch {
    sendJson(res, 400, { ok: false, code: 'invalidJson', error: 'request body is not valid JSON' })
    return
  }
  await dispatchMutation(action, body, res, manager)
}

/** Map a mutation action to its manager call. */
async function dispatchMutation(action: string, body: Body, res: ServerResponse, manager: SkillsManager): Promise<void> {
  switch (action) {
    case '/refresh':
      await run(res, () => manager.refresh())
      return
    case '/enable':
      await run(res, () => manager.setEnabled(str(body, 'id'), bool(body, 'enabled')))
      return
    case '/delete':
      await run(res, () => manager.delete(str(body, 'id')))
      return
    case '/restore':
      await run(res, () => manager.restore(str(body, 'trashId')))
      return
    case '/purge':
      await run(res, () => manager.purge(str(body, 'trashId')))
      return
    case '/empty-trash':
      await run(res, () => manager.emptyTrash())
      return
    case '/create':
      await run(res, () => manager.createSkill(body as unknown as CreateParams))
      return
    case '/import':
      await run(res, () => manager.importSkill(body as unknown as ImportParams))
      return
    case '/repos/add':
      await run(res, () => manager.addRepo(str(body, 'url'), strOr(body, 'branch', 'main')))
      return
    case '/repos/remove':
      await run(res, () => manager.removeRepo(str(body, 'id')))
      return
    case '/repos/refresh':
      await run(res, () => manager.refreshRepo(str(body, 'id')))
      return
    case '/repos/install':
      await run(res, () => manager.installRepoSkill(str(body, 'repoId'), str(body, 'path')))
      return
    case '/company/add':
      await run(res, () => manager.addCompanySource((body.source ?? body) as Omit<CompanySkillSource, 'id'>))
      return
    case '/company/remove':
      await run(res, () => manager.removeCompanySource(str(body, 'id')))
      return
    case '/company/sync':
      await run(res, () => manager.syncCompanySource(str(body, 'id')))
      return
    case '/company/install':
      await run(res, () => manager.installCompanySkill(str(body, 'sourceId'), str(body, 'name')))
      return
    case '/update':
      await run(res, () => manager.applyUpdate(str(body, 'id')))
      return
    default:
      sendJson(res, 404, { ok: false, code: 'unknownAction', error: `unknown action: ${action}` })
  }
}

// ── Response helpers ────────────────────────────────────────────────────────

/** The combined opening snapshot the client renders from. */
function snapshot(manager: SkillsManager): {
  skills: ReturnType<SkillsManager['listSkills']>
  trash: ReturnType<SkillsManager['listTrash']>
  repos: ReturnType<SkillsManager['listRepos']>
  company: ReturnType<SkillsManager['listCompanySources']>
} {
  return {
    skills: manager.listSkills(),
    trash: manager.listTrash(),
    repos: manager.listRepos(),
    company: manager.listCompanySources(),
  }
}

/** Run a task and write its result (or its error) as one JSON envelope. */
async function run(res: ServerResponse, task: () => unknown): Promise<void> {
  try {
    const data = await task()
    sendJson(res, 200, { ok: true, data: data ?? null })
  } catch (error) {
    sendJson(res, 200, { ok: false, code: 'action', error: messageOf(error) })
  }
}

/** Write a JSON body with an explicit status. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Read the full request body, rejecting once it exceeds the size cap. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ── Validation and coercion ─────────────────────────────────────────────────

/** Whether the request comes from a trustworthy (loopback / same-origin) source. */
function isAllowedOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (site === 'same-origin' || site === 'none') return true
  if (site === undefined) return isLoopbackHost(req.headers.host)
  const origin = req.headers.origin
  if (typeof origin === 'string') {
    try {
      return isLoopbackHost(new URL(origin).host)
    } catch {
      return false
    }
  }
  return false
}

/** Whether a `host` header (with optional port) names the loopback interface. */
function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return true
  const host = hostHeader.replace(/:\d+$/, '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

/** Strip the API prefix to the bare action path (`/state`, `/repos/add`, …). */
function normalizeAction(pathname: string): string {
  const trimmed = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname
  if (trimmed.length === 0) return '/'
  return trimmed.endsWith('/') && trimmed.length > 1 ? trimmed.slice(0, -1) : trimmed
}

/** Read a required string field. */
function str(body: Body, key: string): string {
  const value = body[key]
  return typeof value === 'string' ? value : ''
}

/** Read a string field with a fallback. */
function strOr(body: Body, key: string, fallback: string): string {
  const value = body[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/** Read a boolean field (only an explicit `true` counts). */
function bool(body: Body, key: string): boolean {
  return body[key] === true
}

/** Best-effort human-readable error message. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? 'unknown error')
}
