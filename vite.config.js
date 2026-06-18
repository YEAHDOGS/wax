import { defineConfig, loadEnv } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [
      tailwindcss(),
      svelte()
    ],
    define: {
      'process.env.SURREALDB_URL': JSON.stringify(env.SURREALDB_URL || 'http://127.0.0.1:8000/rpc'),
      'process.env.SURREALDB_USER': JSON.stringify(env.SURREALDB_USER || 'root'),
      'process.env.SURREALDB_PASS': JSON.stringify(env.SURREALDB_PASS || 'root'),
      'process.env.SURREALDB_NS': JSON.stringify(env.SURREALDB_NS || 'waxonwax'),
      'process.env.SURREALDB_DB': JSON.stringify(env.SURREALDB_DB || 'crate'),
      'process.env.DISCOGS_CONSUMER_KEY': JSON.stringify(env.DISCOGS_CONSUMER_KEY || ''),
      'process.env.DISCOGS_CONSUMER_SECRET': JSON.stringify(env.DISCOGS_CONSUMER_SECRET || '')
    },
    server: {
      proxy: {
        '/api/discogs': {
          target: 'https://api.discogs.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/discogs/, ''),
          headers: {
            'User-Agent': 'WaxOnWaxApp/1.0'
          }
        }
      }
    }
  }
})
