import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Two dev targets:
 *
 *  - `pnpm dev` — the local stack, straight to localhost:3000/3001. The local
 *    API allows any origin in dev, so no proxy layer to debug through.
 *  - `pnpm dev:prod` (mode "remote") — the deployed backend. Production CORS
 *    only allows the real web origins, so REST goes through Vite's proxy:
 *    the browser talks same-origin to :5173 and the proxy forwards to
 *    api.yappy.gg server-side, where CORS never applies. The WebSocket dials
 *    wss://ws.yappy.gg directly — browsers do not preflight sockets and the
 *    gateway authenticates by token, not origin.
 */
export default defineConfig(({ mode }) => {
  const remote = mode === 'remote';
  return {
    plugins: [react()],
    define: remote
      ? {
          'import.meta.env.VITE_API_URL': JSON.stringify('/v1'),
          'import.meta.env.VITE_GATEWAY_URL': JSON.stringify('wss://ws.yappy.gg'),
        }
      : {},
    server: {
      port: 5173,
      proxy: remote
        ? {
            '/v1': {
              target: 'https://api.yappy.gg',
              changeOrigin: true,
            },
          }
        : undefined,
    },
    build: {
      sourcemap: false,
      target: 'es2022',
      rollupOptions: {
        output: {
          manualChunks(id) {
            const path = id.replace(/\\/g, '/');
            if (path.includes('node_modules/react-dom') || path.includes('node_modules/react/') || path.includes('node_modules/scheduler')) {
              return 'react';
            }
            if (path.includes('node_modules/@noble')) return 'crypto';
            if (path.includes('node_modules/livekit-client')) return 'livekit';
            return undefined;
          },
        },
      },
    },
  };
});
