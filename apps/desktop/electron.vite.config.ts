import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads cannot load shared chunks, so each is self-contained.
      isolatedEntries: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          app: resolve(__dirname, 'src/preload/app.ts'),
          setup: resolve(__dirname, 'src/preload/setup.ts'),
          voice: resolve(__dirname, 'src/preload/voice.ts'),
        },
      },
    },
  },
  renderer: {
    build: {
      // The CSP forbids data: scripts, so the audio worklet must stay a file.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          notch: resolve(__dirname, 'src/renderer/notch.html'),
          home: resolve(__dirname, 'src/renderer/home.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
          setup: resolve(__dirname, 'src/renderer/setup.html'),
          voice: resolve(__dirname, 'src/renderer/voice.html'),
        },
      },
    },
  },
})
