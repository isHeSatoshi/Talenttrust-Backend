/**
 * `Idempotency-Key` support for `POST` mutations
 * (draft-ietf-httpapi-idempotency-key-header).
 *
 * Why this exists: every mutation was a plain `POST` with no retry safety, so a
 * client that timed out and retried `POST /contracts/:id/deposit` had the
 * deposit applied twice, and a retried `POST /api/v1/contracts` created a
 * duplicate escrow with a new id. Wallets and mobile clients retry on flaky
 * networks by design; on-chain the equivalent operation is a signed transaction
 * with a sequence number and cannot be replayed, so the API was weaker than the
 * chain it mirrors.
 *
 * The store is deliberately an async interface with only four operations, so a
 * shared adapter (Redis, Postgres) can implement it later without touching the
 * middleware. Only the in-memory implementation ships here.
 */

import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** The request header, per the IETF draft. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Set on a replayed response so a client can tell a replay from a fresh run. */
export const REPLAY_HEADER = 'Idempotent-Replayed';

/** Default retention. Long enough to cover a client's retry window. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Default ceiling on retained records, so a flood of unique keys cannot grow without bound. */
export const DEFAULT_MAX_ENTRIES = 10_000;

/** A completed response bound to the request that produced it. */
export interface IdempotencyRecord {
  /** sha256 of the canonical request body. */
  fingerprint: string;
  status: number;
  body: unknown;
  /** Response headers worth replaying. */
  headers: Record<string, string>;
  createdAt: number;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | undefined>;
  set(key: string, record: IdempotencyRecord): Promise<void>;
  /** Returns false when another request already holds the key. */
  lock(key: string): Promise<boolean>;
  unlock(key: string): Promise<void>;
}

interface Entry {
  record: IdempotencyRecord;
  expiresAt: number;
}

