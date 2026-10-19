# Idempotency keys

`src/idempotency.ts` implements the `Idempotency-Key` request header
(draft-ietf-httpapi-idempotency-key-header) for every `POST` under `/api/v1`.

## Why

All mutations were plain `POST`s with no retry safety. A client that timed out
and retried `POST /contracts/:id/deposit` had the deposit applied twice, and a
retried `POST /api/v1/contracts` created a duplicate escrow with a new id.
Wallets and mobile clients retry on flaky networks by design; on-chain the
equivalent operation is a signed transaction with a sequence number and cannot
be replayed, so the API was weaker than the chain it mirrors.

## Behaviour

| Situation | Result |
| --- | --- |
| No header, `IDEMPOTENCY_REQUIRED` unset | Current behaviour — the request runs normally |
| No header, `IDEMPOTENCY_REQUIRED=true` | `400 idempotency_key_required` |
| Key is empty, > 255 chars, or not printable ASCII | `400 invalid_idempotency_key` |
| Same key + same body, first attempt completed | Stored status and body replayed, `Idempotent-Replayed: true` |
| Same key + **different** body | `422 idempotency_key_reused` |
| Same key while the first request is still running | `409 idempotency_request_in_progress`, `Retry-After: 1` |
| First attempt returned 5xx | Not cached; the key is released so a retry runs for real |
| First attempt returned 4xx | Cached and replayed — a failed validation is a final outcome for that body |

Only `POST` is scoped. `GET` requests pass straight through, so the middleware
costs nothing on reads.

## Key scoping

A stored response is addressed by `method + path + principal + key`. The
principal is taken from `req.user.id`, `req.principal` or `req.accountId`,
whichever is present.

**This service has no authentication yet**, so every request currently resolves
to the `anonymous` principal and shares one namespace. That means a caller who
guesses another caller's key can read back that response. The key is a
client-chosen secret in that situation, which is not a security boundary — it is
a retry-safety mechanism. **When authentication lands, the principal must be
populated so keys are namespaced per caller.** This is the single known
limitation of the current implementation and is called out here rather than
left implicit.

## Storage

`MemoryIdempotencyStore` is process-local:

- **TTL** — 24 hours by default. Expired records are swept on read as well as on
  write, so a store that is only read still shrinks.
- **Capacity** — 10 000 entries by default. `Map` insertion order is used as the
  recency order: a `get` or `set` re-inserts the key, so the oldest *live* entry
  is evicted first. This bounds memory under a flood of unique keys.
- **Locks** — a key is locked while its first request is in flight, which is what
  produces the `409`. The lock is cleared when a record is committed, or
  released explicitly when the response is a 5xx or the client disconnects
  before a response is produced.

Records do not survive a redeploy, and they are not shared between serverless
instances. The `IdempotencyStore` interface is deliberately async with only
`get` / `set` / `lock` / `unlock`, so a Redis or Postgres adapter can implement
it later without touching the middleware.

## Why the record is committed before the response is sent

`installCapture` replaces `res.json` and awaits the store write **before**
flushing the body. Using `res.on('finish')` instead would leave a window where
the client has received the first response but the record is still pending, so
an immediate retry would be treated as a fresh request — exactly the case the
feature exists to prevent. Committing first makes the replay deterministic.

The cost is one store round-trip added to the response path of a mutating
request. For the in-memory store that is negligible; a networked adapter would
add its latency to every `POST`, which is worth knowing before swapping one in.

## Fingerprinting

The body is hashed with sha256 over `canonicalJson`, which sorts object keys
recursively. So `{a:1,b:2}` and `{b:2,a:1}` are the same request, while array
order stays significant. A request with no body fingerprints as `null`, so two
body-less `POST`s with the same key replay each other.

## Configuration

| Env var | Default | Effect |
| --- | --- | --- |
| `IDEMPOTENCY_REQUIRED` | `false` | `true` makes the header mandatory on `POST` |

## Tests

`tests/idempotency.test.ts` covers the retried-deposit case (the one that fails
on `main`), duplicate-escrow prevention, canonical body ordering, the 422
conflict, 4xx replay, malformed keys, the optional and required modes, `GET`
pass-through, the concurrent 409 (holding the first request open with a deferred
promise), 5xx not being cached, TTL expiry under fake timers, LRU eviction at
capacity, memory bounds under a key flood, lock exclusivity, canonical JSON,
key validation, and that the OpenAPI document declares the header and both
failure responses on every `POST`.
