import assert from 'node:assert/strict'
import test from 'node:test'
import { assistantBlocks } from '../src/lib/assistantBlocks.ts'

test('prose and inline code remain literal text', () => {
  const text = 'Use `pwd` here.\n<script>alert(1)</script>'
  assert.deepEqual(assistantBlocks(text), [{ kind: 'text', text }])
})

test('multiple code and plain-text fences copy only their exact contents', () => {
  assert.deepEqual(assistantBlocks('Run:\n```sh\n  echo hello\n\n```\nThen:\n~~~text\ncopy me\n~~~'), [
    { kind: 'text', text: 'Run:\n' },
    { kind: 'code', text: '  echo hello\n\n', language: 'sh' },
    { kind: 'text', text: 'Then:\n' },
    { kind: 'code', text: 'copy me\n', language: 'text' },
  ])
})

test('unfinished streaming blocks retain content through completion', () => {
  const prefix = '```json\n{\n  "key": "value"'
  assert.deepEqual(assistantBlocks(prefix), [{ kind: 'code', text: '{\n  "key": "value"', language: 'json' }])
  assert.deepEqual(assistantBlocks(prefix + '\n}\n```\n'), [{ kind: 'code', text: '{\n  "key": "value"\n}\n', language: 'json' }])
  assert.deepEqual(assistantBlocks('```'), [{ kind: 'code', text: '', language: '' }])
})

test('closing fences must match the opening marker and length', () => {
  assert.deepEqual(assistantBlocks('````md\n```\n~~~\n`````\n'), [
    { kind: 'code', text: '```\n~~~\n', language: 'md' },
  ])
})

test('CRLF, indentation, Unicode, and trailing whitespace are preserved', () => {
  assert.deepEqual(assistantBlocks('  ```text\r\n\t資料  \r\n  ```\r\n'), [
    { kind: 'code', text: '\t資料  \r\n', language: 'text' },
  ])
})
