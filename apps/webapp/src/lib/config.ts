/**
 * Where the backend lives.
 *
 * Dev talks to the local stack directly (the API allows any origin when
 * CORS_ORIGINS is unset); a production build defaults to the deployed hosts.
 * Both are overridable per-environment with Vite env vars, the same way the
 * Android build wires its BuildConfig fields.
 */
export const API_URL: string =
  import.meta.env.VITE_API_URL ??
  (import.meta.env.PROD ? 'https://api.yappy.gg/v1' : 'http://localhost:3000/v1');

export const GATEWAY_URL: string =
  import.meta.env.VITE_GATEWAY_URL ?? (import.meta.env.PROD ? 'wss://ws.yappy.gg' : 'ws://localhost:3001');

export const CLIENT_VERSION = '0.1.0';
