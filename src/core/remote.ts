import type { IconifyJSON } from '@iconify/types'
import { consola } from 'consola'
import type { RemoteCollectionSource, ResolvedServerBundleOptions } from './types'

const logger = consola.withTag('nuxt:icon')

export interface RemoteCollectionRequest {
  prefix: string
  url: string
}

export interface FetchRemoteCollectionOptions {
  /**
   * Timeout of each request in milliseconds, including reading the response body
   *
   * @default 60000
   */
  timeout?: number
}

export const REMOTE_COLLECTION_FETCH_TIMEOUT = 60_000

export function getRemoteEndpoint(name: string, source: RemoteCollectionSource): string {
  if (typeof source === 'function')
    return source(name)

  switch (source) {
    case 'jsdelivr':
      return `https://cdn.jsdelivr.net/npm/@iconify-json/${name}/icons.json`
    case 'unpkg':
      return `https://unpkg.com/@iconify-json/${name}/icons.json`
    case 'github-raw':
      return `https://raw.githubusercontent.com/iconify/icon-sets/master/json/${name}.json`
    default:
      throw new Error(`Unknown remote collection source: ${source}`)
  }
}

/**
 * List the collections of a resolved server bundle that are loaded from a remote URL.
 * A prefix listed more than once is requested once, from its last entry, as in the generated server bundle.
 */
export function getRemoteCollectionRequests(bundle: ResolvedServerBundleOptions): RemoteCollectionRequest[] {
  const requests = new Map<string, RemoteCollectionRequest>()
  for (const collection of bundle.collections) {
    if (typeof collection === 'string') {
      if (bundle.remote) {
        requests.delete(collection)
        requests.set(collection, { prefix: collection, url: getRemoteEndpoint(collection, bundle.remote) })
      }
    }
    else if ('fetchEndpoint' in collection) {
      requests.delete(collection.prefix)
      requests.set(collection.prefix, { prefix: collection.prefix, url: collection.fetchEndpoint })
    }
  }
  return [...requests.values()]
}

function isTimeout(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error as Error | undefined)?.name === 'TimeoutError'
}

export async function fetchRemoteCollection(
  request: RemoteCollectionRequest,
  options: FetchRemoteCollectionOptions = {},
): Promise<IconifyJSON> {
  const { timeout = REMOTE_COLLECTION_FETCH_TIMEOUT } = options
  const signal = AbortSignal.timeout(timeout)

  let res: Response
  try {
    res = await fetch(request.url, { signal })
  }
  catch (error) {
    if (isTimeout(error, signal))
      throw new Error(`request timed out after ${timeout}ms`, { cause: error })
    // Node.js reports network errors as `fetch failed` and keeps the reason (e.g. `ECONNREFUSED`) in `cause`
    const reason = ((error as Error | undefined)?.cause as Error | undefined)?.message
    throw new Error(`request failed: ${(error as Error | undefined)?.message || error}${reason ? ` (${reason})` : ''}`, { cause: error })
  }

  if (!res.ok)
    throw new Error(`HTTP ${res.status} ${res.statusText}`.trim())

  let data: unknown
  try {
    data = await res.json()
  }
  catch (error) {
    // The timeout also covers reading the body, which aborts the stream
    if (isTimeout(error, signal))
      throw new Error(`request timed out after ${timeout}ms`, { cause: error })
    throw new Error('response is not valid JSON', { cause: error })
  }

  const json = data as Partial<IconifyJSON> | null
  if (!json || typeof json !== 'object' || typeof json.prefix !== 'string' || !json.icons || typeof json.icons !== 'object')
    throw new Error('response is not an IconifyJSON (missing `prefix`/`icons`)')

  if (json.prefix !== request.prefix)
    throw new Error(`prefix mismatch: expected "${request.prefix}", got "${json.prefix}"`)

  return json as IconifyJSON
}

/**
 * Download all remote collections in parallel.
 * Throws a single error listing every collection that failed to download.
 */
export async function fetchRemoteCollections(
  requests: RemoteCollectionRequest[],
  options?: FetchRemoteCollectionOptions,
): Promise<Map<string, IconifyJSON>> {
  if (!requests.length)
    return new Map()

  logger.info(`Downloading ${requests.length} remote collection(s) for the server bundle...`)

  const results = await Promise.allSettled(
    requests.map(request => fetchRemoteCollection(request, options)),
  )

  const collections = new Map<string, IconifyJSON>()
  const failures: { request: RemoteCollectionRequest, error: unknown }[] = []

  results.forEach((result, index) => {
    const request = requests[index]!
    if (result.status === 'fulfilled')
      collections.set(request.prefix, result.value)
    else
      failures.push({ request, error: result.reason })
  })

  if (failures.length) {
    throw new Error(
      [
        `[@nuxt/icon] Failed to download ${failures.length} remote collection(s) for the server bundle (\`serverBundle.fetchRemoteAtBuild\`):`,
        ...failures.map(({ request, error }) =>
          `  - ${request.prefix}: ${request.url} → ${(error as Error | undefined)?.message || error}`,
        ),
      ].join('\n'),
      { cause: new AggregateError(failures.map(f => f.error), 'Remote collection downloads failed') },
    )
  }

  const icons = [...collections.values()].reduce((count, json) => count + Object.keys(json.icons).length, 0)
  logger.success(`Downloaded ${collections.size} remote collection(s) with ${icons} icons: ${[...collections.keys()].map(p => `\`${p}\``).join(', ')}`)

  return collections
}
