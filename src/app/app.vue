<script setup>
useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' }
  ],
  htmlAttrs: {
    lang: 'en'
  }
})

const title = 'Agentic Image Editor'
const description = 'Drop an image, describe the edit, watch an AI agent do it step by step.'

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  twitterCard: 'summary_large_image'
})
</script>

<template>
  <UApp>
    <UHeader>
      <template #left>
        <NuxtLink
          to="/"
          class="font-semibold tracking-tight text-highlighted whitespace-nowrap"
        >
          Agentic Image Editor
        </NuxtLink>
      </template>

      <template #right>
        <UColorModeButton />
      </template>
    </UHeader>

    <!-- UMain's default min-height is `100vh - header`, which alone fills the
         viewport and pushes the separator + footer below the fold (a guaranteed
         page scroll). Subtract the footer chrome too so the editing cockpit +
         footer fit in a single viewport with no scroll. -->
    <UMain class="min-h-[calc(100vh-var(--ui-header-height)-2.5rem)]">
      <NuxtPage />
    </UMain>

    <USeparator />

    <!-- Condensed footer (py-2) so it costs the layout as little height as
         possible — the editing view is viewport-bounded. -->
    <UFooter :ui="{ container: 'py-2 lg:py-2' }">
      <template #left>
        <p class="text-sm text-muted">
          Agentic Image Editor • © {{ new Date().getFullYear() }}
        </p>
      </template>
    </UFooter>
  </UApp>
</template>
