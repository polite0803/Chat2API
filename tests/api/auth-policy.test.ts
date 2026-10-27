import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  checkStartupSecurity,
  evaluateApiKeyAuth,
  isLoopbackOrigin,
  requiresApiKey,
  resolveCorsOrigin,
  safeKeyEquals,
} from '../../src/main/proxy/authPolicy.ts'

const keys = [{ key: 'sk-live-1', enabled: true }]

test('auth is fail-open only when no key is configured', () => {
  assert.equal(evaluateApiKeyAuth({ apiKeys: [], providedKey: null }), 'allow')
  assert.equal(evaluateApiKeyAuth({ apiKeys: undefined, providedKey: null }), 'allow')
})

test('configured keys always require authentication', () => {
  assert.equal(evaluateApiKeyAuth({ apiKeys: keys, providedKey: null }), 'missing_key')
  assert.equal(evaluateApiKeyAuth({ apiKeys: keys, providedKey: '' }), 'missing_key')
  assert.equal(evaluateApiKeyAuth({ apiKeys: keys, providedKey: 'wrong' }), 'invalid_key')
  assert.equal(evaluateApiKeyAuth({ apiKeys: keys, providedKey: 'sk-live-1' }), 'allow')
})

test('disabled or empty keys do not count as configured', () => {
  assert.equal(requiresApiKey([{ key: 'sk-off', enabled: false }]), false)
  assert.equal(evaluateApiKeyAuth({ apiKeys: [{ key: 'sk-off', enabled: false }], providedKey: null }), 'allow')
  assert.equal(evaluateApiKeyAuth({ apiKeys: [{ key: '', enabled: true }], providedKey: null }), 'allow')
})

test('key comparison is constant-time and length independent', () => {
  assert.equal(safeKeyEquals('abc', 'abc'), true)
  assert.equal(safeKeyEquals('abc', 'abd'), false)
  assert.equal(safeKeyEquals('abc', 'abcdefghijklmnop'), false)
})

test('non-loopback listen without keys is refused at startup', () => {
  assert.deepEqual(checkStartupSecurity({ apiKeys: [], host: '127.0.0.1' }), { ok: true })
  assert.deepEqual(checkStartupSecurity({ apiKeys: [], host: '::1' }), { ok: true })
  const refused = checkStartupSecurity({ apiKeys: [], host: '0.0.0.0' })
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'api_key_required_for_non_loopback_listen')
  assert.equal(checkStartupSecurity({ apiKeys: keys, host: '0.0.0.0' }).ok, true)
})

test('CORS wildcard only for loopback without keys', () => {
  assert.equal(resolveCorsOrigin({ origin: 'https://evil.example', requiresKey: false, host: '127.0.0.1' }), '*')
  assert.equal(resolveCorsOrigin({ origin: 'https://evil.example', requiresKey: true, host: '127.0.0.1' }), null)
  assert.equal(resolveCorsOrigin({ origin: 'https://evil.example', requiresKey: false, host: '0.0.0.0' }), null)
  assert.equal(
    resolveCorsOrigin({ origin: 'http://localhost:5173', requiresKey: true, host: '127.0.0.1' }),
    'http://localhost:5173'
  )
  assert.equal(isLoopbackOrigin('http://[::1]:8080'), true)
  assert.equal(isLoopbackOrigin('not-a-url'), false)
})

test('server middleware evaluates auth before body parsing and drops query keys', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/main/proxy/server.ts', import.meta.url)),
    'utf8'
  )
  assert.doesNotMatch(source, /ctx\.query\.api_key/)
  assert.doesNotMatch(source, /enableApiKey &&/)
  const authIndex = source.indexOf('const outcome = evaluateApiKeyAuth')
  const bodyParserIndex = source.indexOf('this.app.use(bodyParser(')
  assert.ok(authIndex > -1, 'auth middleware must call evaluateApiKeyAuth')
  assert.ok(bodyParserIndex > authIndex, 'body parser must be registered after the auth middleware')
})

test('proxy control API rejects non-loopback hosts', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/main/proxy/routes/management/proxy.ts', import.meta.url)),
    'utf8'
  )
  assert.match(source, /isLoopbackHost\(host\)/)
  assert.match(source, /invalid_host/)
})

test('status manager default host is loopback', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/main/proxy/status.ts', import.meta.url)),
    'utf8'
  )
  assert.match(source, /host: '127\.0\.0\.1'/)
  assert.doesNotMatch(source, /host: '0\.0\.0\.0'/)
})
