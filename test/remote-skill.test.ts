/**
 * Unit tests for the on-demand remote skill resolver (`src/remote-skill.ts`).
 *
 * The module has no Cordis or filesystem dependency and funnels all network
 * access through the global `fetch`, so these tests exercise the real surface
 * against a stubbed `fetch`. They cover base-URL normalization, endpoint
 * building, envelope parsing (hit / miss), the resolver request contract
 * (authorization header, 404 → undefined, disabled when no base URL), and the
 * archive download (token NOT forwarded, bytes returned, non-2xx throws).
 *
 * Runs on Node's built-in test runner with native type stripping — no bundler.
 */

import { describe, it } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TIMEOUT_MS,
  RemoteSkillError,
  downloadEndpoint,
  downloadSkillArchive,
  isResolverEnabled,
  normalizeBaseUrl,
  parseResolverPayload,
  resolveRemoteSkill,
} from '../src/remote-skill.ts'

// ── fetch stub ──────────────────────────────────────────────────────────────

/** One recorded `fetch` invocation. */
interface FetchCall {
  url: string
  init: RequestInit | undefined
}

const originalFetch = globalThis.fetch

/** Stub `fetch` for one test and restore the original afterwards. */
function useFetch(t: TestContext, impl: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = ((url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return Promise.resolve(impl(String(url), init))
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  return calls
}

/** A `Response`-like object returning a fixed JSON payload. */
function jsonRes(status: number, payload: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as unknown as Response
}

/** A `Response`-like object returning fixed archive bytes. */
function bytesRes(status: number, bytes: number[]): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  } as unknown as Response
}

/** The recorded headers of a call, as a plain string map. */
function headersOf(call: FetchCall | undefined): Record<string, string> {
  return (call?.init?.headers ?? {}) as Record<string, string>
}

