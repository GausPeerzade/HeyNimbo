import type { NimboApi } from '../preload'

declare global {
  interface Window {
    nimbo: NimboApi
  }
}
