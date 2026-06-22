import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// TanStack Start runs as a Vite plugin. The router plugin generates
// `src/routeTree.gen.ts` from the files under `src/routes/` on dev/build.
export default defineConfig({
  plugins: [tanstackStart(), react()],
});
