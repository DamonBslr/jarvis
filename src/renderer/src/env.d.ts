import type { JarvisApi } from '@shared/types'

declare global {
  interface Window {
    jarvis: JarvisApi
    jarvisFocus: (cb: () => void) => void
  }
}
export {}

