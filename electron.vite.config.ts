import { resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The company's Google sign-in client (see docs/IT-GOOGLE-SIGN-IN.md), built into the app so
 * colleagues only press "Sign in with Google". build/google-client.json is git-ignored.
 */
function googleClient(): { clientId: string; clientSecret: string } {
  const file = resolve('build/google-client.json')
  if (!existsSync(file)) return { clientId: '', clientSecret: '' }
  const j = JSON.parse(readFileSync(file, 'utf8')) as { clientId?: string; clientSecret?: string }
  return { clientId: (j.clientId ?? '').trim(), clientSecret: (j.clientSecret ?? '').trim() }
}
const g = googleClient()

export default defineConfig({
  main: {
    define: {
      'import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID': JSON.stringify(g.clientId),
      'import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET': JSON.stringify(g.clientSecret)
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') }
    },
    plugins: [react(), tailwindcss()]
  }
})
