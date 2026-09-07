# Yapper staff tools

Available to active staff accounts in a private Yapper DM or a private system
staff channel. Commands also verify that the conversation has no non-staff human
members. `/staffhelp` lists these tools and the existing staff commands.

| Command | Result |
| --- | --- |
| `/health` | API uptime, database response time, private storage write/verification/delete probe, queue counts and recent failures. Queue counts do not prove a worker is alive. |
| `/case REF` | Support request or moderation report, evidence, recent actions, notes and email reply history. Use a full `SUP-…`, report UUID, or unique eight-character report prefix. |
| `/case REF note TEXT` | Save a private staff note. It is never included in customer email. |
| `/suspend @user 7d REASON` | Review then confirm a 1–365-day suspension, with a moderation case, session revocation and the existing suspension notices. Staff and bot targets are excluded. |
| `/warn @user REASON` | Review then confirm an official in-app warning. Records a case without changing account access. |
| `/appeals [open\|replied\|closed\|all] [page]` | Browse ten suspension appeals per page. Default: open requests. |
| `/appeals reply SUP-… MESSAGE` | Preview the recipient and email body, then press **Send reply**. Also works for other support-form ticket categories when their reference is known. |
| `/appeals close SUP-…` | Mark the request closed without sending email or changing account access. |
| `/appeals reopen SUP-…` | Return a request to the open queue. |

Confirmations belong to the requesting staff account and conversation and expire
after 15 minutes. Cancelled and replayed confirmations cannot repeat actions.
For suspensions and warnings the case ID is the durable idempotency key.

Replies use the password-reset email shell, including the branded header, rounded
message card, dark-mode styles and a plain-text alternative. Staff text is HTML
escaped. The subject retains the ticket reference; Reply-To is `SUPPORT_EMAIL`.
`SUPPORT_FROM` is optional and must be permitted by the SMTP provider; otherwise
the worker's normal configured sender is used.

The reply record and email job commit in one database transaction. A queue failure
leaves the preview retryable. A successful confirmation means **queued**, not a
guarantee of inbox delivery. `/case` shows the job state while the job remains in
pg-boss. Ten delivery retries use the existing worker. Once archived, delivery
status is reported as unavailable. SMTP delivery has its own possible retry
ambiguity, so duplicate-click protection is not a claim of exactly-once delivery.

Customer replies arrive in the support mailbox (Hostinger in this deployment).
There is no IMAP or inbound-email webhook synchronization into Yapper. The saved
Yapper history contains staff replies sent through Yapper only. Sending a reply
never restores a suspended account; use the existing `/unsuspend` after review.

The form's contact address and account hint are requester-supplied. Only a signed
appeal link supplies a verified account/report relationship. Review ownership
before including private account details in a reply.

Deployment: run the normal database migration command (`pnpm --filter @yappy/db
migrate`) before restarting the API and email worker. Migration
`0008_staff_commands.sql` adds ticket status, confirmations, reply history and
private notes. Existing support SMTP settings are reused; no new mail service is
required. Production still needs the code and migration deployed.

Validation: `pnpm --filter @yappy/api suspension-check` runs staff-command and
support regression tests in a disposable database without a mail worker; it does
not send real email.
