import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The .NET backend serves this build output directly from wwwroot.
    outDir: '../core/wwwroot',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: true,
        manualChunks: (id: string) => {
          if (id.includes('@xterm/xterm') || id.includes('@xterm/addon-fit')) {
            return 'xterm'
          }
          if (id.includes('react') && !id.includes('react-dom/server')) {
            return 'react'
          }
        },
      },
    },
  },
})
