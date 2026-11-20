import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('Windows bootstrap invokes the pnpm command shim for install and start', {
  skip: process.platform !== 'win32',
}, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'singularity-bootstrap-'))
  try {
    writeFileSync(join(cwd, 'pnpm.cmd'), '@echo off\r\necho %1>>pnpm-calls.txt\r\nexit /b 0\r\n')
    const bootstrap = fileURLToPath(new URL('./bootstrap.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [bootstrap], { cwd, encoding: 'utf8', timeout: 15_000 })

    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.deepEqual(readFileSync(join(cwd, 'pnpm-calls.txt'), 'utf8').trim().split(/\r?\n/), ['install', 'start'])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
