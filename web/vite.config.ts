import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The .NET backend serves this build output directly from wwwroot.
    outDir: '../server/wwwroot',
    emptyOutDir: true,
  },
})
