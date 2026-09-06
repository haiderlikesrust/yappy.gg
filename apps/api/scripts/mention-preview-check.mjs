import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Runs only inside suspension-check's disposable local database. */
export async function checkMentionPreviews({
  app,
  sql,
  call,
  token,
  userId,
  ownerId,
  check,
}) {
  const rooms = [],
    messages = [];
  const original = app.messages.hydrateMany;
  let hydrations = 0;
  try {
    for (let i = 0; i < 12; i++) {
      const { conversation } = await app.conversations.create(ownerId, {
        type: "group",
        title: `Inbox preview fixture ${i}`,
        memberIds: [],
        disappearingSeconds: 0,
      });
      rooms.push(conversation.id);
      await sql`insert into conversation_members (conversation_id, user_id, role)
        values (${conversation.id}, ${userId}, 'member')`;
      const { message } = await app.messages.send(ownerId, conversation.id, {
        nonce: randomUUID(),
        type: "text",
        content: i === 0 ? "x".repeat(2000) : `Preview ${i}`,
      });
      messages.push(message);
      await sql`insert into message_mentions (message_id, user_id, conversation_id, seq)
        values (${message.id}, ${userId}, ${conversation.id}, ${message.seq})`;
    }
    // Force a sealed message into the fixture without any recipient keys:
    // the preview must expose neither its internal placeholder nor ciphertext.
    await sql`update messages set is_encrypted = true, content = 'Private placeholder' where id = ${messages[1].id}`;
    app.messages.hydrateMany = function (...args) {
      hydrations++;
      return original.apply(this, args);
    };
    const start = performance.now();
    const full = await call(token, "GET", "/users/me/mentions?limit=40");
    const fullMs = performance.now() - start;
    check(
      "legacy mentions retain full message hydration",
      full.status === 200 &&
        hydrations === 12 &&
        full.body.mentions.every((m) => Array.isArray(m.message.attachments)),
    );
    hydrations = 0;
    const previewStart = performance.now();
    const previews = await call(
      token,
      "GET",
      "/users/me/mentions?limit=40&preview=1",
    );
    const previewMs = performance.now() - previewStart;
    check(
      "inbox previews skip all per-conversation full hydration",
      previews.status === 200 && hydrations === 0,
    );
    assert.deepEqual(
      previews.body.mentions.map((m) => m.message.id),
      full.body.mentions.map((m) => m.message.id),
    );
    check(
      "preview ordering, navigation targets and unread flags match full mentions",
      previews.body.mentions.every(
        (m, i) =>
          m.message.seq === full.body.mentions[i].message.seq &&
          m.unread === full.body.mentions[i].unread &&
          m.conversation.id === full.body.mentions[i].conversation.id &&
          m.message.sender.id === ownerId,
      ),
    );
    check(
      "preview text is bounded and encrypted messages stay concealed",
      previews.body.mentions.find((m) => m.message.id === messages[0].id)
        .message.content.length === 600 &&
        previews.body.mentions.find((m) => m.message.id === messages[1].id)
          .message.content === "Encrypted message" &&
        previews.body.mentions.every((m) => !("ciphertext" in m.message)),
    );
    console.log(
      `INFO mentions across 12 groups: full ${Math.round(fullMs)}ms / ${JSON.stringify(full.body).length} bytes; preview ${Math.round(previewMs)}ms / ${JSON.stringify(previews.body).length} bytes (local fixture)`,
    );

    await sql`update conversation_members set left_at = now() where conversation_id = ${rooms[2]} and user_id = ${userId}`;
    await sql`insert into message_deletions (message_id, user_id) values (${messages[3].id}, ${userId})`;
    await sql`update messages set deleted_at = now() where id = ${messages[4].id}`;
    await sql`update conversations set base_permissions = 0 where id = ${rooms[5]}`;
    const before =
      await sql`select conversation_id, last_read_seq from conversation_members where user_id = ${userId} order by conversation_id`;
    const filtered = await call(
      token,
      "GET",
      "/users/me/mentions?limit=40&preview=1",
    );
    const hiddenIds = new Set(messages.slice(2, 6).map((m) => m.id));
    check(
      "preview hides left groups, private groups, deleted messages and viewer tombstones",
      filtered.status === 200 &&
        filtered.body.mentions.length === 8 &&
        filtered.body.mentions.every((m) => !hiddenIds.has(m.message.id)),
    );
    const after =
      await sql`select conversation_id, last_read_seq from conversation_members where user_id = ${userId} order by conversation_id`;
    assert.deepEqual(after, before);
    check("fetching mention previews does not acknowledge messages", true);
  } finally {
    app.messages.hydrateMany = original;
    for (const id of rooms)
      await sql`delete from conversations where id = ${id}`;
  }
}
