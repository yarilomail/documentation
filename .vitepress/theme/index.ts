import DefaultTheme from 'vitepress/theme-without-fonts'
import { h } from 'vue'
import VersionSwitcher from './VersionSwitcher.vue'
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-400-italic.css'
import '@fontsource/ibm-plex-sans/latin-500.css'
import '@fontsource/ibm-plex-sans/latin-600.css'
import '@fontsource/ibm-plex-sans/latin-700.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import './custom.css'
import './brand.css'

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    'sidebar-nav-before': () => h(VersionSwitcher),
  }),
}
