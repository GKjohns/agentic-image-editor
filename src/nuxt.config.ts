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
    // Develop engine selection + RawTherapee runner config. The engines read
    // these via process.env (no event access), but we surface them here too so
    // they're documented as runtime config alongside the rest.
    rtExecution: process.env.RT_EXECUTION || 'local',
    rtSnapshotId: process.env.RT_SNAPSHOT_ID || '',
    rtBin: process.env.RT_BIN || 'rawtherapee-cli'
  },

  compatibilityDate: '2025-01-15',

  // Pre-bundle the AI SDK client deps so Vite doesn't discover them at runtime
  // on the first edit and trigger a full page reload mid-run (which drops the
  // in-flight session and 404s /api/edit).
  vite: {
    optimizeDeps: {
      include: ['@ai-sdk/vue', 'ai']
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
