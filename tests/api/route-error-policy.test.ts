import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRouteError } from '../../src/main/proxy/routeErrorPolicy.ts'

const modelsListLayer = { methods: ['HEAD', 'GET'] }
const chatLayer = { methods: ['POST'] }
// koa-router pushes every `use()`-mounted middleware layer into ctx.matched too.
const mountedRouterLayer = { methods: [] }

test('a POST on the GET-only model list is a 405 that names both paths', () => {
  const error = buildRouteError({
    method: 'POST',
    path: '/v1/models',
    matched: [mountedRouterLayer, modelsListLayer],
  })

  assert.equal(error.status, 405)
  assert.equal(error.allow, 'GET, HEAD')
  assert.equal(error.body.error.type, 'invalid_request_error')
  assert.equal(error.body.error.code, 'method_not_allowed')
  assert.match(error.body.error.message, /POST \/v1\/models/)
  assert.match(error.body.error.message, /accepts GET, HEAD/)
  assert.match(error.body.error.message, /POST \/v1\/chat\/completions/)
})

test('a method mismatch on the management API keeps the chat hint out', () => {
  const error = buildRouteError({
    method: 'DELETE',
    path: '/v1/management/config',
    matched: [{ methods: ['GET', 'PUT'] }],
  })

  assert.equal(error.status, 405)
  assert.equal(error.allow, 'GET, PUT')
  assert.doesNotMatch(error.body.error.message, /chat\/completions/)
})

test('an unmatched path stays a 404 and points at the endpoint list', () => {
  for (const matched of [[mountedRouterLayer], [] as { methods: string[] }[], undefined]) {
    const error = buildRouteError({ method: 'POST', path: '/v1/nope', matched })

    assert.equal(error.status, 404)
    assert.equal(error.allow, undefined)
    assert.equal(error.body.error.type, 'invalid_request_error')
    assert.equal(error.body.error.code, 'route_not_found')
    assert.match(error.body.error.message, /Route not found: POST \/v1\/nope/)
    assert.match(error.body.error.message, /GET \//)
  }
})

test('a path whose own method was allowed never claims a method mismatch', () => {
  const error = buildRouteError({
    method: 'POST',
    path: '/v1/chat/completions',
    matched: [mountedRouterLayer, chatLayer],
  })

  assert.equal(error.status, 404)
  assert.doesNotMatch(error.body.error.message, /Method Not Allowed/)
})

test('allowed methods are normalised, de-duplicated and sorted', () => {
  const error = buildRouteError({
    method: 'PATCH',
    path: '/v1/completions',
    matched: [{ methods: ['post', 'POST'] }, { methods: ['get'] }],
  })

  assert.equal(error.status, 405)
  assert.equal(error.allow, 'GET, POST')
})
