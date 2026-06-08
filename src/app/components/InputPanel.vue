<script setup lang="ts">
// The image + intent input form. Lives in two places (the setup hero and the
// collapsible running/done panel) so it's a component to keep one source of truth.
const previewUrl = defineModel<string | null>('previewUrl', { required: true })
const intent = defineModel<string>('intent', { required: true })

defineProps<{
  samples: { src: string, label: string }[]
  canRun: boolean
  running: boolean
  errorMessage: string | null
}>()

const emit = defineEmits<{
  pickFile: [event: Event]
  clearFile: []
  loadSample: [sample: { src: string, label: string }]
  run: []
  stop: []
}>()
</script>

<template>
  <div class="space-y-5">
    <!-- Dropzone -->
    <div>
      <label class="block text-sm font-medium text-default mb-2">Image</label>

      <div
        v-if="previewUrl"
        class="relative group rounded-lg overflow-hidden ring-1 ring-default"
      >
        <img
          :src="previewUrl"
          alt="Selected image preview"
          class="w-full h-48 object-cover"
        >
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="solid"
          size="xs"
          class="absolute top-2 right-2"
          aria-label="Remove image"
          @click="emit('clearFile')"
        />
      </div>

      <label
        v-else
        class="flex flex-col items-center justify-center gap-2 h-48 rounded-lg border-2 border-dashed border-default bg-elevated/40 hover:bg-elevated/70 transition-colors cursor-pointer text-center px-4"
      >
        <UIcon
          name="i-lucide-image-up"
          class="size-8 text-dimmed"
        />
        <span class="text-sm text-muted">
          Drop an image or <span class="text-primary font-medium">browse</span>
        </span>
        <span class="text-xs text-dimmed">PNG, JPG, WebP</span>
        <input
          type="file"
          accept="image/*"
          class="sr-only"
          @change="emit('pickFile', $event)"
        >
      </label>

      <!-- Sample images for users without a photo handy -->
      <div
        v-if="!previewUrl"
        class="mt-3"
      >
        <p class="text-xs text-dimmed mb-2">
          No image? Try a sample:
        </p>
        <div class="grid grid-cols-5 gap-2">
          <button
            v-for="sample in samples"
            :key="sample.src"
            type="button"
            class="group relative rounded-md overflow-hidden ring-1 ring-default hover:ring-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary transition"
            :title="sample.label"
            @click="emit('loadSample', sample)"
          >
            <img
              :src="sample.src"
              :alt="sample.label"
              class="w-full h-12 object-cover"
            >
          </button>
        </div>
      </div>
    </div>

    <!-- Intent -->
    <div>
      <label class="block text-sm font-medium text-default mb-2">Edit intent</label>
      <UTextarea
        v-model="intent"
        :rows="3"
        autoresize
        class="w-full"
        placeholder="e.g. straighten the horizon, warm it up, lift the shadows"
      />
    </div>

    <!-- Actions -->
    <div class="flex items-center gap-2">
      <UButton
        v-if="!running"
        icon="i-lucide-play"
        label="Run"
        color="primary"
        :disabled="!canRun"
        block
        @click="emit('run')"
      />
      <template v-else>
        <UButton
          icon="i-lucide-loader-circle"
          label="Running…"
          color="primary"
          variant="soft"
          :ui="{ leadingIcon: 'animate-spin' }"
          block
          disabled
        />
        <UButton
          icon="i-lucide-square"
          label="Stop"
          color="neutral"
          variant="subtle"
          @click="emit('stop')"
        />
      </template>
    </div>

    <UAlert
      v-if="errorMessage"
      color="error"
      variant="subtle"
      :title="errorMessage"
      icon="i-lucide-triangle-alert"
    />
  </div>
</template>
