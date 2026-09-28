import fs from 'node:fs/promises'
import { join, relative } from 'node:path'
import { addTemplate } from '@nuxt/kit'
import { hash } from 'ohash'
import type { IconifyJSON } from '@iconify/types'
import { resolveModule } from 'local-pkg'
import type { NuxtIconRuntimeOptions, ResolvedServerBundleOptions } from './types'
import { getResolvePaths } from './collections'
import { getCollectionPath, resolveCollectionFile } from './core/collections'
import { getRemoteCollectionRequests, getRemoteEndpoint } from './core/remote'
import type { NuxtIconModuleContext } from './context'

export function registerServerBundle(
  ctx: NuxtIconModuleContext,
): void {
  const { nuxt } = ctx

  // Bundle icons for server
  const templateServer = addTemplate({
    filename: 'nuxt-icon-server-bundle.mjs',
    write: true,
    async getContents() {
      const bundle = await ctx.resolveServerBundle()
      const { collections, remote } = bundle

      nuxt.options.appConfig.icon ||= {}
      const appIcons = nuxt.options.appConfig.icon as NuxtIconRuntimeOptions
      appIcons.collections ||= []
      for (const collection of collections) {
        const prefix = typeof collection === 'string' ? collection : collection.prefix
        if (!appIcons.collections.includes(prefix))
          appIcons.collections.push(prefix)
      }

      const isBundling = !nuxt.options.dev

      // Remote collections downloaded at build time (`serverBundle.fetchRemoteAtBuild`) are bundled like local
      // collections. They are written by `writeFetchedCollections` before Nitro builds, after this template is generated
      const bundledPrefixes = getBundledRemotePrefixes(ctx, bundle)
      // Unlike the other entries, the key is JSON-quoted as it may come from a user-defined `{ prefix, fetchEndpoint }`
      const bundled = (prefix: string) => bundledPrefixes.has(prefix)
        ? `  ${JSON.stringify(prefix)}: () => import(${JSON.stringify(`./${getFetchedCollectionFilename(prefix)}`)}, { with: { type: 'json' } }).then(m => m.default),`
        : undefined

      const collectionsValues = collections.map((collection) => {
        if (typeof collection === 'string') {
          if (remote) {
            return bundled(collection)
              ?? `  '${collection}': createRemoteCollection(${JSON.stringify(getRemoteEndpoint(collection, remote))}),`
          }

          const resolvePaths = getResolvePaths(nuxt)
          const path = getCollectionPath(collection, resolvePaths)

          if (!isBundling) {
            // When in dev mode, we avoid bundling the icons to improve performance
            // Get rid of the require() when ESM JSON modules are widely supported
            return `  '${collection}': () => require('${path}'),`
          }

          // A collection owned by a layer does not resolve from the app, so the bare specifier above
          // reaches the build unresolved and throws at runtime. Import the resolved file instead
          const file = resolveModule(path, { paths: [nuxt.options.rootDir] })
            ? undefined
            : resolveCollectionFile(collection, resolvePaths)
          if (file) {
            const relPath = relative(nuxt.options.buildDir, file).replaceAll('\\', '/')
            return `  '${collection}': () => import('${relPath.startsWith('.') ? relPath : `./${relPath}`}').then(m => m.default),`
          }

          return `  '${collection}': () => import('${path}', { with: { type: 'json' } }).then(m => m.default),`
        }
        else {
          const { prefix } = collection
          if ('fetchEndpoint' in collection)
            return bundled(prefix)
              ?? `  '${prefix}': createRemoteCollection(${JSON.stringify(collection.fetchEndpoint)}),`
          return `  '${prefix}': () => (${JSON.stringify(collection)}),`
        }
      })

      const lines = [
        ...(isBundling
          ? []
          : [
              `import { createRequire } from 'node:module'`,
              `const require = createRequire(import.meta.url)`,
            ]
        ),
        `function createRemoteCollection(fetchEndpoint) {`,
        '  let _cache',
        '  return async () => {',
        '    if (_cache)',
        '      return _cache',
        '    const res = await fetch(fetchEndpoint).then(r => r.json())',
        '    _cache = res',
        '    return res',
        '  }',
        '}',
        '',
        `export const collections = {`,
        ...collectionsValues,
        '}',
      ]

      return lines.join('\n')
    },
  })

  nuxt.options.nitro.alias ||= {}
  nuxt.options.nitro.alias['#nuxt-icon-server-bundle'] = templateServer.dst
}

/**
 * Prefixes of the remote collections that the server bundle imports from files instead of fetching at runtime
 */
function getBundledRemotePrefixes(ctx: NuxtIconModuleContext, bundle: ResolvedServerBundleOptions): Set<string> {
  const { dev, _prepare } = ctx.nuxt.options
  return new Set(bundle.fetchRemoteAtBuild && !bundle.disabled && !dev && !_prepare
    ? getRemoteCollectionRequests(bundle).map(request => request.prefix)
    : [])
}

/**
 * Download the remote collections (`serverBundle.fetchRemoteAtBuild`) and write them next to the server bundle,
 * which imports them. Rejects when any collection fails to download.
 */
export async function writeFetchedCollections(ctx: NuxtIconModuleContext): Promise<void> {
  try {
    await writeCollections(ctx, await ctx.resolveRemoteCollections())
  }
  finally {
    // Free the downloaded data, and never keep a failed download: a later build retries
    ctx.releaseRemoteCollections()
  }
}

async function writeCollections(ctx: NuxtIconModuleContext, fetched: Map<string, IconifyJSON>): Promise<void> {
  if (!fetched.size)
    return

  // Both are derived from `getRemoteCollectionRequests`, make sure they never drift apart
  const expected = getBundledRemotePrefixes(ctx, await ctx.resolveServerBundle())
  if (expected.size !== fetched.size || [...fetched.keys()].some(prefix => !expected.has(prefix)))
    throw new Error(`[@nuxt/icon] Downloaded remote collections (${[...fetched.keys()].join(', ')}) do not match the server bundle (${[...expected].join(', ')})`)

  const { buildDir } = ctx.nuxt.options
  const dir = join(buildDir, 'nuxt-icon-remote')
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  await Promise.all([...fetched].map(([prefix, json]) =>
    fs.writeFile(join(buildDir, getFetchedCollectionFilename(prefix)), JSON.stringify(json)),
  ))
}

// Iconify prefixes are used as is; anything else (from `{ prefix, fetchEndpoint }` entries) is hashed to a safe file name
function getFetchedCollectionFilename(prefix: string): string {
  const name = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(prefix) ? prefix : `_${hash(prefix)}`
  return `nuxt-icon-remote/${name}.json`
}
