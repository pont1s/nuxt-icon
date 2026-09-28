import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IconifyJSON } from '@iconify/types'
import type { Nuxt } from 'nuxt/schema'
import type { ModuleOptions, ServerBundleOptions } from '../src/types'
import { NuxtIconModuleContext } from '../src/context'
import { registerServerBundle, writeFetchedCollections } from '../src/bundle-server'
import { logger } from '@nuxt/kit'

interface Template { filename: string, getContents: () => string | Promise<string> }

const templates = vi.hoisted(() => new Map<string, Template>())

vi.mock('@nuxt/kit', async (importOriginal) => {
  const kit = await importOriginal<typeof import('@nuxt/kit')>()
  return {
    ...kit,
    addTemplate: (template: Template) => {
      templates.set(template.filename, template)
      return { ...template, dst: `/virtual/.nuxt/${template.filename}` }
    },
  }
})

const ph: IconifyJSON = {
  prefix: 'ph',
  icons: { 'acorn-bold': { body: '<path d="M0 0h24v24H0z"/>' } },
  width: 256,
  height: 256,
}
const custom: IconifyJSON = {
  prefix: 'custom',
  icons: { 'it\'s': { body: '<path d="M1 1h2v2H1z" data-x="`${1}` </script>"/>' } },
}

const payloads: Record<string, IconifyJSON> = {
  'https://icons.example.com/ph.json': ph,
  'https://icons.example.com/custom.json': custom,
}

// `https://icons.example.com/c/<prefix>` serves a one-icon collection for any (URI-encoded) prefix
function getPayload(url: string): IconifyJSON | undefined {
  const match = url.match(/^https:\/\/icons\.example\.com\/c\/(.+)$/)
  return match
    ? { prefix: decodeURIComponent(match[1]!), icons: { x: { body: '' } } }
    : payloads[url]
}

const fetchStub = vi.fn(async (url: string | URL | Request) => {
  const body = getPayload(String(url))
  return body
    ? new Response(JSON.stringify(body))
    : new Response('Not Found', { status: 404, statusText: 'Not Found' })
})

const tempDirs: string[] = []

