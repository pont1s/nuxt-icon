import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IconifyJSON } from '@iconify/types'
import {
  fetchRemoteCollection,
  fetchRemoteCollections,
  getRemoteCollectionRequests,
  getRemoteEndpoint,
} from '../src/core/remote'
import type { RemoteCollectionSource, ResolvedServerBundleOptions } from '../src/core/types'

const ph: IconifyJSON = {
  prefix: 'ph',
  icons: { acorn: { body: '<path d="M0 0h24v24H0z"/>' } },
  width: 24,
  height: 24,
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), init)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// Stub the global fetch, answering from a URL → response map
function createFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const route = routes[String(url)]
    if (!route)
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') })
    return route()
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function bundle(
  collections: ResolvedServerBundleOptions['collections'],
  remote: RemoteCollectionSource | false,
): ResolvedServerBundleOptions {
  return { disabled: false, remote, collections, externalizeIconsJson: false, fetchRemoteAtBuild: true }
}

describe('getRemoteEndpoint', () => {
  it('resolves built-in sources', () => {
    expect(getRemoteEndpoint('ph', 'jsdelivr')).toBe('https://cdn.jsdelivr.net/npm/@iconify-json/ph/icons.json')
    expect(getRemoteEndpoint('ph', 'unpkg')).toBe('https://unpkg.com/@iconify-json/ph/icons.json')
    expect(getRemoteEndpoint('ph', 'github-raw')).toBe('https://raw.githubusercontent.com/iconify/icon-sets/master/json/ph.json')
  })

  it('resolves a custom function', () => {
    expect(getRemoteEndpoint('ph', name => `https://icons.example.com/${name}.json`)).toBe('https://icons.example.com/ph.json')
  })

  it('throws on an unknown source', () => {
    expect(() => getRemoteEndpoint('ph', 'foo' as RemoteCollectionSource)).toThrow('Unknown remote collection source: foo')
  })
})

describe('getRemoteCollectionRequests', () => {
  it('lists string collections with a remote source', () => {
    expect(getRemoteCollectionRequests(bundle(['ph', 'uil'], 'unpkg'))).toEqual([
      { prefix: 'ph', url: 'https://unpkg.com/@iconify-json/ph/icons.json' },
      { prefix: 'uil', url: 'https://unpkg.com/@iconify-json/uil/icons.json' },
    ])
    expect(getRemoteCollectionRequests(bundle(['ph'], name => `https://icons.example.com/${name}.json`))).toEqual([
      { prefix: 'ph', url: 'https://icons.example.com/ph.json' },
    ])
  })

  it('lists `fetchEndpoint` entries, even without a remote source', () => {
    const collections = [
      'ph',
      { prefix: 'custom', fetchEndpoint: 'https://icons.example.com/custom.json' },
    ]
    expect(getRemoteCollectionRequests(bundle(collections, false))).toEqual([
      { prefix: 'custom', url: 'https://icons.example.com/custom.json' },
    ])
    expect(getRemoteCollectionRequests(bundle(collections, 'jsdelivr'))).toEqual([
      { prefix: 'ph', url: 'https://cdn.jsdelivr.net/npm/@iconify-json/ph/icons.json' },
      { prefix: 'custom', url: 'https://icons.example.com/custom.json' },
    ])
  })

  it('requests a prefix listed more than once from its last entry', () => {
    expect(getRemoteCollectionRequests(bundle([
      'ph',
      { prefix: 'ph', fetchEndpoint: 'https://icons.example.com/ph.json' },
      'uil',
    ], 'jsdelivr'))).toEqual([
      { prefix: 'ph', url: 'https://icons.example.com/ph.json' },
      { prefix: 'uil', url: 'https://cdn.jsdelivr.net/npm/@iconify-json/uil/icons.json' },
    ])
  })

  it('skips inline IconifyJSON collections', () => {
    expect(getRemoteCollectionRequests(bundle([{ ...ph, prefix: 'inline' }], 'jsdelivr'))).toEqual([])
  })
})

