import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const skillPaths = [
  {
    file: 'skills/modelport-management-api/SKILL.md',
    name: 'modelport-management-api',
    description:
      "Use when operating ModelPort Manager's management API for testing, including health checks, config snapshots, temporary API keys, model mappings, sessions, logs, and cleanup verification.",
  },
  {
    file: 'skills/modelport-har-tool-fixture/SKILL.md',
    name: 'modelport-har-tool-fixture',
    description:
      'Use when converting OpenAI-compatible client HAR files into sanitized replayable ModelPort tool-calling fixtures.',
  },
  {
    file: 'skills/modelport-tool-client-replay/SKILL.md',
    name: 'modelport-tool-client-replay',
    description:
      'Use when replaying sanitized client tool-calling fixtures against ModelPort with client-specific pass/fail rules.',
  },
  {
    file: 'skills/modelport-provider-model-matrix/SKILL.md',
    name: 'modelport-provider-model-matrix',
    description:
      'Use when running ModelPort provider and model matrix tests using live /v1/models discovery and management API attribution.',
  },
  {
    file: 'skills/modelport-proxy-testing/SKILL.md',
    name: 'modelport-proxy-testing',
    description:
      'Use when validating ModelPort Manager proxy behavior across dialogue, tool calling, context, provider routing, request logs, and live client replay workflows.',
  },
]

const focusedSkillFiles = skillPaths.filter(({ name }) => name !== 'modelport-proxy-testing').map(({ file }) => file)
const implementedScriptPaths = [
  'skills/modelport-management-api/scripts/management-api.mjs',
  'skills/modelport-har-tool-fixture/scripts/extract-har-fixtures.mjs',
  'skills/modelport-tool-client-replay/scripts/replay-client-fixture.mjs',
  'skills/modelport-provider-model-matrix/scripts/run-model-matrix.mjs',
]

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('versioned ModelPort testing skills exist and have trigger-only descriptions', () => {
  for (const { file, name, description } of skillPaths) {
    // Windows checkouts (core.autocrlf) hand us CRLF; frontmatter is LF on disk.
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    // Skill frontmatter is a discovery contract; keep exact names and descriptions stable.
    assert.match(
      text,
      new RegExp(`^---\\nname: ${escapeRegExp(name)}\\ndescription: ${escapeRegExp(description)}\\n---`, 'm'),
      file,
    )
    assert.doesNotMatch(text, /T[B]D|FI[X]ME|deferred work/, file)
  }
})

test('focused skill docs reference implemented script paths only', () => {
  for (const file of focusedSkillFiles) {
    const text = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /Planned Script/, file)
  }

  for (const file of implementedScriptPaths) {
    assert.equal(fs.existsSync(file), true, file)
  }
})

test('proxy testing skill delegates focused responsibilities', () => {
  const text = fs.readFileSync('skills/modelport-proxy-testing/SKILL.md', 'utf8')
  assert.match(text, /modelport-management-api/)
  assert.match(text, /modelport-har-tool-fixture/)
  assert.match(text, /modelport-tool-client-replay/)
  assert.match(text, /modelport-provider-model-matrix/)
})

test('versioned proxy testing skill warns against ignored local source of truth', () => {
  const text = fs.readFileSync('skills/modelport-proxy-testing/SKILL.md', 'utf8')
  assert.match(text, /versioned source of truth/)
  assert.match(text, /ignored \.codex/)
})
