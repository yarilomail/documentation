<script setup lang="ts">
import { computed, onMounted, ref, watchEffect } from 'vue'
import { useData } from 'vitepress'

// Replaces the default theme's VPDocFooterLastUpdated (aliased in config.mts).
// The format follows where the reader is, taken from the browser's time zone,
// not the browser's language: month first in the United States, day first
// everywhere else.
const US_ZONES = /^(America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Juneau|Sitka|Metlakatla|Nome|Yakutat|Adak|Boise|Detroit|Menominee|Puerto_Rico|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+)|Pacific\/(Honolulu|Guam)|US\/.+)$/

const { theme, page } = useData()
const date = computed(() => new Date(page.value.lastUpdated!))
const isoDatetime = computed(() => date.value.toISOString())
const datetime = ref('')

// Formatted after mount, since the server does not know the reader's time
// zone, and again on every page change: the footer stays mounted across
// client-side navigation.
onMounted(() => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  const format = new Intl.DateTimeFormat(US_ZONES.test(zone) ? 'en-US' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })
  watchEffect(() => { datetime.value = format.format(date.value) })
})
</script>

<template>
  <p class="VPLastUpdated">
    {{ theme.lastUpdated?.text || theme.lastUpdatedText || 'Last updated' }}:
    <time :datetime="isoDatetime">{{ datetime }}</time>
  </p>
</template>

<style scoped>
.VPLastUpdated {
  line-height: 24px;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-2);
}

@media (min-width: 640px) {
  .VPLastUpdated {
    line-height: 32px;
  }
}
</style>
