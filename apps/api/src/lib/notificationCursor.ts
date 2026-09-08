import { z } from "zod";
import { notifications, sql } from "@yappy/db";

// Keep the database's microseconds and use the id to break timestamp ties.
// Clients treat cursors as opaque; legacy timestamp cursors still work.
export function notificationCursorBefore(cursor?: string) {
  if (!cursor) return undefined;
  const [at, id, extra] = cursor.split("|");
  const timestamp = z.string().datetime({ offset: true }).parse(at);
  if (id === undefined)
    return sql`${notifications.createdAt} < ${timestamp}::timestamptz`;
  z.undefined().parse(extra);
  const uuid = z.string().uuid().parse(id);
  return sql`(${notifications.createdAt}, ${notifications.id}) < (${timestamp}::timestamptz, ${uuid}::uuid)`;
}
