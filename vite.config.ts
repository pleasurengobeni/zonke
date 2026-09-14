import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // In production the host nginx proxies /api/ to the zonkegame-api container (see
    // services/web/nginx.host.conf); the dev server needs its own equivalent so `fetch`
    // calls in the game work against `npm run dev` too, not just the deployed build.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
