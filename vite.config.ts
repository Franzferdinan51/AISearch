import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    server: { proxy: { '/api': `http://127.0.0.1:${env.LUMEN_API_PORT || '3001'}` } },
  }
})
