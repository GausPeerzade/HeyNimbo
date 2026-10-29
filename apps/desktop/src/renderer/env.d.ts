import type { HeyNimboApi } from '../preload'

declare global {
  interface Window {
    heynimbo: HeyNimboApi
  }
}
