import { SignJWT, importPKCS8, type KeyLike } from 'jose';
import { env, normalizeKey } from '../env.js';

/**
 * FCM HTTP v1.
 *
 * The legacy server-key API is gone, so this exchanges a service-account JWT
 * for an OAuth access token and posts to the v1 endpoint. The token is cached
 * for its full hour — minting one per notification would add a round trip to
 * Google in front of every push.
 */

export interface FcmPayload {
  token: string;
  title?: string;
  body?: string;
  data?: Record<string, string>;
  /** Android notification channel — must already exist in the app. */
  channelId?: string;
  collapseKey?: string;
  /** `high` wakes a dozing device; `normal` may be batched by the OS. */
  priority?: 'high' | 'normal';
  /** Seconds FCM should keep trying. */
  ttlSeconds?: number;
  /** Data-only, so the app renders the notification itself. */
  dataOnly?: boolean;
  tag?: string;
}

export type FcmResult =
  | { ok: true }
  | { ok: false; retryable: boolean; reason: string; unregistered?: boolean };

export class FcmClient {
  private accessToken: { token: string; expiresAt: number } | null = null;
  private privateKey: KeyLike | Uint8Array | null = null;

  readonly configured = Boolean(env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY);

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt - 60_000) {
      return this.accessToken.token;
    }

    this.privateKey ??= await importPKCS8(normalizeKey(env.FCM_PRIVATE_KEY), 'RS256');

    const assertion = await new SignJWT({
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(env.FCM_CLIENT_EMAIL)
      .setSubject(env.FCM_CLIENT_EMAIL)
      .setAudience('https://oauth2.googleapis.com/token')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(this.privateKey);

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) throw new Error(`fcm token exchange failed: ${res.status}`);

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  }

  async send(payload: FcmPayload): Promise<FcmResult> {
    if (!this.configured) return { ok: false, retryable: false, reason: 'fcm_not_configured' };

    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (err) {
      return { ok: false, retryable: true, reason: String(err) };
    }

    const message: Record<string, unknown> = {
      token: payload.token,
      // Data is always sent: the app needs it to deep-link and to update its
      // cache even when the OS drew the notification itself.
      data: payload.data ?? {},
      android: {
        priority: payload.priority ?? 'high',
        ttl: `${payload.ttlSeconds ?? 2_419_200}s`,
        ...(payload.collapseKey ? { collapse_key: payload.collapseKey } : {}),
        ...(payload.dataOnly
          ? {}
          : {
              notification: {
                title: payload.title,
                body: payload.body,
                channel_id: payload.channelId ?? 'messages',
                ...(payload.tag ? { tag: payload.tag } : {}),
              },
            }),
      },
    };

    // A `notification` block at the top level makes the OS draw the alert while
    // the app is backgrounded. Omitting it (dataOnly) hands full control to the
    // app — which is what encrypted or preview-suppressed messages need.
    if (!payload.dataOnly) {
      message.notification = { title: payload.title, body: payload.body };
    }

    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (res.ok) return { ok: true };

    const text = await res.text();
    let reason = `http_${res.status}`;
    try {
      reason = (JSON.parse(text) as { error?: { status?: string } }).error?.status ?? reason;
    } catch {
      /* keep the status-based reason */
    }

    // UNREGISTERED / NOT_FOUND: the app was uninstalled or the token rotated.
    const unregistered = res.status === 404 || reason === 'UNREGISTERED' || reason === 'NOT_FOUND';

    return {
      ok: false,
      retryable: !unregistered && (res.status === 429 || res.status >= 500),
      reason,
      unregistered,
    };
  }
}
