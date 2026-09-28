import { readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildNuxt, loadNuxt } from '@nuxt/kit'
import { fetch, getServerLogs, setup, startServer, useTestContext } from '@nuxt/test-utils/e2e'

// A remote icon provider serving `@iconify-json/ph`, counting the requests it receives
const ph = readFileSync(createRequire(import.meta.url).resolve('@iconify-json/ph/icons.json'))
const hits: string[] = []
const remote = createServer((req, res) => {
  hits.push(req.url || '')
  if (req.url?.startsWith('/fail/')) {
    res.writeHead(500, 'Internal Server Error')
    res.end()
    return
  }
  if (req.url === '/ph.json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(ph)
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
process.env.NUXT_ICON_TEST_REMOTE = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`

afterAll(() => {
  remote.close()
})

const rootDir = fileURLToPath(new URL('./fixtures/remote-at-build', import.meta.url))

describe('serverBundle.fetchRemoteAtBuild', async () => {
  await setup({
    rootDir,
    build: true,
    // Started below: its readiness probe already renders the page, so hits made
    // while building must be recorded before the server starts
    server: false,
    browser: false,
  })

  let buildHits: string[] = []
  beforeAll(async () => {
    buildHits = hits.splice(0)
    await startServer()
  })

  it('downloads remote collections once while building', () => {
    expect(buildHits).toEqual(['/ph.json'])
  })

  it('does not reference the remote URL in the server output', () => {
    const serverDir = join(useTestContext().nuxt!.options.nitro.output!.dir!, 'server')
    const code = readdirSync(serverDir, { recursive: true, encoding: 'utf8' })
      .filter(file => file.endsWith('.mjs'))
      .map(file => readFileSync(join(serverDir, file), 'utf8'))
      .join('\n')
    expect(code).not.toContain('createRemoteCollection("')
    expect(code).not.toContain(`${process.env.NUXT_ICON_TEST_REMOTE}/ph.json`)
  })

  it('renders icons without requesting the remote provider at runtime', async () => {
    const response = await fetch('/')
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('class="iconify i-ph:acorn-bold"')
    expect(html).toContain('data:image/svg+xml')
    expect(getServerLogs().join('\n')).not.toContain('[Icon] failed to load icon')
    expect(hits).toEqual([])
  })
})

describe('serverBundle.fetchRemoteAtBuild failures and non-build loads', () => {
  it('fails the build when a remote collection cannot be downloaded', async () => {
    const env = process.env.NUXT_ICON_TEST_REMOTE
    process.env.NUXT_ICON_TEST_REMOTE = `${env}/fail`
    hits.length = 0
    try {
      // Loading makes no requests, collections are downloaded when the Nitro server is built
      const nuxt = await loadNuxt({ cwd: rootDir, dev: false })
      try {
        expect(hits).toEqual([])
        await expect(buildNuxt(nuxt)).rejects.toThrow(
          /Failed to download 1 remote collection.*\n\s+- ph: .*\/fail\/ph\.json → HTTP 500 Internal Server Error/,
        )
        expect(hits).toEqual(['/fail/ph.json'])
      }
      finally {
        await nuxt.close()
      }
    }
    finally {
      process.env.NUXT_ICON_TEST_REMOTE = env
    }
  })

  it('makes no requests when loading Nuxt in a test environment', async () => {
    hits.length = 0
    // As the @nuxt/test-utils Vitest environment does
    const nuxt = await loadNuxt({ cwd: rootDir, dev: false, overrides: { test: true } })
    await nuxt.close()
    expect(hits).toEqual([])
  })
})
