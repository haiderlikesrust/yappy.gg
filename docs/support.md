# Help & Support

The public `/support/` page accepts account help, bugs, suspension appeals and general questions without sign-in. Android and iOS link to it from Settings, sign-in and suspension notices; the web app links from Settings, sign-in and password recovery. Replies stay in the support mailbox; the form shows a ticket reference after submission. It does not promise live chat or send unsolicited confirmation emails to guest-supplied addresses.

## Run and deploy

1. Build the database package and apply migration `0041_jittery_molecule_man.sql` using the normal database migration command.
2. Set API `SUPPORT_EMAIL` to the staff mailbox. Keep the email worker running with the existing SMTP or Resend configuration. An empty or invalid support address disables form submissions.
3. Deploy the API and `web/support/` files together. The production form calls `https://api.yappy.gg/v1/support`; its origin must be allowed by the existing API CORS configuration.
4. Release the Android/iOS updates for the new Settings and suspension links.

For local development, the web app's Vite server also serves the public form at port 5173 and proxies `/v1/support` to the local API. This supports the Android emulator's `10.0.2.2` address. Its remote development mode uses the existing production API proxy instead.

Tickets and the email job commit in the same PostgreSQL transaction. The client keeps a submission UUID across retries; reusing it with identical content returns the same reference. Provider retries use the existing email worker. Monitor failed `email.send` jobs as usual; a ticket receipt confirms durable intake and queued delivery, not arrival at the mailbox.

## Appeals and access

Suspension notifications and a credential-verified suspended sign-in return an appeal link. The fragment contains a 30-day JWT scoped to `support_appeal` and the `yappy-support` audience. It can link only the original account and report; it cannot authenticate app, portal, refresh or gateway access. The context endpoint exposes only username and a short case reference. Expired links offer an explicit unlinked appeal path.

Guest usernames and reply addresses are unverified. Even with a linked case, staff must verify ownership before disclosing private account information or changing access. Filing an appeal never changes suspension state or devices. Existing moderation tools remain the place to review and restore an account.

`support_tickets` retains the request, reference and case linkage for follow-up. There is no public ticket listing or lookup endpoint. Staff reply from the configured mailbox, retaining the reference in the subject. The form limits submission frequency by IP and reply address.

## Verification

`pnpm --filter @yappy/api suspension-check` creates and drops a disposable local PostgreSQL database. It checks support intake, transactional queue failure/retry, deduplication, input validation, rate limits, scoped appeals and suspension enforcement. It never starts a mail worker or uses real accounts.

Set `SUPPORT_BROWSER_CHECK=1` to additionally run the responsive form checks with Playwright. Playwright and its Chromium browser must be available; `PLAYWRIGHT_MODULE_PATH` can point to an existing installation, and `PLAYWRIGHT_CHANNEL=msedge` or `chrome` can use an installed browser. Screenshots are written to `.tools/`. The browser uses an isolated local server backed by the same disposable test API.
