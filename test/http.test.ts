/**
 * Unit tests for the host HTTP transport seam (`src/http.ts`).
 *
 * `src/http.ts` is a pure `import type` module with no runtime edges, so these
 * tests mount the real route handler via {@link registerHttpApi} and drive it
 * with a fake `IncomingMessage`/`ServerResponse` pair against a Proxy-based
 * `SkillsManager` mock. This exercises the whole black box: origin security,
 * method dispatch, action routing, marker/content-type/JSON/body-size guards,
 * and the `{ ok, data }` / `{ ok, code, error }` envelope.
 *
 * Runs on Node's built-in test runner with native type stripping — no bundler.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SkillsManager } from '../src/service.ts'
import { API_PREFIX, registerHttpApi } from '../src/http.ts'

// ── Manager mock ────────────────────────────────────────────────────────────

/** A recorded method invocation on the manager mock. */
interface ManagerCall {
  method: string
  args: unknown[]
}

/** The controllable surface of the Proxy-based manager mock. */
interface ManagerMock {
  manager: SkillsManager
  calls: ManagerCall[]
  /** Per-method return values; unset methods resolve to `undefined`. */
  results: Record<string, unknown>
  /** Per-method thrown errors; takes precedence over `results`. */
  errors: Record<string, Error>
}

/**
 * Build a `SkillsManager` stand-in. Any property access yields a function that
 * records its call, throws `errors[name]` if present, else returns
 * `results[name]` (or `undefined`). This keeps the mock future-proof as routes
 * are added without enumerating every method.
 */
function createManagerMock(): ManagerMock {
  const calls: ManagerCall[] = []
  const results: Record<string, unknown> = {}
  const errors: Record<string, Error> = {}
  const manager = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      return (...args: unknown[]): unknown => {
        calls.push({ method: prop, args })
        if (prop in errors) throw errors[prop]
        return prop in results ? results[prop] : undefined
      }
    },
  }) as unknown as SkillsManager
  return { manager, calls, results, errors }
}

/** The last call recorded for a method, or `undefined` if never invoked. */
function lastCall(mock: ManagerMock, method: string): ManagerCall | undefined {
  for (let i = mock.calls.length - 1; i >= 0; i -= 1) {
    const call = mock.calls[i]
    if (call !== undefined && call.method === method) return call
  }
  return undefined
}

// ── Request / response fakes ────────────────────────────────────────────────

/** Options describing one fake request. */
interface RequestOptions {
  method?: string
  url?: string
  headers?: Record<string, string>
  /** Body chunks; a single string/Buffer is wrapped, an array is streamed as-is. */
  body?: string | Buffer | Buffer[]
}

/** A fake request built on a real `Readable` so `readBody` streaming is genuine. */
function makeReq(options: RequestOptions): IncomingMessage {
  const { method = 'GET', url = '/', headers = {}, body } = options
  let chunks: Buffer[]
  if (body === undefined) chunks = []
  else if (Array.isArray(body)) chunks = body
  else chunks = [typeof body === 'string' ? Buffer.from(body, 'utf8') : body]
  const stream = Readable.from(chunks)
  return Object.assign(stream, { method, url, headers }) as unknown as IncomingMessage
}

/** A captured response plus a promise that settles once `end()` is called. */
interface FakeResponse {
  res: ServerResponse
  record: { statusCode: number; headers: Record<string, string | number>; body: string }
  done: Promise<void>
}

/** A fake response that records status/headers/body and signals completion. */
function makeRes(): FakeResponse {
  let signal!: () => void
  const done = new Promise<void>(resolve => {
    signal = resolve
  })
  const record = { statusCode: 0, headers: {} as Record<string, string | number>, body: '' }
  const res = {
    writeHead(status: number, headers: Record<string, string | number>): void {
      record.statusCode = status
      Object.assign(record.headers, headers)
    },
    end(text?: string): void {
      record.body = text ?? ''
      signal()
    },
  }
  return { res: res as unknown as ServerResponse, record, done }
}

/** The parsed JSON body of a captured response. */
interface ParsedResponse {
  status: number
  headers: Record<string, string | number>
  body: string
  json: { ok?: boolean; data?: unknown; code?: string; error?: string }
}

