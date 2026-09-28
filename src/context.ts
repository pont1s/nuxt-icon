import type { Nuxt } from 'nuxt/schema'
import type { IconifyJSON } from '@iconify/types'
import { provider } from 'std-env'
import { logger } from '@nuxt/kit'
import { collectionNames } from './collection-names'
import type { ModuleOptions, NuxtIconRuntimeOptions, ResolvedServerBundleOptions } from './types'
import { getResolvePaths } from './collections'
import { discoverInstalledCollections, loadCustomCollection, resolveCollection } from './core/collections'
import { fetchRemoteCollections, getRemoteCollectionRequests } from './core/remote'
import { IconUsageScanner } from './core/scan'
import { resolveBundleIcons, type ResolvedBundleIcons } from './core/bundle'

const KEYWORDS_EDGE_TARGETS: string[] = [
  'edge',
  'cloudflare',
  'worker',
]

export class NuxtIconModuleContext {
  constructor(
    public readonly nuxt: Nuxt,
    public readonly options: ModuleOptions,
  ) { }

  public clientBundleVersion = 0
  public scannedIcons = new Set<string>()
  public scanner: IconUsageScanner | undefined

  getRuntimeCollections(runtimeOptions: NuxtIconRuntimeOptions): string[] {
    const resolved = runtimeOptions.fallbackToApi
      ? collectionNames
      : typeof this.options.serverBundle === 'string'
        ? collectionNames
        : this.options.serverBundle
          ? this.options.serverBundle.collections
            ?.map(c => typeof c === 'string' ? c : c.prefix) || []
          : []

    // Include custom collections prefixes
    for (const collection of this.options.customCollections || []) {
      if (collection.prefix && !resolved.includes(collection.prefix))
        resolved.push(collection.prefix)
    }

    return resolved
  }

  private _customCollections: IconifyJSON[] | Promise<IconifyJSON[]> | undefined
  private _serverBundle: ResolvedServerBundleOptions | Promise<ResolvedServerBundleOptions> | undefined
  private _nitroPreset: string | undefined

  setNitroPreset(preset: string | undefined): void {
    this._nitroPreset = preset || this._nitroPreset
  }

  async resolveServerBundle(): Promise<ResolvedServerBundleOptions> {
    if (!this._serverBundle) {
      this._serverBundle = this._resolveServerBundle()
        .then((bundle) => {
          if (this._serverBundle)
            this._serverBundle = bundle
          return bundle
        })
    }
    return this._serverBundle
  }

  private async _resolveServerBundle(): Promise<ResolvedServerBundleOptions> {
    let serverBundle = this.options.serverBundle
    if (serverBundle === 'auto') {
      const preset = this._nitroPreset || (typeof this.nuxt.options.nitro.preset === 'string'
        ? this.nuxt.options.nitro.preset || provider
        : provider)

      serverBundle = 'local'

      if (!this.nuxt.options.dev && KEYWORDS_EDGE_TARGETS.some(
        word =>
          (typeof preset === 'string' && preset.includes(word))
          || process.env.NITRO_PRESET?.includes(word)
          || process.env.SERVER_PRESET?.includes(word),
      ))
        serverBundle = 'remote'

      logger.info(`Nuxt Icon server bundle mode is set to \`${serverBundle}\``)
    }

    const resolved = (!serverBundle || this.options.provider !== 'server')
      ? { disabled: true }
      : typeof serverBundle === 'string'
        ? { remote: serverBundle === 'remote' }
        : serverBundle

    if (resolved.disabled) {
      return {
        disabled: true,
        remote: false,
        externalizeIconsJson: false,
        fetchRemoteAtBuild: false,
        collections: [],
      }
    }

    if (resolved.fetchRemoteAtBuild && resolved.remote && !resolved.collections)
      throw new Error('[@nuxt/icon] `serverBundle.fetchRemoteAtBuild` requires `serverBundle.collections` to be set explicitly')

    if (!resolved.collections)
      resolved.collections = resolved.remote
        ? collectionNames
        : await discoverInstalledCollections(getResolvePaths(this.nuxt))

    const collections = await Promise.all(
      (resolved.collections || [])
        .map(c => resolveCollection(c, this.nuxt.options.rootDir)),
    )

    return {
      disabled: false,
      remote: resolved.remote === true
        ? 'jsdelivr' // Default remote source
        : resolved.remote || false,
      externalizeIconsJson: !!resolved.externalizeIconsJson,
      fetchRemoteAtBuild: !!resolved.fetchRemoteAtBuild,
      collections: [
        ...collections,
        ...await this.loadCustomCollection(),
      ],
    }
  }

