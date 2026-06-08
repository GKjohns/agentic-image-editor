// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui'
  ],

  devtools: {
    enabled: true
  },

  app: {
    head: {
      title: 'Agentic Image Editor'
    }
  },

  css: ['~/assets/css/main.css'],

  // The Vercel AI Gateway provider auto-reads AI_GATEWAY_API_KEY from process.env.
  // We surface model + step-cap here so they're swappable via env without code changes.
  runtimeConfig: {
    agentModel: process.env.AGENT_MODEL || 'anthropic/claude-sonnet-4-6',
    maxSteps: process.env.MAX_STEPS || '30',
    maxOpsPerBatch: process.env.MAX_OPS_PER_BATCH || '6'
  },

  compatibilityDate: '2025-01-15',

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
