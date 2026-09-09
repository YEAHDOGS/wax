import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Staging deploys to GitHub Pages at https://yeahdogs.github.io/wax/,
  // so asset URLs must be relative to the repo subpath.
  base: '/wax/',
  plugins: [react()],
  server: { port: 5273 },
});