  private _remoteCollections: Promise<Map<string, IconifyJSON>> | undefined

  /**
   * Download the remote collections of the server bundle when `serverBundle.fetchRemoteAtBuild` is enabled.
   * The result is cached, so collections are downloaded once per process.
   * Resolves to an empty map when the option is off, in development and in `nuxi prepare`.
   */
  async resolveRemoteCollections(): Promise<Map<string, IconifyJSON>> {
    this._remoteCollections ||= this._resolveRemoteCollections()
    return this._remoteCollections
  }

  /**
   * Drop the downloaded collections once they are written, so they can be garbage collected
   */
  releaseRemoteCollections(): void {
    this._remoteCollections = undefined
  }

  private async _resolveRemoteCollections(): Promise<Map<string, IconifyJSON>> {
    const serverBundle = this.options.serverBundle
    if (typeof serverBundle !== 'object' || !serverBundle?.fetchRemoteAtBuild)
      return new Map()

    const bundle = await this.resolveServerBundle()
    if (bundle.disabled) {
      logger.warn('`serverBundle.fetchRemoteAtBuild` has no effect because the server bundle is disabled (it requires `provider: \'server\'`)')
      return new Map()
    }

    const requests = getRemoteCollectionRequests(bundle)
    if (!requests.length) {
      logger.warn('`serverBundle.fetchRemoteAtBuild` has no effect because the server bundle has no remote collections (set `serverBundle.remote` or add `{ prefix, fetchEndpoint }` collections)')
      return new Map()
    }

    if (this.nuxt.options._prepare)
      return new Map()
    if (this.nuxt.options.dev) {
      logger.info('`serverBundle.fetchRemoteAtBuild` is skipped in development; remote collections are fetched at runtime')
      return new Map()
    }

    return fetchRemoteCollections(requests)
  }

  async loadCustomCollection(force = false): Promise<IconifyJSON[]> {
    if (force) {
      this.clientBundleVersion += 1
      this._customCollections = undefined
    }
    if (!this._customCollections) {
      this._customCollections = this._loadCustomCollection()
        .then((collections) => {
          if (this._customCollections)
            this._customCollections = collections
          return collections
        })
    }
    return this._customCollections
  }

  private async _loadCustomCollection(): Promise<IconifyJSON[]> {
    return Promise.all(
      (this.options.customCollections || [])
        .map(collection => loadCustomCollection(collection, this.nuxt.options.rootDir)),
    )
  }

  async loadClientBundleCollections(): Promise<ResolvedBundleIcons> {
    const {
      includeCustomCollections = this.options.provider !== 'server',
      scan = false,
    } = this.options.clientBundle || {}

    // Filter out the `i-` prefix and deduplicate
    const userIcons = new Set((this.options.clientBundle?.icons || []).map(i => i.replace(/^i[-:]/, '')))

    let customCollections: IconifyJSON[] = []
    if (this.options.customCollections?.length) {
      customCollections = await this.loadCustomCollection()
    }

    if (scan && !this.scanner) {
      // Merge (not overwrite) custom collection prefixes with user-provided
      // additional collections, so custom icons stay detectable by the scanner
      const additionalCollections = customCollections.map(c => c.prefix)
      const scanOptions = scan === true
        ? { additionalCollections }
        : {
            ...scan,
            additionalCollections: [
              ...additionalCollections,
              ...scan.additionalCollections || [],
            ],
          }
      this.scanner = new IconUsageScanner(scanOptions)
      await this.scanner.scanFiles(
        this.nuxt.options._layers.map(layer => layer.cwd),
        this.scannedIcons,
      )
    }

    const icons = new Set<string>([...userIcons, ...this.scannedIcons])

    // Let other modules contribute icons to the client bundle (they may also
    // remove icons, e.g. scanned false positives)
    await this.nuxt.callHook('icon:clientBundleIcons', icons)

    return resolveBundleIcons({
      icons: [...userIcons].filter(i => icons.has(i)),
      scannedIcons: [...this.scannedIcons].filter(i => icons.has(i)),
      extraIcons: [...icons].filter(i => !userIcons.has(i) && !this.scannedIcons.has(i)),
      customCollections,
      includeCustomCollections,
      // Resolve collections from the Nuxt root (and workspace root as a fallback)
      // instead of `process.cwd()`, so collections installed in a subproject are
      // found when the command is launched from a workspace root.
      resolvePaths: getResolvePaths(this.nuxt),
    })
  }
}
