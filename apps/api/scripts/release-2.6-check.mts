/** Local PostgreSQL regression checks. All writes roll back; no pushes are sent.
 * Run in apps/api: pnpm exec tsx --env-file=../../.env scripts/release-2.6-check.mts
 */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { ZodError } from "zod";
import {
  createDb,
  sql as raw,
  users,
  conversations,
  conversationMembers,
  calls,
  callParticipants,
  devices,
  presence,
  messages,
  notifications,
  groupPets,
  pushOutbox,
  eq,
  and,
  conversationRoles,
  memberRoles,
} from "@yappy/db";
import { newId, AppError } from "@yappy/shared";
import { conversationRoutes } from "../src/routes/conversations.js";
import { socialRoutes } from "../src/routes/social.js";
import { spaceRoutes } from "../src/routes/spaces.js";
import { roomService } from "../src/lib/livekit.js";
import { decodeJwt } from "jose";
import { notifyUser } from "../src/lib/notify.js";
import { tendGroupPets } from "../../worker/src/jobs/pets.js";
import { handleMessageFanout } from "../../worker/src/jobs/push.js";

const url = process.env.DATABASE_URL!;
assert(
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname),
  "Use a local test database",
);
assert.notEqual(process.env.NODE_ENV, "production");
const { db, sql } = createDb({ url, max: 1 });
const rollback = new Error("intentional rollback");
let checks = 0;
const check = (name: string, fn: () => void) => {
  fn();
  checks++;
  console.log(`ok ${name}`);
};
try {
  await db.transaction(async (tx) => {
    const app = Fastify({ logger: false });
    app.decorate("db", tx);
    const authenticate = async (req: any) => {
      req.user = { id: req.headers["x-test-user"] };
      req.deviceId = req.headers["x-test-device"];
    };
    app.decorate("authenticate", authenticate);
    app.decorate("authenticateOnboarded", authenticate);
    const events: unknown[] = [];
    const voiceEvents: any[] = [];
    app.decorate("events", {
      toUser: async (...args: unknown[]) => {
        events.push(args);
      },
      toUsers: async (...args: unknown[]) => {
        voiceEvents.push(args);
      },
      toConversation: async () => {},
    });
    app.decorate("limiter", { consume: async () => {} });
    app.setErrorHandler((err, _req, reply) =>
      reply
        .code(
          err instanceof AppError
            ? err.status
            : err instanceof ZodError
              ? 400
              : 500,
        )
        .send({ error: err.message }),
    );
    await app.register(conversationRoutes, { prefix: "/conversations" });
    await app.register(socialRoutes, { prefix: "/social" });
    await app.register(spaceRoutes, { prefix: "/conversations" });
    // Exercise route state and signed grants without contacting an SFU.
    const rtc = roomService();
    const createRoom = rtc.createRoom,
      listRoomParticipants = rtc.listParticipants;
    rtc.createRoom = async () => ({}) as any;
    rtc.listParticipants = async () => {
      throw new Error("simulated SFU outage");
    };
    try {
      const owner = newId(),
        viewer = newId(),
        stranger = newId(),
        bot = newId();
      await tx
        .insert(users)
        .values([
          { id: owner },
          { id: viewer },
          { id: stranger },
          { id: bot, isBot: true },
        ]);
      const space = newId(),
        open = newId(),
        secret = newId(),
        gone = newId();
      await tx
        .insert(conversations)
        .values({ id: space, type: "space", ownerId: owner });
      await tx.insert(conversations).values([
        {
          id: open,
          type: "channel",
          parentId: space,
          title: "public voice",
          isVoice: true,
        },
        {
          id: secret,
          type: "channel",
          parentId: space,
          title: "secret voice",
          isVoice: true,
          basePermissions: 0n,
        },
        {
          id: gone,
          type: "channel",
          parentId: space,
          title: "deleted voice",
          isVoice: true,
          deletedAt: new Date(),
        },
      ]);
      await tx.insert(conversationMembers).values([
        { conversationId: space, userId: owner, role: "owner" },
        { conversationId: space, userId: viewer, role: "member" },
      ]);
      for (const channel of [open, secret, gone]) {
        const call = newId(),
          device = newId();
        await tx
          .insert(calls)
          .values({
            id: call,
            conversationId: channel,
            roomName: call,
            state: "active",
          });
        await tx.insert(callParticipants).values(
          [owner, viewer].map((userId) => ({
            callId: call,
            userId,
            state: "joined" as const,
            joinedAt: new Date(),
          })),
        );
        await tx
          .insert(devices)
          .values({ id: device, userId: owner, platform: "android" });
        await tx
          .insert(presence)
          .values({
            deviceId: device,
            userId: owner,
            nodeId: "release-test",
            viewingConversationId: channel,
            expiresAt: new Date(Date.now() + 60_000),
          });
      }
      const get = (path: string, user = viewer) =>
        app.inject({ url: path, headers: { "x-test-user": user } });
      let res = await get(`/conversations/${space}/activity`);
      check(
        "activity includes only visible, live channels and excludes caller",
        () => {
          assert.equal(res.statusCode, 200, res.body);
          assert.deepEqual(
            res.json().reading.map((r: any) => r.conversationId),
            [open],
          );
          assert.deepEqual(res.json().inVoice, [
            { conversationId: open, title: "public voice", userIds: [owner] },
          ]);
        },
      );
      res = await get(`/conversations/${secret}/activity`);
      check("direct private-channel activity is denied", () =>
        assert.equal(res.statusCode, 403, res.body),
      );
      res = await get(`/conversations/${space}/activity`, stranger);
      check("nonmember activity is denied", () =>
        assert.equal(res.statusCode, 404, res.body),
      );
      await tx.execute(
        raw`update users set privacy = privacy || '{"ambientPresence":false}'::jsonb where id=${owner}::uuid`,
      );
      res = await get(`/conversations/${space}/activity`);
      check(
        "ambient privacy hides reading but keeps public voice visible",
        () => {
          assert.deepEqual(res.json().reading, []);
          assert.equal(res.json().inVoice.length, 1);
        },
      );
      const joinVoice = (channel: string, user = viewer, device?: string) =>
        app.inject({
          method: "POST",
          url: `/conversations/${channel}/voice/join`,
          headers: {
            "x-test-user": user,
            ...(device ? { "x-test-device": device } : {}),
          },
        });
      res = await joinVoice(secret);
      check("private voice join enforces channel visibility", () =>
        assert.equal(res.statusCode, 403),
      );
      await tx
        .update(conversationMembers)
        .set({ deny: 1n << 21n })
        .where(
          and(
            eq(conversationMembers.conversationId, space),
            eq(conversationMembers.userId, viewer),
          ),
        );
      res = await joinVoice(open);
      check("voice join enforces JOIN_CALL permission", () =>
        assert.equal(res.statusCode, 403),
      );
      await tx
        .update(conversationMembers)
        .set({ deny: 0n })
        .where(
          and(
            eq(conversationMembers.conversationId, space),
            eq(conversationMembers.userId, viewer),
          ),
        );
      res = await joinVoice(secret, owner);
      check("private voice events go only to authorized viewers", () => {
        assert.equal(res.statusCode, 200, res.body);
        assert.deepEqual(voiceEvents.at(-1)[0], [owner]);
      });
      check("voice tokens allow microphone publishing only", () => {
        const grant = decodeJwt(res.json().token).video as any;
        assert.deepEqual(grant.canPublishSources, ["microphone"]);
      });
      const phone1 = newId(),
        phone2 = newId();
      await tx
        .insert(devices)
        .values(
          [phone1, phone2].map((id) => ({
            id,
            userId: viewer,
            platform: "android" as const,
          })),
        );
      await joinVoice(open, viewer, phone1);
      await joinVoice(open, viewer, phone2);
      res = await app.inject({
        method: "PATCH",
        url: `/conversations/${open}/voice/state`,
        headers: { "x-test-user": viewer, "x-test-device": phone2 },
        payload: { isMuted: true },
      });
      check("mute changes reach the shared roster", () => {
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(
          voiceEvents.at(-1)[2].participants.find((p: any) => p.id === viewer)
            .isMuted,
          true,
        );
      });
      res = await app.inject({
        method: "PATCH",
        url: `/conversations/${open}/voice/state`,
        headers: { "x-test-user": viewer, "x-test-device": phone1 },
        payload: { isMuted: false },
      });
      check("old phone cannot change the active phone mute state", () =>
        assert.equal(res.statusCode, 404),
      );
      await app.inject({
        method: "POST",
        url: `/conversations/${open}/voice/leave`,
        headers: { "x-test-user": viewer, "x-test-device": phone1 },
      });
      let seats = await tx
        .select()
        .from(callParticipants)
        .innerJoin(calls, eq(calls.id, callParticipants.callId))
        .where(
          and(
            eq(calls.conversationId, open),
            eq(callParticipants.userId, viewer),
          ),
        );
      check("old phone leave cannot evict the newer phone", () => {
        assert.equal(seats[0].call_participants.state, "joined");
        assert.equal(seats[0].call_participants.deviceId, phone2);
      });
      await tx
        .update(callParticipants)
        .set({ joinedAt: new Date(Date.now() - 120_000) })
        .where(eq(callParticipants.userId, viewer));
      res = await get(`/conversations/${space}/channels`);
      check("SFU outage cannot erase valid voice seats", () => {
        assert.equal(res.statusCode, 200, res.body);
        const occupants = res
          .json()
          .channels.find((c: any) => c.id === open).voiceParticipants;
        assert(occupants.some((p: any) => p.id === viewer));
      });

      // Same microsecond timestamps and a sub-millisecond predecessor.
      for (let i = 0; i < 5; i++)
        await tx.execute(raw`
        insert into notifications(id,user_id,kind,created_at) values
        (${newId()}::uuid,${viewer}::uuid,'role_granted','2026-01-01T00:00:00.123456Z')`);
      await tx.execute(raw`insert into notifications(id,user_id,kind,created_at) values
        (${newId()}::uuid,${viewer}::uuid,'role_granted','2026-01-01T00:00:00.123455Z')`);
      let cursor: string | null = null;
      const ids: string[] = [];
      do {
        res = await get(
          "/social/notifications?limit=2" +
            (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
        );
        assert.equal(res.statusCode, 200, res.body);
        ids.push(...res.json().notifications.map((n: any) => n.id));
        cursor = res.json().nextCursor;
        assert(ids.length <= 6, "pagination repeated a row");
      } while (cursor);
      check(
        "paging preserves timestamp ties and microseconds without duplicates",
        () => {
          assert.equal(ids.length, 6);
          assert.equal(new Set(ids).size, 6);
        },
      );
      res = await get("/social/notifications?cursor=garbage");
      check("malformed cursor returns 400", () =>
        assert.equal(res.statusCode, 400),
      );
      res = await get(
        "/social/notifications?cursor=2026-01-02T00%3A00%3A00.000Z",
      );
      check("legacy timestamp cursor remains supported", () =>
        assert.equal(res.json().notifications.length, 6),
      );
      await app.inject({
        method: "DELETE",
        url: `/social/notifications/${ids[0]}`,
        headers: { "x-test-user": stranger },
      });
      res = await get("/social/notifications");
      check("dismiss cannot delete another account notice", () =>
        assert.equal(res.json().notifications.length, 6),
      );
      await app.inject({
        method: "POST",
        url: "/social/notifications/read",
        headers: { "x-test-user": viewer },
        payload: { ids: [ids[0]] },
      });
      res = await get("/social/notifications");
      check("selective read leaves unseen notices unread", () =>
        assert.equal(
          res.json().notifications.filter((n: any) => n.readAt).length,
          1,
        ),
      );

      for (const kind of [
        "group_verified",
        "affiliate_granted",
        "role_granted",
        "group_verification_declined",
      ] as const) {
        await notifyUser(app, {
          userId: viewer,
          kind,
          targetType: "conversation",
          targetId: space,
          data: { title: "Test place" },
        });
      }
      const queued = await tx
        .select()
        .from(pushOutbox)
        .where(eq(pushOutbox.userId, viewer));
      check("each centre notice queues one push and one gateway event", () => {
        assert.equal(queued.length, 4);
        assert.equal(events.length, 4);
        assert(
          queued.every(
            (p) =>
              p.data.type === "notification" &&
              p.data.notificationId &&
              p.data.conversationId === space,
          ),
        );
      });

      // A real worker query, with devices/providers deliberately never invoked.
      const group = newId(),
        message = newId(),
        role = newId();
      await tx
        .insert(conversations)
        .values({ id: group, type: "group", title: "push checks" });
      await tx
        .insert(conversationMembers)
        .values(
          [owner, viewer].map((userId) => ({
            conversationId: group,
            userId,
            notificationLevel: "all" as const,
          })),
        );
      await tx
        .insert(messages)
        .values({
          id: message,
          conversationId: group,
          senderId: owner,
          type: "text",
          content: "hello",
          seq: 1,
          nonce: message,
        });
      await tx
        .insert(conversationRoles)
        .values({ id: role, conversationId: group, name: "test role" });
      await tx
        .insert(memberRoles)
        .values({ roleId: role, conversationId: group, userId: viewer });
      const fanout = async (
        groups: string,
        broadcastMentions: boolean | undefined,
        direct = false,
        roleMention = false,
      ) => {
        await tx.delete(pushOutbox).where(eq(pushOutbox.userId, viewer));
        await tx.execute(
          raw`update users set notifications=${JSON.stringify({ groups, broadcastMentions, showPreview: true })}::jsonb where id=${viewer}::uuid`,
        );
        await handleMessageFanout({ db: tx, log: app.log } as any, {
          messageId: message,
          conversationId: group,
          senderId: owner,
          seq: 1,
          silent: false,
          mentionIds: direct ? [viewer] : [],
          broadcast: !roleMention,
          mentionRoleIds: roleMention ? [role] : [],
        });
        return tx
          .select()
          .from(pushOutbox)
          .where(eq(pushOutbox.userId, viewer));
      };
      let pushes = await fanout("mentions", false);
      check("mentions-only suppresses disabled broadcasts", () =>
        assert.equal(pushes.length, 0),
      );
      pushes = await fanout("all", false);
      check("all demotes disabled broadcasts to ordinary messages", () =>
        assert.equal(pushes[0]?.kind, "message"),
      );
      await handleMessageFanout({ db: tx, log: app.log } as any, {
        messageId: message,
        conversationId: group,
        senderId: owner,
        seq: 1,
        silent: false,
        mentionIds: [],
        broadcast: true,
      });
      pushes = await tx
        .select()
        .from(pushOutbox)
        .where(eq(pushOutbox.userId, viewer));
      check(
        "worker retry deduplicates rather than failing or duplicating pushes",
        () => assert.equal(pushes.length, 1),
      );
      pushes = await fanout("mentions", false, true);
      check("direct names survive disabled broadcasts", () =>
        assert.equal(pushes[0]?.kind, "mention"),
      );
      pushes = await fanout("none", true, true);
      check("global none suppresses even a direct mention", () =>
        assert.equal(pushes.length, 0),
      );
      pushes = await fanout("mentions", undefined);
      check("legacy accounts keep broadcasts enabled", () =>
        assert.equal(pushes[0]?.kind, "mention"),
      );
      pushes = await fanout("mentions", false, false, true);
      check("role mentions use the same broadcast preference", () =>
        assert.equal(pushes.length, 0),
      );

      const petGroup = newId(),
        petCall = newId();
      await tx.insert(conversations).values({ id: petGroup, type: "group" });
      await tx
        .insert(groupPets)
        .values({
          conversationId: petGroup,
          bornAt: new Date(Date.now() - 20 * 86_400_000),
        });
      const yesterday = new Date();
      yesterday.setUTCHours(0, 0, 0, 0);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      await tx
        .insert(calls)
        .values({
          id: petCall,
          conversationId: petGroup,
          roomName: petCall,
          state: "ended",
        });
      await tx
        .insert(callParticipants)
        .values(
          [owner, viewer].map((userId) => ({
            callId: petCall,
            userId,
            state: "left" as const,
            joinedAt: yesterday,
          })),
        );
      await tendGroupPets(tx as any, app.log);
      let [pet] = await tx
        .select()
        .from(groupPets)
        .where(eq(groupPets.conversationId, petGroup));
      check("yesterday voice feeds an old silent pet without wandering", () => {
        assert.equal(pet.fedDays, 1);
        assert.equal(pet.wanderedAt, null);
        assert.equal(pet.lastFedOn, yesterday.toISOString().slice(0, 10));
      });
      await tendGroupPets(tx as any, app.log);
      [pet] = await tx
        .select()
        .from(groupPets)
        .where(eq(groupPets.conversationId, petGroup));
      check("retrying the pet cron cannot double-feed", () =>
        assert.equal(pet.fedDays, 1),
      );
      console.log(
        `${checks} release 2.6 checks passed; rolling back fixtures.`,
      );
    } finally {
      rtc.createRoom = createRoom;
      rtc.listParticipants = listRoomParticipants;
      await app.close();
    }
    throw rollback;
  });
} catch (err) {
  if (err !== rollback) throw err;
} finally {
  await sql.end();
}