/** Mount the real handler for a mock manager, invoke one request, await the reply. */
async function invoke(mock: ManagerMock, options: RequestOptions): Promise<ParsedResponse> {
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined
  registerHttpApi(mock.manager, route => {
    handler = (route as unknown as { handler: (req: IncomingMessage, res: ServerResponse) => void }).handler
    return () => {}
  })
  const { res, record, done } = makeRes()
  handler?.(makeReq(options), res)
  await done
  return {
    status: record.statusCode,
    headers: record.headers,
    body: record.body,
    json: JSON.parse(record.body) as ParsedResponse['json'],
  }
}

/** Headers that always pass the origin check, so a test isolates one concern. */
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' }
/** Marker + JSON content type: the minimum a mutating POST must carry. */
const MUTATION_HEADERS = { ...SAME_ORIGIN, 'x-dsh-skills-manager': '1', 'content-type': 'application/json' }

// ── Tests ───────────────────────────────────────────────────────────────────

describe('http: origin security', () => {
  it('allows a same-origin sec-fetch-site', async () => {
    const mock = createManagerMock()
    const res = await invoke(mock, { method: 'GET', url: `${API_PREFIX}/state`, headers: SAME_ORIGIN })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
  })

  it('allows a loopback host header with no sec-fetch-site', async () => {
    const mock = createManagerMock()
    const res = await invoke(mock, { method: 'GET', url: `${API_PREFIX}/state`, headers: { host: '127.0.0.1:8080' } })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
  })

  it('allows a loopback origin even on a cross-site fetch', async () => {
    const mock = createManagerMock()
    const res = await invoke(mock, {
      method: 'GET',
      url: `${API_PREFIX}/state`,
      headers: { 'sec-fetch-site': 'cross-site', origin: 'http://localhost:3000' },
    })
    assert.equal(res.status, 200)
  })

  it('rejects a non-loopback host with 403 forbiddenHost', async () => {
    const mock = createManagerMock()
    const res = await invoke(mock, { method: 'GET', url: `${API_PREFIX}/state`, headers: { host: 'evil.com' } })
    assert.equal(res.status, 403)
    assert.equal(res.json.ok, false)
    assert.equal(res.json.code, 'forbiddenHost')
  })

  it('rejects a non-loopback origin on a cross-site fetch', async () => {
    const mock = createManagerMock()
    const res = await invoke(mock, {
      method: 'GET',
      url: `${API_PREFIX}/state`,
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.com' },
    })
    assert.equal(res.status, 403)
    assert.equal(res.json.code, 'forbiddenHost')
  })

  it('rejects a cross-site fetch that declares no origin', async () => {
    const mock = createManagerMock()
    const res = await invoke(mock, { method: 'GET', url: `${API_PREFIX}/state`, headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(res.status, 403)
    assert.equal(res.json.code, 'forbiddenHost')
  })
})

describe('http: method dispatch', () => {
  it('rejects an unsupported method with 405', async () => {
    const mock = createManagerMock()
    const res = await invoke(mock, { method: 'PUT', url: `${API_PREFIX}/state`, headers: SAME_ORIGIN })
    assert.equal(res.status, 405)
    assert.equal(res.json.code, 'method')
  })

  it('treats HEAD like a read', async () => {
    const mock = createManagerMock()
    mock.results.listSkills = []
    mock.results.listTrash = []
    mock.results.listRepos = []
    mock.results.listCompanySources = []
    const res = await invoke(mock, { method: 'HEAD', url: `${API_PREFIX}/state`, headers: SAME_ORIGIN })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
  })
})

describe('http: read routing', () => {
  it('builds the combined snapshot for /state', async () => {
    const mock = createManagerMock()
    mock.results.listSkills = [{ id: 's1' }]
    mock.results.listTrash = [{ id: 't1' }]
    mock.results.listRepos = [{ id: 'r1' }]
    mock.results.listCompanySources = [{ id: 'c1' }]
    const res = await invoke(mock, { method: 'GET', url: `${API_PREFIX}/state`, headers: SAME_ORIGIN })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.data, {
      skills: [{ id: 's1' }],
      trash: [{ id: 't1' }],
      repos: [{ id: 'r1' }],
      company: [{ id: 'c1' }],
    })
    assert.ok(lastCall(mock, 'listSkills') !== undefined)
    assert.ok(lastCall(mock, 'listCompanySources') !== undefined)
  })

  it('forwards the id query param to /content', async () => {
    const mock = createManagerMock()
    mock.results.getSkillContent = 'BODY'
    const res = await invoke(mock, { method: 'GET', url: `${API_PREFIX}/content?id=abc`, headers: SAME_ORIGIN })
    assert.equal(res.json.data, 'BODY')
    assert.deepEqual(lastCall(mock, 'getSkillContent')?.args, ['abc'])
  })

  it('normalizes an undefined result to null data', async () => {
    const mock = createManagerMock()
    const res = await invoke(mock, { method: 'GET', url: `${API_PREFIX}/content?id=missing`, headers: SAME_ORIGIN })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.data, null)
  })

  it('routes /repos/skills, /company/skills, /updates and /diff', async () => {
    const mock = createManagerMock()
    mock.results.listRepoSkills = ['repo']
    mock.results.listCompanySkills = ['company']
    mock.results.checkUpdates = ['update']
    mock.results.getDiff = { hunks: [] }

    const repo = await invoke(mock, { method: 'GET', url: `${API_PREFIX}/repos/skills?id=r1`, headers: SAME_ORIGIN })
    assert.deepEqual(repo.json.data, ['repo'])
    assert.deepEqual(lastCall(mock, 'listRepoSkills')?.args, ['r1'])

    const company = await invoke(mock, { method: 'GET', url: `${API_PREFIX}/company/skills?id=c1`, headers: SAME_ORIGIN })
    assert.deepEqual(company.json.data, ['company'])
    assert.deepEqual(lastCall(mock, 'listCompanySkills')?.args, ['c1'])

    const updates = await invoke(mock, { method: 'GET', url: `${API_PREFIX}/updates`, headers: SAME_ORIGIN })
    assert.deepEqual(updates.json.data, ['update'])

    const diff = await invoke(mock, { method: 'GET', url: `${API_PREFIX}/diff?id=d1`, headers: SAME_ORIGIN })
    assert.deepEqual(diff.json.data, { hunks: [] })
    assert.deepEqual(lastCall(mock, 'getDiff')?.args, ['d1'])
  })

  it('accepts a trailing slash and a bare (unprefixed) action', async () => {
    const mock = createManagerMock()
    mock.results.checkUpdates = []
    const trailing = await invoke(mock, { method: 'GET', url: `${API_PREFIX}/updates/`, headers: SAME_ORIGIN })
    assert.equal(trailing.status, 200)
    const bare = await invoke(mock, { method: 'GET', url: '/updates', headers: SAME_ORIGIN })
    assert.equal(bare.status, 200)
  })

  it('returns 404 unknownAction for an unmapped read', async () => {
    const mock = createManagerMock()
    const res = await invoke(mock, { method: 'GET', url: `${API_PREFIX}/bogus`, headers: SAME_ORIGIN })
    assert.equal(res.status, 404)
    assert.equal(res.json.code, 'unknownAction')
  })
})

