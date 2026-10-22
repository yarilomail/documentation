<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useData, useRoute } from 'vitepress'

const { site } = useData()
const route = useRoute()
// Read at runtime from the site root, so an older version lists the
// releases published after it.
const versions = ref<{ latest: string | null; releases: string[] } | null>(null)
const current = computed(() => site.value.base.replace(/\//g, ''))

const options = computed(() => {
  if (!versions.value) return []
  const { latest, releases } = versions.value
  return [
    { dir: 'latest', label: latest ? `latest (${latest})` : 'latest' },
    { dir: 'main', label: 'main (unreleased)' },
    ...releases.map(v => ({ dir: v, label: v })),
  ]
})

onMounted(async () => {
  try {
    const res = await fetch('/versions.json')
    if (res.ok) versions.value = await res.json()
  } catch {}
})

function go(e: Event) {
  const dir = (e.target as HTMLSelectElement).value
  const page = route.path.slice(site.value.base.length)
  location.href = `/${dir}/${page}${location.hash}`
}
</script>

<template>
  <label v-if="options.length" class="version-switcher">
    <span class="visually-hidden">Documentation version</span>
    <select :value="current" @change="go">
      <option v-for="o in options" :key="o.dir" :value="o.dir">{{ o.label }}</option>
    </select>
  </label>
</template>

<style scoped>
.version-switcher {
  display: block;
  padding: 16px 0 8px;
}
select {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg-alt);
  color: var(--vp-c-text-1);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
