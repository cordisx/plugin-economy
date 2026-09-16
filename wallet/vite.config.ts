import { cordisXPluginViteConfig } from 'cordisx/vite'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

const config: ReturnType<typeof cordisXPluginViteConfig> = cordisXPluginViteConfig({
  root: projectRoot,
  entry: fileURLToPath(new URL('./src/wallet.tsx', import.meta.url)),
  outDir: fileURLToPath(new URL('./dist/runtime', import.meta.url)),
  entryFileName: 'module.js',
})

export default config
