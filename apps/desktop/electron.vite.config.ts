import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    build: {
      rollupOptions: {
        input: {
          notch: resolve(__dirname, 'src/renderer/notch.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
        },
      },
    },
  },
})