/** A resolver success envelope for one download URL / skill name. */
function resolverEnvelope(downloadUrl: string, skillName: string): unknown {
  return { success: true, code: 200, msg: 'ok', data: { downloadUrl, skillName, likeCount: 45 } }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('remote-skill: base url normalization', () => {
  it('normalizes empty/blank to an empty string', () => {
    assert.equal(normalizeBaseUrl(''), '')
    assert.equal(normalizeBaseUrl('   '), '')
  })

  it('prepends https:// to a bare domain and strips trailing slashes', () => {
    assert.equal(normalizeBaseUrl('mcp-test.lan-bridge.cn'), 'https://mcp-test.lan-bridge.cn')
    assert.equal(normalizeBaseUrl('mcp-test.lan-bridge.cn///'), 'https://mcp-test.lan-bridge.cn')
  })

  it('preserves an explicit scheme', () => {
    assert.equal(normalizeBaseUrl('http://example.test/'), 'http://example.test')
    assert.equal(normalizeBaseUrl('https://example.test'), 'https://example.test')
  })

  it('reports enabled only when a base url is present', () => {
    assert.equal(isResolverEnabled({ baseUrl: '' }), false)
    assert.equal(isResolverEnabled({ baseUrl: 'mcp-test.lan-bridge.cn' }), true)
  })

  it('builds the fixed /skills/skills/{id}/download endpoint with encoding', () => {
    assert.equal(
      downloadEndpoint('mcp-test.lan-bridge.cn', 'SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
      'https://mcp-test.lan-bridge.cn/skills/skills/SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/download',
    )
    assert.equal(downloadEndpoint('https://h.test', 'a b/c'), 'https://h.test/skills/skills/a%20b%2Fc/download')
  })

  it('exposes a positive default timeout', () => {
    assert.ok(DEFAULT_TIMEOUT_MS > 0)
  })
})

describe('remote-skill: envelope parsing', () => {
  it('reads downloadUrl and skillName from a success envelope', () => {
    const ref = parseResolverPayload(resolverEnvelope('https://oss/x.zip', 'cat-translate'))
    assert.deepEqual(ref, { downloadUrl: 'https://oss/x.zip', skillName: 'cat-translate' })
  })

  it('treats success:false as a miss', () => {
    assert.equal(parseResolverPayload({ success: false, data: { downloadUrl: 'https://oss/x.zip' } }), undefined)
  })

  it('treats a missing/blank downloadUrl as a miss', () => {
    assert.equal(parseResolverPayload({ success: true, data: { skillName: 'x' } }), undefined)
    assert.equal(parseResolverPayload({ success: true, data: { downloadUrl: '   ' } }), undefined)
  })

  it('tolerates a missing skillName', () => {
    assert.deepEqual(parseResolverPayload({ success: true, data: { downloadUrl: 'https://oss/x.zip' } }), {
      downloadUrl: 'https://oss/x.zip',
      skillName: '',
    })
  })

  it('rejects non-object payloads and missing data', () => {
    assert.equal(parseResolverPayload(null), undefined)
    assert.equal(parseResolverPayload('nope'), undefined)
    assert.equal(parseResolverPayload({ success: true }), undefined)
    assert.equal(parseResolverPayload({ success: true, data: null }), undefined)
  })
})

describe('remote-skill: resolveRemoteSkill', () => {
  it('does not fetch and returns undefined when disabled', async t => {
    const calls = useFetch(t, () => jsonRes(200, resolverEnvelope('https://oss/x.zip', 'x')))
    const ref = await resolveRemoteSkill('SK1', { baseUrl: '' })
    assert.equal(ref, undefined)
    assert.equal(calls.length, 0)
  })

  it('sends the bearer token and Accept header to the resolver endpoint', async t => {
    const calls = useFetch(t, () => jsonRes(200, resolverEnvelope('https://oss/x.zip', 'cat-translate')))
    const ref = await resolveRemoteSkill('SK1', { baseUrl: 'mcp-test.lan-bridge.cn', token: 'sk-secret' })
    assert.deepEqual(ref, { downloadUrl: 'https://oss/x.zip', skillName: 'cat-translate' })
    assert.equal(calls[0]?.url, 'https://mcp-test.lan-bridge.cn/skills/skills/SK1/download')
    assert.equal(headersOf(calls[0])['authorization'], 'Bearer sk-secret')
    assert.equal(headersOf(calls[0])['Accept'], 'application/json')
  })

  it('omits the authorization header when no token is configured', async t => {
    const calls = useFetch(t, () => jsonRes(200, resolverEnvelope('https://oss/x.zip', 'x')))
    await resolveRemoteSkill('SK1', { baseUrl: 'https://h.test' })
    assert.equal(headersOf(calls[0])['authorization'], undefined)
  })

  it('maps a 404 to undefined (a definitive miss)', async t => {
    useFetch(t, () => jsonRes(404, {}))
    assert.equal(await resolveRemoteSkill('SK1', { baseUrl: 'https://h.test' }), undefined)
  })

  it('throws a RemoteSkillError on a non-2xx, non-404 status', async t => {
    useFetch(t, () => jsonRes(500, {}))
    await assert.rejects(() => resolveRemoteSkill('SK1', { baseUrl: 'https://h.test' }), (err: unknown) => {
      assert.ok(err instanceof RemoteSkillError)
      return true
    })
  })
})

describe('remote-skill: downloadSkillArchive', () => {
  it('returns the archive bytes and does NOT forward the bearer token', async t => {
    const calls = useFetch(t, () => bytesRes(200, [1, 2, 3, 4]))
    const bytes = await downloadSkillArchive('https://oss/x.zip?sig=abc')
    assert.deepEqual(Array.from(bytes), [1, 2, 3, 4])
    assert.equal(calls[0]?.url, 'https://oss/x.zip?sig=abc')
    assert.equal(headersOf(calls[0])['authorization'], undefined)
    assert.equal(calls[0]?.init?.headers, undefined)
  })

  it('throws a RemoteSkillError on a non-2xx download', async t => {
    useFetch(t, () => bytesRes(403, []))
    await assert.rejects(() => downloadSkillArchive('https://oss/x.zip'), (err: unknown) => {
      assert.ok(err instanceof RemoteSkillError)
      return true
    })
  })
})
