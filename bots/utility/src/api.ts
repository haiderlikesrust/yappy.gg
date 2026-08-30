/**
 * The two calls the SDK does not wrap yet.
 *
 * `GET /apps/me` is how a bot learns its own user id — needed to ignore its
 * own messages, which is the first loop every bot author writes by accident.
 * `PUT /apps/:id/commands` is how the composer learns to offer `/remind`
 * before the bot has ever spoken.
 *
 * Both are plain HTTP with the same `Bot` credential the SDK uses, so there is
 * nothing clever here — it just has not earned a place in the SDK yet.
 */

export interface CommandDeclaration {
  name: string;
  description: string;
  usage?: string;
}

export interface Identity {
  applicationId: string;
  userId: string;
  username: string;
  name: string;
}

async function call<T>(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bot ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function whoAmI(baseUrl: string, token: string): Promise<Identity> {
  const me = await call<{
    application: { id: string; name: string };
    user: { id: string; username: string };
  }>(baseUrl, token, 'GET', '/apps/me');
  return {
    applicationId: me.application.id,
    userId: me.user.id,
    username: me.user.username,
    name: me.application.name,
  };
}

export async function declareCommands(
  baseUrl: string,
  token: string,
  applicationId: string,
  commands: CommandDeclaration[],
): Promise<void> {
  await call(baseUrl, token, 'PUT', `/apps/${applicationId}/commands`, { commands });
}