describe('fetchRemoteCollection', () => {
  const request = { prefix: 'ph', url: 'https://icons.example.com/ph.json' }

  it('returns the collection', async () => {
    const fetch = createFetch({ [request.url]: () => jsonResponse(ph) })
    await expect(fetchRemoteCollection(request)).resolves.toEqual(ph)
    expect(fetch).toHaveBeenCalledWith(request.url, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('rejects HTTP errors', async () => {
    createFetch({ [request.url]: () => jsonResponse('Not Found', { status: 404, statusText: 'Not Found' }) })
    await expect(fetchRemoteCollection(request)).rejects.toThrow('HTTP 404 Not Found')
  })

  it('rejects invalid JSON', async () => {
    createFetch({ [request.url]: () => jsonResponse('<html>') })
    await expect(fetchRemoteCollection(request)).rejects.toThrow('response is not valid JSON')
  })

  it.each([
    ['an empty object', {}],
    ['a collection without icons', { prefix: 'ph' }],
    ['null', null],
    ['an array', []],
  ])('rejects %s', async (_, body) => {
    createFetch({ [request.url]: () => jsonResponse(body) })
    await expect(fetchRemoteCollection(request)).rejects.toThrow('response is not an IconifyJSON (missing `prefix`/`icons`)')
  })

  it('rejects a prefix mismatch', async () => {
    createFetch({ [request.url]: () => jsonResponse({ ...ph, prefix: 'uil' }) })
    await expect(fetchRemoteCollection(request)).rejects.toThrow('prefix mismatch: expected "ph", got "uil"')
  })

  it('rejects network errors', async () => {
    createFetch({})
    await expect(fetchRemoteCollection(request)).rejects.toThrow('request failed: fetch failed (connect ECONNREFUSED)')
  })

  it('rejects on timeout while reading the body', async () => {
    // Sends the headers and part of the body, then stalls until the signal aborts
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"prefix":"ph",'))
        init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason))
      },
    }))))
    await expect(fetchRemoteCollection(request, { timeout: 10 })).rejects.toThrow('request timed out after 10ms')
  })

  it('rejects on timeout', async () => {
    // Never answers, only rejects when the signal aborts
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })))
    await expect(fetchRemoteCollection(request, { timeout: 10 })).rejects.toThrow('request timed out after 10ms')
  })
})

describe('fetchRemoteCollections', () => {
  it('returns a map of collections by prefix', async () => {
    const uil = { ...ph, prefix: 'uil' }
    createFetch({
      'https://icons.example.com/ph.json': () => jsonResponse(ph),
      'https://icons.example.com/uil.json': () => jsonResponse(uil),
    })
    const result = await fetchRemoteCollections([
      { prefix: 'ph', url: 'https://icons.example.com/ph.json' },
      { prefix: 'uil', url: 'https://icons.example.com/uil.json' },
    ])
    expect(result).toEqual(new Map([['ph', ph], ['uil', uil]]))
  })

  it('returns an empty map without requests', async () => {
    const fetch = createFetch({})
    await expect(fetchRemoteCollections([])).resolves.toEqual(new Map())
    expect(fetch).not.toHaveBeenCalled()
  })

  it('throws a single error listing every failed collection', async () => {
    createFetch({
      'https://icons.example.com/ph.json': () => jsonResponse('', { status: 404, statusText: 'Not Found' }),
      'https://icons.example.com/uil.json': () => jsonResponse({ ...ph, prefix: 'uil' }),
    })
    const error: Error = await fetchRemoteCollections([
      { prefix: 'ph', url: 'https://icons.example.com/ph.json' },
      { prefix: 'uil', url: 'https://icons.example.com/uil.json' },
      { prefix: 'foo', url: 'https://icons.example.com/foo.json' },
    ]).catch(e => e)

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe([
      '[@nuxt/icon] Failed to download 2 remote collection(s) for the server bundle (`serverBundle.fetchRemoteAtBuild`):',
      '  - ph: https://icons.example.com/ph.json → HTTP 404 Not Found',
      '  - foo: https://icons.example.com/foo.json → request failed: fetch failed (connect ECONNREFUSED)',
    ].join('\n'))
    expect(error.cause).toBeInstanceOf(AggregateError)
    expect((error.cause as AggregateError).errors.map(e => (e as Error).message)).toEqual([
      'HTTP 404 Not Found',
      'request failed: fetch failed (connect ECONNREFUSED)',
    ])
  })
})
