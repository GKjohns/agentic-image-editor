// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  // Your custom configs here
  {
    files: ['app/components/Filmstrip.vue'],
    rules: {
      // The filmstrip is a single, named cockpit region (like a page section),
      // not a reusable widget — a one-word name reads best here. The other
      // components are genuinely multi-word; this is the lone deliberate
      // exception, scoped to just this file.
      'vue/multi-word-component-names': 'off'
    }
  }
)
