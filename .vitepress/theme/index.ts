import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import VersionSwitcher from './VersionSwitcher.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    'sidebar-nav-before': () => h(VersionSwitcher),
  }),
}
