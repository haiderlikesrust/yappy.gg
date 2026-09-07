import assert from "node:assert/strict";
import { randomUUID as id } from "node:crypto";
import {
  deliverReminder,
  deliverScheduled,
} from "../src/plugins/communityJobs.ts";

export async function checkCommunity({
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
    title: "Community fixture",
    memberIds: [],
    disappearingSeconds: 0,
  });
  const { conversation: other } = await app.conversations.create(ownerId, {
    type: "group",
    title: "Private fixture",
    memberIds: [],
    disappearingSeconds: 0,
  });
  const request = async (method, path, payload) => {
    const r = await call(token, method, "/community" + path, payload);
    assert(r.status < 300, `${method} ${path}: ${JSON.stringify(r)}`);
    return r.body;
  };
  const future = () => new Date(Date.now() + 3600_000).toISOString();
  try {
    const { message } = await app.messages.send(userId, room.id, {
      nonce: id(),
      type: "text",
      content: "collectionneedle",
    });
    const { message: secret } = await app.messages.send(ownerId, other.id, {
      nonce: id(),
      type: "text",
      content: "Secret",
    });
    const folder = id();
    await request("POST", "/collections", { id: folder, name: "Ideas" });
    await request("PUT", `/saved/${message.id}`, {
      collectionId: folder,
      note: "personalnote",
    });
    const saved = await request(
      "GET",
      `/saved?q=personalnote&collectionId=${folder}`,
    );
    check(
      "collections search includes personal notes and a message jump target",
      saved.items.length === 1 && saved.items[0].seq === message.seq,
    );
    check(
      "saving a private message is rejected",
      (
        await call(token, "PUT", `/community/saved/${secret.id}`, {
          collectionId: folder,
          note: "",
        })
      ).status === 404,
    );
    const privateFolder = id();
    await sql`insert into saved_collections(id,user_id,name) values (${privateFolder},${ownerId},'Private')`;
    check(
      "collections cannot be assigned across accounts",
      (
        await call(token, "PUT", `/community/saved/${message.id}`, {
          collectionId: privateFolder,
          note: "",
        })
      ).status === 404,
    );
    await request("DELETE", `/collections/${folder}`);
    check(
      "deleting a collection keeps its saved messages and notes",
      (await request("GET", "/saved")).items[0].note === "personalnote",
    );
    const reminder = id();
    await request("POST", "/reminders", {
      id: reminder,
      messageId: message.id,
      dueAt: future(),
    });
    await sql`update community_reminders set due_at=now()-interval '1 second' where id=${reminder}`;
    await Promise.all([
      deliverReminder(app, reminder),
      deliverReminder(app, reminder),
    ]);
    const [counts] =
      await sql`select (select count(*)::int from notifications where id=${reminder}) as n,(select count(*)::int from push_outbox where id=${reminder}) as p`;
    check(
      "concurrent reminder deliveries create one inbox item and one push",
      counts.n === 1 && counts.p === 1,
    );
    const hidden = id();
    await request("POST", "/reminders", {
      id: hidden,
      messageId: message.id,
      dueAt: future(),
    });
    await sql`insert into message_deletions(message_id,user_id) values (${message.id},${userId})`;
    await sql`update community_reminders set due_at=now()-interval '1 second' where id=${hidden}`;
    await deliverReminder(app, hidden);
    check(
      "deleted-for-me messages disappear from saved and do not trigger reminders",
      (await request("GET", "/saved")).items.length === 0 &&
        (await sql`select id from notifications where id=${hidden}`).length ===
          0,
    );
    await sql`delete from message_deletions where message_id=${message.id}`;
    const schedule = async (content) => {
      const uuid = id();
      await request("POST", "/scheduled", {
        id: uuid,
        conversationId: room.id,
        content,
        sendAt: future(),
      });
      await sql`update scheduled_messages set send_at=now()-interval '1 second' where id=${uuid}`;
      return uuid;
    };
    const pending = await schedule("Scheduled fixture");
    await Promise.all([
      deliverScheduled(app, pending),
      deliverScheduled(app, pending),
    ]);
    check(
      "concurrent scheduled sends publish exactly once",
      (await sql`select id from messages where nonce=${"scheduled:" + pending}`)
        .length === 1,
    );
    await sql`delete from messages where nonce=${"scheduled:" + pending}`;
    await deliverScheduled(app, pending);
    check(
      "deleting a delivered message never causes its schedule to send again",
      (await sql`select id from messages where nonce=${"scheduled:" + pending}`)
        .length === 0,
    );
    const cancelled = await schedule("Cancelled fixture");
    await request("DELETE", `/scheduled/${cancelled}`);
    await deliverScheduled(app, cancelled);
    check(
      "cancelled scheduled messages never send",
      (
        await sql`select id from messages where nonce=${"scheduled:" + cancelled}`
      ).length === 0,
    );
    const suspended = await schedule("Suspended fixture");
    await sql`update users set suspended_until=now()+interval '1 hour' where id=${userId}`;
    await deliverScheduled(app, suspended);
    await sql`update users set suspended_until=null where id=${userId}`;
    check(
      "suspension blocks a previously scheduled send and records its failure",
      (
        await sql`select id from messages where nonce=${"scheduled:" + suspended}`
      ).length === 0 &&
        (
          await sql`select failed_at from scheduled_messages where id=${suspended}`
        )[0].failed_at !== null,
    );
    const revoked = await schedule("Left group fixture");
    await sql`update conversation_members set left_at=now() where conversation_id=${room.id} and user_id=${userId}`;
    await deliverScheduled(app, revoked);
    await sql`update conversation_members set left_at=null where conversation_id=${room.id} and user_id=${userId}`;
    check(
      "lost membership blocks a scheduled send",
      (await sql`select id from messages where nonce=${"scheduled:" + revoked}`)
        .length === 0,
    );
    const eventId = id();
    await request("POST", `/groups/${room.id}/events`, {
      id: eventId,
      title: "Game night",
      startsAt: future(),
    });
    await request("PUT", `/events/${eventId}/rsvp`, {
      response: "going",
      remind: true,
    });
    await request("PUT", `/events/${eventId}/rsvp`, {
      response: "going",
      remind: true,
    });
    check(
      "RSVP retries create one pending reminder",
      (
        await sql`select id from community_reminders where event_id=${eventId} and cancelled_at is null`
      ).length === 1,
    );
    await request("PATCH", `/events/${eventId}`, {
      title: "Movie night",
      description: "A film together",
      location: "Main chat",
      startsAt: future(),
      endsAt: null,
    });
    const events = await request("GET", `/events?conversationId=${room.id}`);
    check(
      "event edits preserve the RSVP and reminder preference",
      events.events[0].title === "Movie night" &&
        events.events[0].response === "going" &&
        events.events[0].remind,
    );
    const [eventReminder] =
      await sql`select id from community_reminders where event_id=${eventId} and cancelled_at is null`;
    await sql`update community_reminders set delivered_at=now() where id=${eventReminder.id}`;
    const edit = {
      title: "Movie night",
      description: "Bring snacks",
      location: "Main chat",
      startsAt: events.events[0].startsAt,
      endsAt: null,
    };
    await request("PATCH", `/events/${eventId}`, edit);
    await request("PATCH", `/events/${eventId}`, edit);
    await request("PUT", `/events/${eventId}/rsvp`, {
      response: "maybe",
      remind: true,
    });
    check(
      "description edits, edit retries and RSVP changes do not repeat delivered reminders",
      (
        await sql`select id from community_reminders where event_id=${eventId} and cancelled_at is null`
      ).length === 1,
    );
    await request("PATCH", `/events/${eventId}`, {
      ...edit,
      startsAt: new Date(Date.parse(edit.startsAt) + 3600000).toISOString(),
    });
    check(
      "changing an event start time creates one new reminder",
      (
        await sql`select id from community_reminders where event_id=${eventId} and cancelled_at is null and delivered_at is null`
      ).length === 1,
    );
    await request("DELETE", `/events/${eventId}`);
    check(
      "cancelling an event cancels all its pending reminders",
      (
        await sql`select id from community_reminders where event_id=${eventId} and cancelled_at is null and delivered_at is null`
      ).length === 0,
    );
    await request("PUT", `/groups/${room.id}/welcome`, {
      tags: ["gaming"],
      language: "en",
      welcome: "Welcome!",
      rules: "Be kind.",
      startChannelId: null,
    });
    await request("POST", `/groups/${room.id}/welcome/read`);
    check(
      "welcome guidance persists its dismissal and group topics",
      (await request("GET", `/groups/${room.id}/welcome`)).seen,
    );
    await sql`update conversations set is_public=true where id=${room.id}`;
    const discovery = await call(
      token,
      "GET",
      "/conversations/discover?tag=gaming&language=en",
    );
    check(
      "discovery filters by group interests and language",
      discovery.status === 200 &&
        discovery.body.conversations.some(
          (c) => c.id === room.id && c.tags.includes("gaming"),
        ),
    );
    const caught = await request("GET", "/catch-up");
    check(
      "catch-up returns activity and unread conversations without errors",
      Array.isArray(caught.items) && Array.isArray(caught.rooms),
    );
  } finally {
    await sql`update users set suspended_until=null where id=${userId}`;
    await sql`delete from conversations where id in (${room.id},${other.id})`;
    await sql`delete from saved_collections where user_id in (${userId},${ownerId})`;
  }
}
