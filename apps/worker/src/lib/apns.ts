import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { SignJWT, importPKCS8, type KeyLike } from 'jose';
import { env, normalizeKey } from '../env.js';

/**
 * APNs over HTTP/2, hand-rolled.
 *
 * Two reasons not to take a library here: the protocol is small (one POST per
 * notification over a long-lived h2 connection), and the popular wrappers hide
 * exactly the parts that matter in production — connection reuse, the
 * distinction between a retryable failure and a dead token, and the `apns-*`
 * headers that control collapsing and priority.
 *
 * The auth token is a JWT signed with a .p8 key. Apple caches it for an hour
 * and rejects a token refreshed more often than every 20 minutes, so it is
 * minted once and reused.
 */

const HOST_PROD = 'https://api.push.apple.com';
const HOST_DEV = 'https://api.sandbox.push.apple.com';

export interface ApnsPayload {
  token: string;
  /** `alert` for a normal notification, `voip` for a CallKit wake-up. */
  kind: 'alert' | 'voip' | 'background';
  title?: string;
  body?: string;
  badge?: number;
  sound?: string;
  /** Merged into the top level of the payload alongside `aps`. */
  data?: Record<string, unknown>;
  collapseId?: string;
  /** Unix seconds; APNs drops the notification after this. */
  expiration?: number;
  threadId?: string;
  /** Enables the Notification Service Extension to decrypt/mutate content. */
  mutableContent?: boolean;
}

export type ApnsResult =
  | { ok: true }
  | { ok: false; retryable: boolean; reason: string; unregistered?: boolean };

export class ApnsClient {
  private session: ClientHttp2Session | null = null;
  private cachedToken: { jwt: string; at: number } | null = null;
  private privateKey: KeyLike | Uint8Array | null = null;

  readonly configured = Boolean(env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY);

  private get host(): string {
    return env.APNS_PRODUCTION ? HOST_PROD : HOST_DEV;
  }

  private async authToken(): Promise<string> {
    // Apple rejects refreshes more frequent than 20 minutes; 50 is safely
    // inside the 60-minute validity window.
    if (this.cachedToken && Date.now() - this.cachedToken.at < 50 * 60_000) {
      return this.cachedToken.jwt;
    }

    this.privateKey ??= await importPKCS8(normalizeKey(env.APNS_PRIVATE_KEY), 'ES256');

    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: env.APNS_KEY_ID })
      .setIssuer(env.APNS_TEAM_ID)
      .setIssuedAt()
      .sign(this.privateKey);

    this.cachedToken = { jwt, at: Date.now() };
    return jwt;
  }

  private getSession(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;

    const session = connect(this.host);
    session.on('error', () => {
      this.session = null;
    });
    session.on('close', () => {
      this.session = null;
    });
    // Do not hold the event loop open for a connection nothing is waiting on.
    session.unref();
    this.session = session;
    return session;
  }

  async send(payload: ApnsPayload): Promise<ApnsResult> {
    if (!this.configured) return { ok: false, retryable: false, reason: 'apns_not_configured' };

    const aps: Record<string, unknown> = {};

    if (payload.kind === 'alert') {
      aps.alert = { title: payload.title, body: payload.body };
      if (payload.badge !== undefined) aps.badge = payload.badge;
      aps.sound = payload.sound ?? 'default';
      if (payload.threadId) aps['thread-id'] = payload.threadId;
      if (payload.mutableContent) aps['mutable-content'] = 1;
    } else if (payload.kind === 'background') {
      aps['content-available'] = 1;
    }

    const body = JSON.stringify({ aps, ...payload.data });
    const token = await this.authToken();

    const headers: Record<string, string | number> = {
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: `/3/device/${payload.token}`,
      authorization: `bearer ${token}`,
      // A VoIP push uses its own topic suffix and must be highest priority —
      // this is what lets CallKit ring a terminated app.
      'apns-topic': payload.kind === 'voip' ? `${env.APNS_BUNDLE_ID}.voip` : env.APNS_BUNDLE_ID,
      'apns-push-type': payload.kind === 'alert' ? 'alert' : payload.kind === 'voip' ? 'voip' : 'background',
      'apns-priority': payload.kind === 'background' ? 5 : 10,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    };

    if (payload.collapseId) headers['apns-collapse-id'] = payload.collapseId.slice(0, 64);
    if (payload.expiration !== undefined) headers['apns-expiration'] = payload.expiration;

    return new Promise<ApnsResult>((resolve) => {
      let settled = false;
      const finish = (result: ApnsResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      let request;
      try {
        request = this.getSession().request(headers);
      } catch (err) {
        finish({ ok: false, retryable: true, reason: String(err) });
        return;
      }

      let status = 0;
      let responseBody = '';

      request.setEncoding('utf8');
      request.on('response', (h) => {
        status = Number(h[constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      request.on('data', (chunk: string) => {
        responseBody += chunk;
      });
      request.on('error', (err) => finish({ ok: false, retryable: true, reason: err.message }));
      request.setTimeout(10_000, () => {
        request.close();
        finish({ ok: false, retryable: true, reason: 'timeout' });
      });

      request.on('end', () => {
        if (status === 200) return finish({ ok: true });

        let reason = `http_${status}`;
        try {
          reason = (JSON.parse(responseBody) as { reason?: string }).reason ?? reason;
        } catch {
          /* keep the status-based reason */
        }

        // 410 Gone, or 400 BadDeviceToken: the token is dead and must be
        // cleared, not retried. Retrying these forever is how push queues rot.
        const unregistered =
          status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered';

        finish({
          ok: false,
          retryable: !unregistered && (status === 429 || status >= 500),
          reason,
          unregistered,
        });
      });

      request.end(body);
    });
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }
}
