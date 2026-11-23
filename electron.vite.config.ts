import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        // bridge.js is the stdio MCP server agent CLIs spawn (run with ELECTRON_RUN_AS_NODE).
        input: { index: resolve('src/main/index.ts'), bridge: resolve('src/main/mcp/bridge.ts') }
      }
    }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react()]
  }
})
