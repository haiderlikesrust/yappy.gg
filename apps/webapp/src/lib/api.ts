import { API_URL, CLIENT_VERSION } from './config';
import type { AuthSession, Self } from './types';

/**
 * REST client with the token dance handled once.
 *
 * Access tokens are short-lived; the refresh token rotates on every use. The
 * rules that matter:
 *
 *  - One refresh in flight at a time. Two 401s racing each other would both
 *    spend the refresh token, and the second spend fails — rotation means a
 *    refresh token is single-use. Everyone awaits the same promise.
 *  - A failed refresh signs the session out, loudly, via `onSignedOut`. There
 *    is no state between "signed in" and "signed out" worth representing.
 */

const STORE_KEY = 'yappy.session';

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  user: Self | null;
}

let session: StoredSession | null = load();
let refreshing: Promise<boolean> | null = null;
let onSignedOut: (() => void) | null = null;

function load(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

function save(next: StoredSession | null): void {
  session = next;
  try {
    if (next) localStorage.setItem(STORE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* private mode — the session just does not survive a reload */
  }
}

export const auth = {
  get isSignedIn(): boolean {
    return session !== null;
  },
  get accessToken(): string | null {
    return session?.accessToken ?? null;
  },
  get user(): Self | null {
    return session?.user ?? null;
  },
  setUser(user: Self): void {
    if (session) save({ ...session, user });
  },
  handleSignedOut(fn: () => void): void {
    onSignedOut = fn;
  },
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return new ApiError(
      res.status,
      body.error?.code ?? 'unknown',
      body.error?.message ?? `Request failed (${res.status})`,
    );
  } catch {
    return new ApiError(res.status, 'unknown', `Request failed (${res.status})`);
  }
}

async function refresh(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const current = session;
    if (!current) return false;
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as AuthSession;
      save({ ...current, accessToken: body.accessToken, refreshToken: body.refreshToken });
      return true;
    } catch {
      // Network trouble is not a revoked session; keep the tokens and let the
      // caller's request fail as a network error instead.
      return true;
    } finally {
      refreshing = null;
    }
  })();
  const ok = await refreshing;
  if (!ok) {
    save(null);
    onSignedOut?.();
  }
  return ok;
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; retried?: boolean } = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (res.status === 401 && session && !init.retried) {
    if (await refresh()) return api<T>(path, { ...init, retried: true });
    throw new ApiError(401, 'unauthenticated', 'Signed out');
  }

  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ─── Auth flows ──────────────────────────────────────────────────────────────

const client = () => ({
  platform: 'web' as const,
  version: CLIENT_VERSION,
  os: navigator.platform || undefined,
  device: 'browser',
});

export async function signIn(email: string, password: string): Promise<Self | null> {
  const body = await api<AuthSession>('/auth/login', {
    method: 'POST',
    body: { email, password, client: client() },
  });
  save({ accessToken: body.accessToken, refreshToken: body.refreshToken, user: body.user ?? null });
  return body.user ?? null;
}

export async function register(
  email: string,
  password: string,
  username: string,
): Promise<Self | null> {
  const body = await api<AuthSession>('/auth/register', {
    method: 'POST',
    body: { email, password, username, client: client() },
  });
  save({ accessToken: body.accessToken, refreshToken: body.refreshToken, user: body.user ?? null });
  return body.user ?? null;
}

/**
 * Ask for a reset code. Answers the same whether or not the address is known —
 * the server will not say, and neither will this.
 */
export async function forgotPassword(email: string): Promise<void> {
  await api('/auth/password/forgot', { method: 'POST', body: { email } });
}

/** Finish a reset. Ends every other session, and signs this one in. */
export async function resetPassword(
  email: string,
  code: string,
  password: string,
): Promise<Self | null> {
  const body = await api<AuthSession>('/auth/password/reset', {
    method: 'POST',
    body: { email, code, password, client: client() },
  });
  save({ accessToken: body.accessToken, refreshToken: body.refreshToken, user: body.user ?? null });
  return body.user ?? null;
}

/** Adopt a session minted by any flow (device-grant sign-in, social, …). */
export function adoptSession(body: AuthSession): void {
  save({ accessToken: body.accessToken, refreshToken: body.refreshToken, user: body.user ?? null });
}

export async function signOut(): Promise<void> {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    /* signing out of a dead session is still signing out */
  }
  save(null);
  onSignedOut?.();
}
