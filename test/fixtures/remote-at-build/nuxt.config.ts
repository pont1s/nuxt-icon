import Module from '../../../src/module'

export default defineNuxtConfig({
  modules: [Module],
  icon: {
    fallbackToApi: false,
    serverBundle: {
      // Served by the test, see `test/remote-at-build.test.ts`
      remote: name => `${process.env.NUXT_ICON_TEST_REMOTE}/${name}.json`,
      collections: ['ph'],
      fetchRemoteAtBuild: true,
    },
  },
})