beforeEach(() => {
  templates.clear()
  fetchStub.mockClear()
  vi.stubGlobal('fetch', fetchStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

const baseServerBundle = {
  remote: (name: string) => `https://icons.example.com/${name}.json`,
  collections: [
    'ph',
    { prefix: 'custom', fetchEndpoint: 'https://icons.example.com/custom.json' },
  ],
} satisfies ServerBundleOptions

function createContext(
  serverBundle: ModuleOptions['serverBundle'],
  nuxtOptions: { dev?: boolean, _prepare?: boolean } = {},
  provider: ModuleOptions['provider'] = 'server',
) {
  const buildDir = mkdtempSync(join(tmpdir(), 'nuxt-icon-server-bundle-'))
  tempDirs.push(buildDir)
  const nuxt = {
    options: {
      dev: false,
      _prepare: false,
      rootDir: '/virtual',
      buildDir,
      nitro: {},
      appConfig: {},
      _layers: [],
      ...nuxtOptions,
    },
  } as unknown as Nuxt
  return new NuxtIconModuleContext(nuxt, { provider, serverBundle } as ModuleOptions)
}

// Mimic a build: module setup, template generation, then `nitro:build:before` (see `module.ts`)
async function build(ctx: NuxtIconModuleContext) {
  const { buildDir } = ctx.nuxt.options
  registerServerBundle(ctx)
  const code = await templates.get('nuxt-icon-server-bundle.mjs')!.getContents()
  const fetchesBeforeBuild = fetchStub.mock.calls.length
  await writeFetchedCollections(ctx)
  writeFileSync(join(buildDir, 'nuxt-icon-server-bundle.mjs'), code)
  const files = readdirSync(buildDir, { recursive: true, encoding: 'utf8' })
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => file.endsWith('.json') || file.endsWith('.mjs'))
    .sort()
  return { code, files, fetchesBeforeBuild }
}

async function importServerBundle(ctx: NuxtIconModuleContext): Promise<{ collections: Record<string, () => Promise<unknown>> }> {
  return import(/* @vite-ignore */ pathToFileURL(join(ctx.nuxt.options.buildDir, 'nuxt-icon-server-bundle.mjs')).href)
}

describe('serverBundle.fetchRemoteAtBuild', () => {
  it('bundles remote collections into the server bundle', async () => {
    const ctx = createContext({ ...baseServerBundle, fetchRemoteAtBuild: true })
    const { code, files, fetchesBeforeBuild } = await build(ctx)

    // Generating the template makes no requests, they happen in `writeFetchedCollections`
    expect(fetchesBeforeBuild).toBe(0)
    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(files).toEqual([
      'nuxt-icon-remote/custom.json',
      'nuxt-icon-remote/ph.json',
      'nuxt-icon-server-bundle.mjs',
    ])
    expect(code).not.toContain('createRemoteCollection("')
    expect(code).toContain(`"ph": () => import("./nuxt-icon-remote/ph.json", { with: { type: 'json' } }).then(m => m.default),`)

    fetchStub.mockClear()
    const { collections } = await importServerBundle(ctx)
    await expect(collections.ph!()).resolves.toEqual(ph)
    await expect(collections.custom!()).resolves.toEqual(custom)
    // Loaded once, then cached
    expect(await collections.ph!()).toBe(await collections.ph!())
    // Loading the collections makes no requests
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('downloads the collections once while building', async () => {
    const ctx = createContext({ ...baseServerBundle, fetchRemoteAtBuild: true })
    const [a, b] = await Promise.all([ctx.resolveRemoteCollections(), ctx.resolveRemoteCollections()])
    expect(a).toBe(b)
    await writeFetchedCollections(ctx)
    expect(fetchStub).toHaveBeenCalledTimes(2)
  })

  it('downloads and writes again on every build', async () => {
    const ctx = createContext({ ...baseServerBundle, fetchRemoteAtBuild: true })
    const file = join(ctx.nuxt.options.buildDir, 'nuxt-icon-remote/ph.json')
    await writeFetchedCollections(ctx)
    expect(fetchStub).toHaveBeenCalledTimes(2)

    writeFileSync(file, '{}')
    await writeFetchedCollections(ctx)
    expect(fetchStub).toHaveBeenCalledTimes(4)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(ph)
  })

  it('retries a failed download on the next build', async () => {
    const ctx = createContext({ ...baseServerBundle, fetchRemoteAtBuild: true })
    fetchStub.mockImplementationOnce(async () => new Response('', { status: 503, statusText: 'Service Unavailable' }))
    await expect(writeFetchedCollections(ctx)).rejects.toThrow('HTTP 503 Service Unavailable')

    await writeFetchedCollections(ctx)
    const read = (file: string) => JSON.parse(readFileSync(join(ctx.nuxt.options.buildDir, file), 'utf8'))
    expect(read('nuxt-icon-remote/ph.json')).toEqual(ph)
    expect(read('nuxt-icon-remote/custom.json')).toEqual(custom)
  })

  it('writes exactly the collections the server bundle imports', async () => {
    const ctx = createContext({
      remote: (name: string) => `https://icons.example.com/${name}.json`,
      // `ph` listed twice (last entry wins), an inline collection, a stale file from a previous build
      collections: ['ph', { prefix: 'ph', fetchEndpoint: 'https://icons.example.com/ph.json' }, custom],
      fetchRemoteAtBuild: true,
    })
    const stale = join(ctx.nuxt.options.buildDir, 'nuxt-icon-remote')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'old.json'), '{}')

    const { code, files } = await build(ctx)
    const imported = [...new Set([...code.matchAll(/import\("\.\/(nuxt-icon-remote\/[^"]+)"/g)].map(m => m[1]))]
    expect(imported).toEqual(['nuxt-icon-remote/ph.json'])
    expect(files.filter(file => file.startsWith('nuxt-icon-remote/'))).toEqual(imported)
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('uses safe file names for any prefix', async () => {
    const prefixes = ['a/b', '../x', 'A*b', 'ph-duo']
    const ctx = createContext({
      remote: false,
      collections: prefixes.map(prefix => ({ prefix, fetchEndpoint: `https://icons.example.com/c/${encodeURIComponent(prefix)}` })),
      fetchRemoteAtBuild: true,
    })
    const { files } = await build(ctx)
    const collectionFiles = files.filter(f => f !== 'nuxt-icon-server-bundle.mjs')
    expect(collectionFiles).toHaveLength(prefixes.length)
    for (const filename of collectionFiles)
      expect(filename).toMatch(/^nuxt-icon-remote\/[\w-]+\.json$/)
    expect(collectionFiles).toContain('nuxt-icon-remote/ph-duo.json')

    const { collections } = await importServerBundle(ctx)
    for (const prefix of prefixes)
      await expect(collections[prefix]!()).resolves.toMatchObject({ prefix })
  })

  it('fails when a collection cannot be downloaded', async () => {
    const ctx = createContext({
      ...baseServerBundle,
      collections: [...baseServerBundle.collections, 'missing'],
      fetchRemoteAtBuild: true,
    })
    await expect(writeFetchedCollections(ctx)).rejects.toThrow(
      /Failed to download 1 remote collection\(s\)[\s\S]*- missing: https:\/\/icons\.example\.com\/missing\.json → HTTP 404 Not Found/,
    )
  })

  it('keeps the output unchanged when disabled', async () => {
    const withoutFlag = await build(createContext(baseServerBundle))
    const disabled = await build(createContext({ ...baseServerBundle, fetchRemoteAtBuild: false }))

    expect(disabled).toEqual(withoutFlag)
    expect(disabled.files).toEqual(['nuxt-icon-server-bundle.mjs'])
    expect(fetchStub).not.toHaveBeenCalled()
    // Only the collections object: the `createRemoteCollection` helper is not affected by this option
    const { code } = disabled
    expect(code.slice(code.indexOf('export const collections'))).toMatchInlineSnapshot(`
      "export const collections = {
        'ph': createRemoteCollection("https://icons.example.com/ph.json"),
        'custom': createRemoteCollection("https://icons.example.com/custom.json"),
      }"
    `)
  })

  it('is skipped in development', async () => {
    const ctx = createContext({ ...baseServerBundle, fetchRemoteAtBuild: true }, { dev: true })
    await expect(ctx.resolveRemoteCollections()).resolves.toEqual(new Map())

    const { code, files } = await build(ctx)
    expect(files).toEqual(['nuxt-icon-server-bundle.mjs'])
    expect(code).toContain(`'ph': createRemoteCollection("https://icons.example.com/ph.json")`)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('is skipped in `nuxi prepare`', async () => {
    const ctx = createContext({ ...baseServerBundle, fetchRemoteAtBuild: true }, { _prepare: true })
    const { code, files } = await build(ctx)
    expect(files).toEqual(['nuxt-icon-server-bundle.mjs'])
    expect(code).not.toContain('nuxt-icon-remote/')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('warns when the server bundle is disabled', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const ctx = createContext({ ...baseServerBundle, fetchRemoteAtBuild: true }, {}, 'iconify')
      await expect(ctx.resolveRemoteCollections()).resolves.toEqual(new Map())
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('server bundle is disabled'))
    }
    finally {
      warn.mockRestore()
    }
  })

  it('warns when there is no remote collection', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const ctx = createContext({ collections: [custom], fetchRemoteAtBuild: true })
      await expect(ctx.resolveRemoteCollections()).resolves.toEqual(new Map())
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no remote collections'))
      expect(fetchStub).not.toHaveBeenCalled()
    }
    finally {
      warn.mockRestore()
    }
  })

  it('does not warn when the option is off', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      await createContext({ collections: [custom] }).resolveRemoteCollections()
      await createContext(baseServerBundle, {}, 'iconify').resolveRemoteCollections()
      expect(warn).not.toHaveBeenCalled()
    }
    finally {
      warn.mockRestore()
    }
  })

  it('does nothing for string server bundle modes', async () => {
    const ctx = createContext('remote')
    expect((await ctx.resolveServerBundle()).fetchRemoteAtBuild).toBe(false)
    await expect(ctx.resolveRemoteCollections()).resolves.toEqual(new Map())
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it.each([
    ['production builds', {}],
    ['development', { dev: true }],
    ['`nuxi prepare`', { _prepare: true }],
  ])('requires explicit collections with a remote source in %s', async (_, nuxtOptions) => {
    const ctx = createContext({ remote: 'jsdelivr', fetchRemoteAtBuild: true }, nuxtOptions)
    await expect(ctx.resolveServerBundle()).rejects.toThrow(
      '`serverBundle.fetchRemoteAtBuild` requires `serverBundle.collections` to be set explicitly',
    )
  })
})