describe('http: mutation guards', () => {
  it('rejects a POST without the client marker (403)', async () => {
    const mock = createManagerMock()
    const res = await invoke(mock, {
      method: 'POST',
      url: `${API_PREFIX}/refresh`,
      headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(res.status, 403)
    assert.equal(res.json.code, 'forbidden')
  })

  it('rejects a non-JSON content type (400)', async () => {
    const mock = createManagerMock()
    const res = await invoke(mock, {
      method: 'POST',
      url: `${API_PREFIX}/refresh`,
      headers: { ...SAME_ORIGIN, 'x-dsh-skills-manager': '1', 'content-type': 'text/plain' },
      body: '{}',
    })
    assert.equal(res.status, 400)
    assert.equal(res.json.code, 'contentType')
  })

  it('rejects a malformed JSON body (400)', async () => {
    const mock = createManagerMock()
    const res = await invoke(mock, { method: 'POST', url: `${API_PREFIX}/refresh`, headers: MUTATION_HEADERS, body: '{bad json' })
    assert.equal(res.status, 400)
    assert.equal(res.json.code, 'invalidJson')
  })

  it('rejects an oversized body (413)', async () => {
    const mock = createManagerMock()
    const tooBig = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61)
    const res = await invoke(mock, { method: 'POST', url: `${API_PREFIX}/refresh`, headers: MUTATION_HEADERS, body: tooBig })
    assert.equal(res.status, 413)
    assert.equal(res.json.code, 'bodyTooLarge')
  })

  it('returns 404 unknownAction for an unmapped mutation that passes the guards', async () => {
    const mock = createManagerMock()
    const res = await invoke(mock, { method: 'POST', url: `${API_PREFIX}/nope`, headers: MUTATION_HEADERS, body: '{}' })
    assert.equal(res.status, 404)
    assert.equal(res.json.code, 'unknownAction')
  })
})

describe('http: mutation routing and envelope', () => {
  it('treats an empty body as {} (refresh)', async () => {
    const mock = createManagerMock()
    const res = await invoke(mock, { method: 'POST', url: `${API_PREFIX}/refresh`, headers: MUTATION_HEADERS })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.data, null)
    assert.ok(lastCall(mock, 'refresh') !== undefined)
  })

  it('coerces /enable args and defaults a missing flag to false', async () => {
    const mock = createManagerMock()
    await invoke(mock, { method: 'POST', url: `${API_PREFIX}/enable`, headers: MUTATION_HEADERS, body: JSON.stringify({ id: 's1', enabled: true }) })
    assert.deepEqual(lastCall(mock, 'setEnabled')?.args, ['s1', true])

    await invoke(mock, { method: 'POST', url: `${API_PREFIX}/enable`, headers: MUTATION_HEADERS, body: JSON.stringify({ id: 's2' }) })
    assert.deepEqual(lastCall(mock, 'setEnabled')?.args, ['s2', false])
  })

  it('applies the branch fallback for /repos/add', async () => {
    const mock = createManagerMock()
    await invoke(mock, { method: 'POST', url: `${API_PREFIX}/repos/add`, headers: MUTATION_HEADERS, body: JSON.stringify({ url: 'u' }) })
    assert.deepEqual(lastCall(mock, 'addRepo')?.args, ['u', 'main'])

    await invoke(mock, { method: 'POST', url: `${API_PREFIX}/repos/add`, headers: MUTATION_HEADERS, body: JSON.stringify({ url: 'u', branch: 'dev' }) })
    assert.deepEqual(lastCall(mock, 'addRepo')?.args, ['u', 'dev'])
  })

  it('unwraps a nested source for /company/add, falling back to the body', async () => {
    const mock = createManagerMock()
    await invoke(mock, {
      method: 'POST',
      url: `${API_PREFIX}/company/add`,
      headers: MUTATION_HEADERS,
      body: JSON.stringify({ source: { name: 'acme', type: 'git' } }),
    })
    assert.deepEqual(lastCall(mock, 'addCompanySource')?.args, [{ name: 'acme', type: 'git' }])

    await invoke(mock, { method: 'POST', url: `${API_PREFIX}/company/add`, headers: MUTATION_HEADERS, body: JSON.stringify({ name: 'inline', type: 'api' }) })
    assert.deepEqual(lastCall(mock, 'addCompanySource')?.args, [{ name: 'inline', type: 'api' }])
  })

  it('returns the created record as data', async () => {
    const mock = createManagerMock()
    mock.results.createSkill = { id: 'new', name: 'n' }
    const res = await invoke(mock, {
      method: 'POST',
      url: `${API_PREFIX}/create`,
      headers: MUTATION_HEADERS,
      body: JSON.stringify({ name: 'n', description: 'd', content: 'c' }),
    })
    assert.deepEqual(res.json.data, { id: 'new', name: 'n' })
  })

  it('wraps a thrown action error as 200 { ok:false, code:action }', async () => {
    const mock = createManagerMock()
    mock.errors.setEnabled = new Error('boom')
    const res = await invoke(mock, {
      method: 'POST',
      url: `${API_PREFIX}/enable`,
      headers: MUTATION_HEADERS,
      body: JSON.stringify({ id: 's1', enabled: true }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, false)
    assert.equal(res.json.code, 'action')
    assert.equal(res.json.error, 'boom')
  })

  it('sets JSON response headers with no-store', async () => {
    const mock = createManagerMock()
    const res = await invoke(mock, { method: 'GET', url: `${API_PREFIX}/updates`, headers: SAME_ORIGIN })
    assert.match(String(res.headers['content-type']), /application\/json/)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.equal(res.headers['content-length'], Buffer.byteLength(res.body))
  })
})
