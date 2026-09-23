/**
 * Unit tests for the client's typed fetch wrapper (`src/client/api.ts`).
 *
 * `api.ts` has no runtime imports (its wire types are `import type`-only), so
 * these tests exercise the real `api` surface against a stubbed global `fetch`.
 * They cover envelope unwrapping (`{ ok, data }` → data, `{ ok:false }` →
 * `ApiError`), non-JSON and HTTP-error handling, GET query encoding, and the
 * POST marker/content-type/body contract the host requires.
 *
 * Runs on Node's built-in test runner with native type stripping — no bundler.
 */

import { describe, it } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { API_PREFIX, ApiError, api } from '../src/client/api.ts'

// ── fetch stub ──────────────────────────────────────────────────────────────

/** One recorded `fetch` invocation. */
interface FetchCall {
  url: string
  init: RequestInit | undefined
}

const originalFetch = globalThis.fetch

/** Install a stubbed `fetch`, returning the recorded call log. */
function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = ((url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return Promise.resolve(impl(String(url), init))
  }) as typeof fetch
  return calls
}

/** Stub `fetch` for one test and restore the original afterwards. */
function useFetch(t: TestContext, impl: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls = stubFetch(impl)
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  return calls
}

/** A `Response`-like object returning a fixed JSON payload. */
function jsonRes(status: number, payload: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as unknown as Response
}

/** A `Response`-like object whose `.json()` throws (non-JSON body). */
function badJsonRes(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError('unexpected token')
    },
  } as unknown as Response
}

/** The recorded headers of a call, as a plain string map. */
function headersOf(call: FetchCall | undefined): Record<string, string> {
  return (call?.init?.headers ?? {}) as Record<string, string>
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('api: reads', () => {
  it('issues a bare GET to the prefixed path for state()', async t => {
    const calls = useFetch(t, () => jsonRes(200, { ok: true, data: { skills: [], trash: [], repos: [], company: [] } }))
    const data = await api.state()
    assert.equal(calls[0]?.url, `${API_PREFIX}/state`)
    assert.equal(calls[0]?.init, undefined)
    assert.deepEqual(data, { skills: [], trash: [], repos: [], company: [] })
  })

  it('encodes read query params', async t => {
    const calls = useFetch(t, () => jsonRes(200, { ok: true, data: 'BODY' }))
    const body = await api.content('abc')
    assert.equal(calls[0]?.url, `${API_PREFIX}/content?id=abc`)
    assert.equal(body, 'BODY')
  })

  it('percent-encodes special characters in query params', async t => {
    const calls = useFetch(t, () => jsonRes(200, { ok: true, data: [] }))
    await api.repoSkills('a b')
    assert.equal(calls[0]?.url, `${API_PREFIX}/repos/skills?id=a+b`)
  })
})

describe('api: mutations', () => {
  it('sends the marker header, JSON content type, and body for a POST', async t => {
    const calls = useFetch(t, () => jsonRes(200, { ok: true }))
    const result = await api.enable('s1', true)
    const call = calls[0]
    assert.equal(call?.init?.method, 'POST')
    assert.equal(headersOf(call)['x-dsh-skills-manager'], '1')
    assert.equal(headersOf(call)['content-type'], 'application/json')
    assert.equal(call?.init?.body, JSON.stringify({ id: 's1', enabled: true }))
    assert.equal(result, null) // void mutations unwrap to null via `data ?? null`
  })

  it('posts an empty object body when no payload is given', async t => {
    const calls = useFetch(t, () => jsonRes(200, { ok: true }))
    await api.refresh()
    assert.equal(calls[0]?.init?.body, '{}')
  })

  it('wraps a company source under `source`', async t => {
    const calls = useFetch(t, () => jsonRes(200, { ok: true, data: { id: 'c1' } }))
    const source = { name: 'acme', type: 'git' } as Parameters<typeof api.addCompany>[0]
    await api.addCompany(source)
    assert.equal(calls[0]?.init?.body, JSON.stringify({ source }))
  })
})

describe('api: envelope unwrapping', () => {
  it('returns data from a success envelope', async t => {
    useFetch(t, () => jsonRes(200, { ok: true, data: { hello: 'world' } }))
    assert.deepEqual(await api.state(), { hello: 'world' })
  })

  it('normalizes a success envelope with no data to null', async t => {
    useFetch(t, () => jsonRes(200, { ok: true }))
    assert.equal(await api.updates(), null)
  })

  it('throws an ApiError carrying the host code on ok:false (HTTP 200)', async t => {
    useFetch(t, () => jsonRes(200, { ok: false, code: 'action', error: 'boom' }))
    await assert.rejects(() => api.refresh(), (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.equal(err.code, 'action')
      assert.equal(err.message, 'boom')
      return true
    })
  })

  it('throws on an HTTP error status even with a well-formed envelope', async t => {
    useFetch(t, () => jsonRes(403, { ok: false, code: 'forbiddenHost', error: 'forbidden request origin' }))
    await assert.rejects(() => api.state(), (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.equal(err.code, 'forbiddenHost')
      return true
    })
  })

  it('falls back to a generic code/message when the envelope omits them', async t => {
    useFetch(t, () => jsonRes(500, {}))
    await assert.rejects(() => api.state(), (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.equal(err.code, 'error')
      assert.equal(err.message, 'request failed (HTTP 500)')
      return true
    })
  })

  it('throws a nonJson ApiError when the body is not parseable', async t => {
    useFetch(t, () => badJsonRes(502))
    await assert.rejects(() => api.state(), (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.equal(err.code, 'nonJson')
      assert.match(err.message, /HTTP 502/)
      return true
    })
  })
})

describe('api: ApiError', () => {
  it('is an Error with a stable name and code', () => {
    const err = new ApiError('someCode', 'some message')
    assert.ok(err instanceof Error)
    assert.ok(err instanceof ApiError)
    assert.equal(err.name, 'ApiError')
    assert.equal(err.code, 'someCode')
    assert.equal(err.message, 'some message')
  })
})
