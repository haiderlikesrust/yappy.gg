import { messages, sql as raw } from '@yappy/db';

/**
 * "Delete for me".
 *
 * `message_deletions` holds a per-viewer tombstone: the message row stays
 * intact for everyone else, so a shared thread never develops holes. Writing
 * that row was implemented from the start — *reading* it was not, which meant
 * a message you deleted for yourself came straight back on the next fetch.
 *
 * This is the read half, and it has to be applied in SQL rather than by
 * filtering hydrated rows afterwards, for two reasons:
 *
 *   - `history` reports `hasMore` from `rows.length === limit`, so dropping
 *     rows after the query turns the last page of a conversation into an
 *     endless one.
 *   - the pinned-message route zips `hydrated[i]` against `rows[i]`
 *     positionally, and a post-filter would pair every pin with the wrong
 *     position.
 *
 * Correlated on `message_id`, which is the leading column of the table's
 * primary key, so this is an index lookup per row rather than a scan.
 */
export const notDeletedForViewer = (viewerId: string) =>
  raw`not exists (
        select 1
          from message_deletions d
         where d.message_id = ${messages.id}
           and d.user_id = ${viewerId}::uuid
      )`;

/**
 * The same predicate for hand-written SQL, where the messages table is aliased
 * and Drizzle's column references are unavailable.
 *
 * @param alias the table alias the caller gave `messages` (e.g. `msg`)
 */
export const notDeletedForViewerSql = (alias: string, viewerId: string) =>
  raw`not exists (
        select 1
          from message_deletions d
         where d.message_id = ${raw.raw(alias)}.id
           and d.user_id = ${viewerId}::uuid
      )`;
