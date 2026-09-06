import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { readFile } from 'node:fs/promises';

/** Let native debug builds open the real public form on the local web port. */
function supportPage(): Plugin {
  const files: Record<string, [string, string]> = {
    '/support': ['support/index.html', 'text/html; charset=utf-8'],
    '/support/': ['support/index.html', 'text/html; charset=utf-8'],
    '/support/index.html': ['support/index.html', 'text/html; charset=utf-8'],
    '/support/support.css': ['support/support.css', 'text/css'],
    '/support/support.js': ['support/support.js', 'text/javascript'],
    '/_doc.css': ['_doc.css', 'text/css'],
    '/mark.png': ['mark.png', 'image/png'],
    '/icon.png': ['icon.png', 'image/png'],
  };
  return {
    name: 'yappy-support-page',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const file = files[req.url?.split('?')[0] ?? ''];
        if (!file || !['GET', 'HEAD'].includes(req.method ?? '')) return next();
        try {
          const content = await readFile(new URL(`../../web/${file[0]}`, import.meta.url));
          res.setHeader('Content-Type', file[1]);
          res.setHeader('Cache-Control', 'no-store');
          res.end(req.method === 'HEAD' ? undefined : content);
        } catch (error) { next(error); }
      });
    },
  };
}

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
    plugins: [react(), supportPage()],
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
        : { '/v1/support': { target: 'http://127.0.0.1:3000', changeOrigin: true } },
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
