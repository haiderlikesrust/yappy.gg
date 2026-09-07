import assert from "node:assert/strict";
import { randomUUID as id } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";

export async function checkAndroid26({
  app,
  sql,
  call,
  token,
  userId,
  ownerId,
  check,
}) {
  const { conversation: room } = await app.conversations.create(userId, {
    type: "group",
    title: "Android 2.6 fixture",
    memberIds: [],
    disappearingSeconds: 0,
  });
  const { conversation: privateRoom } = await app.conversations.create(
    ownerId,
    {
      type: "group",
      title: "Private 2.6 fixture",
      memberIds: [],
      disappearingSeconds: 0,
    },
  );
  const request = async (method, path, payload) => {
    const r = await call(token, method, "/extras" + path, payload);
    assert(r.status < 300, `${method} ${path}: ${JSON.stringify(r)}`);
    return r.body;
  };
  const mediaIds = [id(), id(), id()];
  const wall = id();
  const folder = id();
  let server;
  const getObject = app.storage.getObject.bind(app.storage);
  const oldBase = process.env.TRANSCRIPTION_BASE_URL;
  try {
    const { availableUsername } = await import('../src/lib/socialauth.ts');
    const socialName = await availableUsername(app.db, 'EVERYONE@example.invalid');
    check('social signup cannot claim a broadcast mention handle', /^everyone\d+$/.test(socialName));
    const reserved = await call(null, 'GET', '/auth/username-available?username=EvErYoNe');
    check('username availability reserves everyone regardless of case', reserved.status === 200 && reserved.body.available === false);
    const rename = await call(token, 'PATCH', '/users/me', { username: 'everyone' });
    check('profile edits cannot claim the everyone mention', rename.status === 400);
    await request("PUT", `/folders/${folder}`, {
      name: "Friends",
      conversationIds: [room.id],
    });
    const folders = await request("GET", "/folders");
    check(
      "personal folders persist their chat membership",
      folders.folders.find((f) => f.id === folder)?.conversationIds[0] ===
        room.id,
    );
    const denied = await call(token, "PUT", `/extras/folders/${folder}`, {
      name: "Private",
      conversationIds: [privateRoom.id],
    });
    check(
      "folders cannot include inaccessible conversations",
      denied.status >= 400,
    );
    const foreign = id();
    await sql`insert into chat_folders(id,user_id,name) values (${foreign},${ownerId},'Someone else')`;
    check(
      "folder ownership is enforced",
      (
        await call(token, "PUT", `/extras/folders/${foreign}`, {
          name: "Overwrite",
          conversationIds: [],
        })
      ).status === 404,
    );
    for (const [i, media] of mediaIds.entries())
      await sql`insert into media(id,owner_id,purpose,status,bucket,object_key,mime_type,size,filename,confirmed_at)
      values (${media},${userId},'attachment','ready','test',${"fixture-" + media},${i === 2 ? "audio/mp4" : "image/png"},10,${i === 2 ? "voice.m4a" : "photo.png"},now())`;
    const body = {
      nonce: id(),
      type: "image",
      content: "Album caption",
      attachmentIds: mediaIds.slice(0, 2),
      attachmentCaptions: ["First", "Second"],
      isSpoiler: true,
    };
    const sent = await call(
      token,
      "POST",
      `/conversations/${room.id}/messages`,
      body,
    );
    assert(sent.status < 300, JSON.stringify(sent));
    const message = sent.body.message;
    check(
      "album preserves both attachments, order, captions and spoilers",
      message.attachments.length === 2 &&
        message.attachments[0].id === mediaIds[0] &&
        message.attachments[1].caption === "Second" &&
        message.attachments.every((a) => a.isSpoiler),
    );
    const retry = await call(
      token,
      "POST",
      `/conversations/${room.id}/messages`,
      body,
    );
    check(
      "upload retry does not duplicate the album",
      retry.body.message.id === message.id,
    );
    await request("PUT", `/conversations/${room.id}/walls/${wall}`, {
      title: "Weekend",
    });
    await request("PUT", `/walls/${wall}/items/${message.id}`);
    await request("PUT", `/walls/${wall}/items/${message.id}`);
    check(
      "shared album contributions are idempotent",
      (await request("GET", `/walls/${wall}`)).messages.length === 1,
    );
    check(
      "gallery returns albums with spoiler metadata",
      (
        await request("GET", `/conversations/${room.id}/gallery?kind=photos`)
      ).messages[0].attachments.every((a) => a.isSpoiler),
    );
    check(
      "private gallery cannot be read",
      (
        await call(
          token,
          "GET",
          `/extras/conversations/${privateRoom.id}/gallery`,
        )
      ).status >= 400,
    );
    const { message: secret } = await app.messages.send(
      ownerId,
      privateRoom.id,
      { nonce: id(), type: "text", content: "Private" },
    );
    check(
      "a private message cannot enter another group album",
      (await call(token, "PUT", `/extras/walls/${wall}/items/${secret.id}`))
        .status === 404,
    );
    await sql`insert into message_deletions(message_id,user_id) values (${message.id},${userId})`;
    check(
      "hidden messages disappear from shared albums",
      (await request("GET", `/walls/${wall}`)).messages.length === 0,
    );
    check(
      "hidden messages disappear from media gallery",
      (await request("GET", `/conversations/${room.id}/gallery?kind=photos`))
        .messages.length === 0,
    );
    await request("DELETE", `/folders/${folder}`);
    check(
      "deleting a folder keeps its conversation",
      (await sql`select id from conversations where id=${room.id}`).length ===
        1,
    );
    const audio = await call(
      token,
      "POST",
      `/conversations/${room.id}/messages`,
      { nonce: id(), type: "audio", attachmentIds: [mediaIds[2]] },
    );
    assert(audio.status < 300, JSON.stringify(audio));
    const audioId = audio.body.message.id;
    check(
      "transcription requires explicit consent",
      (await call(token, "POST", `/extras/messages/${audioId}/transcript`, {}))
        .status === 400,
    );
    delete process.env.TRANSCRIPTION_BASE_URL;
    check(
      "unconfigured transcription has a truthful unavailable response",
      (
        await call(token, "POST", `/extras/messages/${audioId}/transcript`, {
          consent: true,
        })
      ).status === 503,
    );
    let requests = 0;
    server = createServer((req, res) => {
      requests++;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "Self-hosted fixture transcript" }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.TRANSCRIPTION_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
    app.storage.getObject = async () => ({
      body: Readable.from([Buffer.from("fixture-audio")]),
      contentType: "audio/mp4",
      contentLength: 13,
    });
    const transcript = await request(
      "POST",
      `/messages/${audioId}/transcript`,
      { consent: true },
    );
    check(
      "consented audio uses the configured self-hosted service",
      requests === 1 && transcript.text === "Self-hosted fixture transcript",
    );
    await sql`insert into message_deletions(message_id,user_id) values (${audioId},${userId})`;
    check(
      "hidden audio is rejected before any transcription request",
      (
        await call(token, "POST", `/extras/messages/${audioId}/transcript`, {
          consent: true,
        })
      ).status === 404 && requests === 1,
    );
  } finally {
    app.storage.getObject = getObject;
    if (oldBase === undefined) delete process.env.TRANSCRIPTION_BASE_URL;
    else process.env.TRANSCRIPTION_BASE_URL = oldBase;
    if (server) await new Promise((resolve) => server.close(resolve));
    await sql`delete from conversations where id in (${room.id},${privateRoom.id})`;
    await sql`delete from media where id in ${sql(mediaIds)}`;
  }
}
