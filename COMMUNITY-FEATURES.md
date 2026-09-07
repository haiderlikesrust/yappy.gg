# Catch up and community tools

The web, Android and iOS clients share `/v1/community` for:

- Catch up: unread mentions, replies, new pins, group updates and unread conversations, with message jumps.
- Explore: group interests and language filters, visible tags and explanations for matches.
- Events: admin creation/editing/cancellation, Going/Maybe/Can't go responses, local times and optional reminders.
- Message reminders and scheduled text, managed from Catch up.
- Saved collections with private notes and search. Deleting a collection keeps its messages and notes.
- Admin welcome pages, rules, interests and a permitted starting channel. Members can dismiss welcome guidance.
- Web send retries that retain the original nonce and content after network failures.

## Deployment

Deploy the database, API and worker before publishing the updated clients. Run the normal `pnpm db:migrate` command against the intended deployment database; it applies migrations 0042 and 0043 and the read-permission function in `sql/0005_community.sql`. Migration 0043 backfills the delivery marker for existing scheduled messages. Do not run only the generated SQL files: the SQL helpers are required too.

Rebuild the shared/database packages and restart both the API and worker. The worker's existing minute maintenance job queues due work; API consumers deliver it through the normal message service and durable notification outbox. No new environment variables are needed. Existing push configuration is still required for device pushes.

Schedules and reminders can arrive about a minute after their selected time. Scheduled sends support plain text; encrypted conversations, attachments and replies do not offer scheduling. Sending rechecks current permissions and suspension state. Terminal failures appear in Scheduled and Notifications. Retried jobs use stable IDs; deleting a delivered message does not make its schedule send again.

Reminders recheck membership, visibility, deleted-for-me messages, account state and event cancellation at delivery. Quiet hours suppress pushes while keeping the in-app reminder. Disabling previews conceals reminder content in the push. Event descriptions and RSVP changes do not repeat an already delivered reminder; changing the start time reschedules it.

Catch up shows the most recent 60 activity items and 30 unread conversations. Events, reminders, schedules and saved search return up to 100 matching entries. Search applies before the saved-results limit. Existing conversation recaps remain available within chats/groups.

## Validation

- `pnpm -r typecheck`
- `pnpm --filter @yappy/webapp build`
- `pnpm --filter @yappy/api suspension-check` uses a disposable local database and covers community permissions, concurrent delivery, cancellation, collection ownership, event edits, suspension and support regressions. It does not send real email or push notifications.
- Start a local web preview, set `WEB_QA_URL` to its origin, and run `pnpm --filter @yappy/webapp community-check`, `notifications-check`, and `notification-cache-check`. The browser checks require Playwright (or `PLAYWRIGHT_MODULE_PATH`) and use fixture APIs. Screenshots are written to ignored `.tools` folders.
- From `android`, run `.\gradlew.bat :app:assembleDebug :app:compileReleaseKotlin --console=plain`.
- Build iOS with Xcode and run the device checklist in `ios/NATIVE-UI-QA.md`. Windows syntax inspection cannot replace Apple SDK compilation or device testing. The iOS calling feature remains disabled.

On actual devices, verify local dates around daylight-saving changes, large accessibility text, VoiceOver/TalkBack, keyboard dismissal, back navigation, offline retry and cancellation. Verify delivery while the app is closed against a staging API/worker and configured push provider before publishing mobile releases.