/**
 * Process-local store with TTL expiry and LRU eviction.
 *
 * `Map` preserves insertion order, which is used as the recency order: a `get`
 * or `set` re-inserts the key so the oldest *live* entry is always first. Reads
 * also sweep expired entries, so a store that is only read still shrinks.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly locks = new Set<string>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  /** Live entry count. Expired records are swept first. */
  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert to mark this key as most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.record;
  }

  async set(key: string, record: IdempotencyRecord): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, { record, expiresAt: this.now() + this.ttlMs });
    this.locks.delete(key);
    this.evictIfNeeded();
  }

  async lock(key: string): Promise<boolean> {
    if (this.locks.has(key)) return false;
    this.locks.add(key);
    return true;
  }

  async unlock(key: string): Promise<void> {
    this.locks.delete(key);
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private evictIfNeeded(): void {
    this.sweep();
    // Oldest-first: insertion order is the recency order.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * Stable JSON for fingerprinting: object keys are sorted recursively, so
 * `{a:1,b:2}` and `{b:2,a:1}` hash identically while arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  const sorted = JSON.stringify(sortValue(value));
  // `JSON.stringify(undefined)` is `undefined`, not a string.
  return sorted === undefined ? 'null' : sorted;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}

/** sha256 over the canonical body. */
export function fingerprint(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/** 1–255 printable ASCII characters. */
export function isValidKey(key: string): boolean {
  if (key.length < 1 || key.length > 255) return false;
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]+$/.test(key);
}

/**
 * Scope key = method + path + key (+ principal).
 *
 * The principal is included when one is present, so one caller cannot replay
 * another's response by guessing a key. This app has no authentication yet, so
 * the anonymous case falls back to a shared namespace — documented in
 * `docs/backend/idempotency.md` as the limitation to revisit when auth lands.
 */
export function scopeKey(req: Request, key: string): string {
  const principal = principalOf(req);
  return `${req.method.toUpperCase()} ${req.baseUrl}${req.path} ${principal} ${key}`;
}

function principalOf(req: Request): string {
  const candidate = req as Request & {
    user?: { id?: string };
    principal?: string;
    accountId?: string;
  };
  return candidate.user?.id ?? candidate.principal ?? candidate.accountId ?? 'anonymous';
}

export interface IdempotencyOptions {
  store?: IdempotencyStore;
  /** Require the header on every POST. Defaults to `IDEMPOTENCY_REQUIRED=true`. */
  required?: boolean;
  ttlMs?: number;
  maxEntries?: number;
}

/**
 * Express middleware for `POST` requests.
 *
 * Behaviour:
 * - no header -> current behaviour, unless `required` is set (`400 idempotency_key_required`)
 * - malformed key -> `400 invalid_idempotency_key`
 * - same key + same body, after completion -> replay the stored status and body
 *   with `Idempotent-Replayed: true`
 * - same key + different body -> `422 idempotency_key_reused`
 * - same key while the first request is in flight -> `409 idempotency_request_in_progress`
 *   with `Retry-After: 1`
 * - responses below 500 are cached; a 5xx releases the key so the client can retry
 */
export function idempotency(options: IdempotencyOptions = {}) {
  const store =
    options.store ??
    new MemoryIdempotencyStore({ ttlMs: options.ttlMs, maxEntries: options.maxEntries });
  const required = options.required ?? process.env.IDEMPOTENCY_REQUIRED === 'true';

  return function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Only mutations are idempotency-scoped.
    if (req.method !== 'POST') {
      next();
      return;
    }

    const raw = req.get(IDEMPOTENCY_HEADER);

    if (raw === undefined || raw === '') {
      if (required) {
        sendError(res, 400, 'idempotency_key_required', `POST requests must carry an ${IDEMPOTENCY_HEADER} header`);
        return;
      }
      next();
      return;
    }

    if (!isValidKey(raw)) {
      sendError(
        res,
        400,
        'invalid_idempotency_key',
        `${IDEMPOTENCY_HEADER} must be 1-255 printable ASCII characters`,
      );
      return;
    }

    const key = scopeKey(req, raw);
    const fp = fingerprint(req.body ?? null);

    // Async from here, so failures go to the app's error handler.
    void handle().catch(next);

    async function handle(): Promise<void> {
      const existing = await store.get(key);

      if (existing) {
        if (existing.fingerprint !== fp) {
          sendError(
            res,
            422,
            'idempotency_key_reused',
            `${IDEMPOTENCY_HEADER} was already used for a different request body`,
          );
          return;
        }
        // Same key, same body: replay the original outcome verbatim.
        res.status(existing.status);
        for (const [name, value] of Object.entries(existing.headers)) res.setHeader(name, value);
        res.setHeader(REPLAY_HEADER, 'true');
        res.json(existing.body);
        return;
      }

      if (!(await store.lock(key))) {
        res.setHeader('Retry-After', '1');
        sendError(
          res,
          409,
          'idempotency_request_in_progress',
          'A request with this idempotency key is still in progress',
        );
        return;
      }

      installCapture(res, key, fp, store);

      // If the client disconnects before a response is produced, release the key
      // so a retry is not blocked forever by a request that never completed.
      res.on('close', () => {
        if (!res.writableEnded) void store.unlock(key).catch(() => {});
      });

      next();
    }
  };
}

/**
 * Capture the outgoing JSON response and commit it to the store **before** the
 * body is flushed.
 *
 * Committing first is what makes a replay deterministic: the client cannot
 * observe a completed response whose record has not been written yet, so an
 * immediate retry always finds the record. Using `res.on('finish')` instead
 * would leave a window where the first response has been received but the
 * record is still pending.
 */
function installCapture(
  res: Response,
  key: string,
  fp: string,
  store: IdempotencyStore,
): void {
  const originalJson = res.json.bind(res);

  res.json = function capturedJson(body: unknown) {
    const status = res.statusCode;
    const headers: Record<string, string> = {};
    const contentType = res.getHeader('content-type');
    if (typeof contentType === 'string') headers['content-type'] = contentType;

    const commit =
      status < 500
        ? store.set(key, { fingerprint: fp, status, body, headers, createdAt: Date.now() })
        : // A server error is not a final outcome: release the key so the
          // client's retry is treated as a fresh request.
          store.unlock(key);

    void commit
      .catch(() => {})
      .then(() => {
        originalJson(body);
      });

    return res;
  } as Response['json'];
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}
