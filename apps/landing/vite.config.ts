import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// TanStack Start runs as a Vite plugin. The router plugin generates
// `src/routeTree.gen.ts` from the files under `src/routes/` on dev/build.
// Tailwind v4 runs as a Vite plugin too, so there is no PostCSS config here.
export default defineConfig({
  // Nitro bundles the server for the deploy target. On Vercel it detects the
  // platform and emits the Build Output API layout; elsewhere it builds a
  // plain Node server under .output/.
  plugins: [tailwindcss(), tanstackStart(), nitro(), react()],
  resolve: {
    // Mirrors the `@/*` path in tsconfig.json so imports read the same in
    // the editor and the bundle.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // Vite blocks requests whose Host header is not localhost or an IP. Allow
    // Tailscale MagicDNS names so the dev server can be reviewed from another
    // device on the tailnet (run the dev task with HOST=0.0.0.0 to bind beyond
    // loopback; see moon.yml).
    allowedHosts: ['.ts.net'],
  },
});
