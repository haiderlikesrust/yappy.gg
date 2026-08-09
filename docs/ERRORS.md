# Errors and rate limits

## The envelope

Every failure, from every endpoint, has the same shape:

```json
{
  "error": {
    "code": "missing_permission",
    "message": "You cannot send messages here",
    "details": { "permission": "SEND_MESSAGES" },
    "retryAfter": null
  }
}
```

Switch on `code`. Never switch on `message`: messages are user-facing copy, they
get reworded, and they will eventually be localised. `details` is present only
when there is something structured worth saying, and its shape depends on the
code.

## Codes

### 400 and 422, the request was wrong

| Code | Means |
|---|---|
| `bad_request` | Malformed in a way the schema did not catch |
| `validation_failed` | A field failed validation. `details` names the fields |
| `unsupported_media_type` | Wrong content type |
| `payload_too_large` | Body over the limit |
| `unprocessable` | Well formed, but not a thing that can be done |
| `edit_window_expired` | The message is too old to edit |
| `message_deleted` | The target message is gone |

### 401, we do not know who you are

| Code | Means |
|---|---|
| `unauthenticated` | Missing or unparseable credential |
| `token_expired` | Valid token, past its lifetime |
| `token_revoked` | Rotated, logged out, or the bot token was regenerated |

A bot token does not expire on a clock. `token_revoked` on a bot means it was
rotated or the application was deleted, so re-read your configuration rather
than retrying.

### 403, we know, and no

| Code | Means |
|---|---|
| `forbidden` | Not allowed, without a more specific reason |
| `missing_permission` | The permission bit is absent. `details.permission` names it |
| `blocked` | The other account has blocked this one |
| `privacy_restricted` | Their privacy settings do not allow this |
| `account_suspended` | The account is suspended. Reads still work, writes do not |

### 404, nothing here

| Code | Means |
|---|---|
| `not_found` | No such thing |
| `not_a_member` | The conversation exists but you are not in it |

A conversation you are not in usually answers `not_found` rather than
`not_a_member` or 403. Confirming that a private conversation exists is itself a
leak, so non-membership is answered with absence.

### 409, a conflict with what already is

| Code | Means |
|---|---|
| `conflict` | The state does not permit this |
| `already_exists` | Duplicate of something unique, such as a handle |
| `already_a_member` | Already joined |
| `call_already_ended` | The call is over |
| `call_full` | The call is at capacity |

### 429, slow down

| Code | Means |
|---|---|
| `rate_limited` | Bucket empty. `retryAfter` is seconds |
| `slow_mode` | The conversation has slow mode on. `retryAfter` is seconds |

### 500 and 503, our fault

| Code | Means |
|---|---|
| `internal_error` | Unexpected. Safe to retry with backoff |
| `service_unavailable` | A dependency is down. Retry with backoff |

## Rate limits

Limits are token buckets: a burst capacity that refills at a steady rate. Bots
are keyed on the bot account, so your limits are yours and are not shared with
the humans in a conversation.

| Action | Burst | Sustained |
|---|---|---|
| Send a message | 30 | 5 per second |
| Edit a message | 20 | 2 per second |
| Delete a message | 30 | 2 per second |
| Add a reaction | 50 | 10 per second |
| Forward a message | 10 | 1 per two seconds |
| Create an invite | 10 | 1 per minute |
| Search | 20 | 1 per second |

A well behaved bot never sees these. They exist for the loop that gets away from
you.

When you do get a 429, both the `Retry-After` header and `error.retryAfter`
carry the same number of seconds. Wait it out. Retrying immediately consumes
capacity you do not have and pushes the recovery further away.

## Retrying safely

`POST /conversations/:id/messages` requires a `nonce`, and that is what makes a
retry safe: replaying the same nonce returns the original message with 200
instead of posting a second copy. Derive the nonce from the logical send, not
from the attempt. A fresh random value per attempt turns your retry logic into a
duplicate-message generator.

Retry on 429, 500 and 503. Do not retry on 4xx otherwise: the request will fail
the same way every time, and the loop is just noise in both our logs.
