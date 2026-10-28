const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..', '..')

test('IPC handlers no longer import per-provider web adapters', () => {
  const source = readFileSync(join(root, 'src/main/ipc/handlers.ts'), 'utf8')

  assert.doesNotMatch(source, /await import\('\.\.\/proxy\/adapters\//)
  assert.doesNotMatch(source, /proxy\/adapters\/(deepseek|glm|kimi|mimo|minimax|qwen|qwen-ai|zai)/)
  assert.doesNotMatch(source, /const clearChatsHandlers/)
})
