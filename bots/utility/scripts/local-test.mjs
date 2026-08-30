/**
 * Drive the bot the way a person would, against a local stack.
 *
 * Creates a throwaway bot and a throwaway group, puts the bot in it, types
 * every command, and reads back what the bot said. The bot itself must already
 * be running against the same stack with the token this prints.
 *
 *   node scripts/local-test.mjs setup     → creates everything, prints the token
 *   node scripts/local-test.mjs run <id>  → types the commands in that group
 */
const API = process.env.YAPPY_API_URL ?? 'http://localhost:3000/v1';
const OWNER_EMAIL = process.env.TEST_EMAIL;
const OWNER_PASSWORD = process.env.TEST_PASSWORD;
if (!OWNER_EMAIL || !OWNER_PASSWORD) {
  console.error('Set TEST_EMAIL and TEST_PASSWORD to an account on the stack you are testing.');
  process.exit(1);
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}

const login = () =>
  call('POST', '/auth/login', {
    body: {
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
      client: { platform: 'web', device: 'bot-test', version: '1.0.0' },
    },
  }).then((r) => r.accessToken);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mode = process.argv[2] ?? 'setup';
const token = await login();

if (mode === 'setup') {
  const stamp = Date.now().toString(36);
  const bot = await call('POST', '/apps', {
    token,
    body: { name: 'Utility', username: `utility_${stamp}`, description: 'Reminders, timers, charts' },
  });

  const group = await call('POST', '/conversations', {
    token,
    body: { type: 'group', title: `utility test ${stamp}` },
  });

  const added = await call('POST', `/conversations/${group.conversation.id}/members`, {
    token,
    body: { userIds: [bot.application.bot.id] },
  });

  console.log(JSON.stringify(
    {
      botToken: bot.token,
      conversationId: group.conversation.id,
      added,
    },
    null,
    2,
  ));
} else {
  const conversationId = process.argv[3];
  if (!conversationId) throw new Error('run <conversationId>');

  // Only what this run produces — the group may already have older rounds in
  // it, and "the bot said nothing" has to be readable at a glance.
  const before = await call('GET', `/conversations/${conversationId}/messages?limit=1`, { token });
  const from = before.messages[0]?.seq ?? 0;

  const typed = [
    '/help',
    '/pick pizza | sushi | tacos',
    '/chart bar mon=3 tue=5 wed=9',
    '/time 3pm PT',
    '/time Tokyo',
    '/remind 90s the pizza',
    '/remind at 9pm call mum',
    '/reminders',
    '/timer 45s tea',
    '/remind nonsense',
    '/chart 5',
  ];

  for (const content of typed) {
    await call('POST', `/conversations/${conversationId}/messages`, {
      token,
      body: { nonce: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, type: 'text', content },
    });
    await sleep(700);
  }

  await sleep(2_000);
  const history = await call('GET', `/conversations/${conversationId}/messages?limit=60`, { token });
  const ordered = [...history.messages].filter((m) => m.seq > from).sort((a, b) => a.seq - b.seq);

  for (const m of ordered) {
    const who = m.sender?.isBot ? 'BOT ' : 'you ';
    const embed = m.embeds?.[0];
    const parts = [];
    if (m.content) parts.push(m.content);
    if (embed) {
      parts.push(`[${embed.title ?? ''}]`);
      if (embed.description) parts.push(embed.description);
      if (embed.fields?.length) {
        parts.push(embed.fields.map((f) => `${f.name}=${f.value}`).join(' | '));
      }
      if (embed.chart) parts.push(`chart:${embed.chart.kind}(${embed.chart.points.length})`);
    }
    if (m.components?.length) {
      parts.push(`buttons:[${m.components.flatMap((r) => r.components.map((b) => b.label)).join(', ')}]`);
    }
    console.log(`${who}${parts.join(' — ').slice(0, 300)}`);
  }
}
