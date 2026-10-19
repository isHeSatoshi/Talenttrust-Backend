import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import {
  canonicalJson,
  fingerprint,
  isValidKey,
  MemoryIdempotencyStore,
  type IdempotencyRecord,
  type IdempotencyStore,
} from '../src/idempotency';

const KEY = 'idempotency-key';

const record = (fingerprintValue: string, status = 200): IdempotencyRecord => ({
  fingerprint: fingerprintValue,
  status,
  body: { ok: true },
  headers: { 'content-type': 'application/json; charset=utf-8' },
  createdAt: Date.now(),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A fresh app per test, so no store state leaks between cases. */
const freshApp = () => createApp(new EscrowStore().seed());

describe('Idempotency-Key on POST mutations', () => {
  it('applies a retried deposit once and replays the second response', async () => {
    // This is the test that fails on main: without the header the store simply
    // adds the amount again, so fundedAmount would reach 100 and the second
    // response would be a fresh 200 rather than a replay.
    const app = freshApp();
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] });
    const id = created.body.id;

    const first = await request(app)
      .post(`/api/v1/contracts/${id}/deposit`)
      .set(KEY, 'deposit-once')
      .send({ amount: 50 });
    expect(first.status).toBe(200);
    expect(first.body.fundedAmount).toBe(50);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const second = await request(app)
      .post(`/api/v1/contracts/${id}/deposit`)
      .set(KEY, 'deposit-once')
      .send({ amount: 50 });

    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);

    // The amount was applied exactly once.
    const after = await request(app).get(`/api/v1/contracts/${id}`);
    expect(after.body.fundedAmount).toBe(50);
  });

  it('does not create a duplicate escrow when the create is retried', async () => {
    const app = freshApp();
    const body = { client: 'GA', freelancer: 'GB', milestones: [{ amount: 10 }] };

    const first = await request(app).post('/api/v1/contracts').set(KEY, 'create-once').send(body);
    const second = await request(app).post('/api/v1/contracts').set(KEY, 'create-once').send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);

    const list = await request(app).get('/api/v1/contracts');
    const mine = list.body.data.filter((c: { id: number }) => c.id === first.body.id);
    expect(mine).toHaveLength(1);
  });

  it('treats reordered body keys as the same request', async () => {
    const app = freshApp();
    const first = await request(app)
      .post('/api/v1/contracts')
      .set(KEY, 'canonical')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 10 }] });
    const second = await request(app)
      .post('/api/v1/contracts')
      .set(KEY, 'canonical')
      .send({ milestones: [{ amount: 10 }], freelancer: 'GB', client: 'GA' });

    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
  });

  it('rejects the same key used with a different body', async () => {
    const app = freshApp();
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] });
    const id = created.body.id;

    await request(app).post(`/api/v1/contracts/${id}/deposit`).set(KEY, 'reuse').send({ amount: 10 });
    const conflict = await request(app)
      .post(`/api/v1/contracts/${id}/deposit`)
      .set(KEY, 'reuse')
      .send({ amount: 20 });

    expect(conflict.status).toBe(422);
    expect(conflict.body.error).toBe('idempotency_key_reused');
  });

  it('replays a 4xx outcome instead of re-executing it', async () => {
    const app = freshApp();
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] });
    const id = created.body.id;

    // Over-funding fails with 409. That is a final outcome for this body, so a
    // retry must replay it rather than run the check again.
    const first = await request(app)
      .post(`/api/v1/contracts/${id}/deposit`)
      .set(KEY, 'overfund')
      .send({ amount: 999 });
    expect(first.status).toBe(409);
    expect(first.body.error).toBe('over_funded');

    const second = await request(app)
      .post(`/api/v1/contracts/${id}/deposit`)
      .set(KEY, 'overfund')
      .send({ amount: 999 });

    expect(second.status).toBe(409);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
  });

  it('rejects a malformed key', async () => {
    const app = freshApp();
    const tooLong = 'x'.repeat(256);

    // A non-ASCII character is not printable ASCII. (A space IS: 0x20, so it is
    // deliberately accepted — see the isValidKey cases below.)
    const nonAscii = await request(app)
      .post('/api/v1/contracts')
      .set(KEY, 'cl\u00e9')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 1 }] });
    expect(nonAscii.status).toBe(400);
    expect(nonAscii.body.error).toBe('invalid_idempotency_key');

    const long = await request(app)
      .post('/api/v1/contracts')
      .set(KEY, tooLong)
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 1 }] });
    expect(long.status).toBe(400);
    expect(long.body.error).toBe('invalid_idempotency_key');
  });

  it('keeps the header optional by default', async () => {
    const app = freshApp();
    const res = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 1 }] });
    expect(res.status).toBe(201);
  });

  it('requires the header when configured', async () => {
    const app = createApp(new EscrowStore().seed(), { idempotencyRequired: true });
    const missing = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 1 }] });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('idempotency_key_required');

    const withKey = await request(app)
      .post('/api/v1/contracts')
      .set(KEY, 'present')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 1 }] });
    expect(withKey.status).toBe(201);
  });

  it('ignores the header on GET', async () => {
    const app = freshApp();
    const res = await request(app).get('/api/v1/contracts').set(KEY, 'get-key');
    expect(res.status).toBe(200);
  });

  it('reports a concurrent duplicate as in progress with Retry-After', async () => {
    // The store's `set` waits on a deferred promise, which holds the first
    // request open so the second genuinely overlaps it.
    const gate = deferred<void>();
    const base = new MemoryIdempotencyStore();
    const slow: IdempotencyStore = {
      get: (key) => base.get(key),
      set: async (key, value) => {
        await gate.promise;
        return base.set(key, value);
      },
      lock: (key) => base.lock(key),
      unlock: (key) => base.unlock(key),
    };
    const app = createApp(new EscrowStore().seed(), { idempotencyStore: slow });
    const body = { client: 'GA', freelancer: 'GB', milestones: [{ amount: 10 }] };

    // Supertest's Test is lazy: it only issues the request once it is awaited or
    // `.then()`-ed. Attaching the handler here is what actually starts request 1
    // and keeps it in flight; assigning the Test without chaining would leave it
    // unstarted and the second request would take the lock instead.
    const first = request(app)
      .post('/api/v1/contracts')
      .set(KEY, 'in-flight')
      .send(body)
      .then((res) => res);

    // Let request 1 reach the route and take the lock.
    await new Promise((r) => setTimeout(r, 60));

    const second = await request(app).post('/api/v1/contracts').set(KEY, 'in-flight').send(body);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('idempotency_request_in_progress');
    expect(second.headers['retry-after']).toBe('1');

    gate.resolve();
    const done = await first;
    expect(done.status).toBe(201);
  });

  it('does not cache a 5xx, so the client can retry', async () => {
    // A route registered on the returned app would land after the 404 catch-all
    // and never match, so the 500 is produced the way a real one would be: an
    // unexpected throw that the app's error handler turns into a 500.
    //
    // `seed()` calls `deposit()` itself, so the failure is armed only after
    // seeding rather than from construction.
    class ExplodingStore extends EscrowStore {
      armed = false;
      deposit(id: number, amount: unknown) {
        if (this.armed) throw new Error('simulated upstream failure');
        return super.deposit(id, amount);
      }
    }

    const calls: string[] = [];
    const base = new MemoryIdempotencyStore();
    const spying: IdempotencyStore = {
      get: (key) => base.get(key),
      set: async (key, value) => {
        calls.push('set');
        return base.set(key, value);
      },
      lock: (key) => base.lock(key),
      unlock: async (key) => {
        calls.push('unlock');
        return base.unlock(key);
      },
    };

    const escrows = new ExplodingStore();
    escrows.seed();
    escrows.armed = true;
    const app = createApp(escrows, { idempotencyStore: spying });

    const res = await request(app)
      .post('/api/v1/contracts/1/deposit')
      .set(KEY, 'boom')
      .send({ amount: 10 });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal_error');
    // The key was released rather than cached, so a retry runs for real.
    expect(calls).toContain('unlock');
    expect(calls).not.toContain('set');
  });
});

describe('MemoryIdempotencyStore', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('expires a record after its TTL', async () => {
    jest.useFakeTimers();
    const store = new MemoryIdempotencyStore({ ttlMs: 1000 });
    await store.set('k', record('fp'));

    jest.advanceTimersByTime(999);
    expect(await store.get('k')).toBeDefined();

    jest.advanceTimersByTime(2);
    expect(await store.get('k')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('evicts the least recently used record at capacity', async () => {
    const store = new MemoryIdempotencyStore({ maxEntries: 2 });
    await store.set('a', record('a'));
    await store.set('b', record('b'));

    // Touch `a` so `b` becomes the least recently used.
    expect(await store.get('a')).toBeDefined();

    await store.set('c', record('c'));

    expect(store.size).toBe(2);
    expect(await store.get('a')).toBeDefined();
    expect(await store.get('b')).toBeUndefined();
    expect(await store.get('c')).toBeDefined();
  });

  it('bounds memory under a flood of unique keys', async () => {
    const store = new MemoryIdempotencyStore({ maxEntries: 50 });
    for (let i = 0; i < 500; i += 1) await store.set(`k${i}`, record(`fp${i}`));
    expect(store.size).toBe(50);
  });

  it('only lets one holder take a lock', async () => {
    const store = new MemoryIdempotencyStore();
    expect(await store.lock('k')).toBe(true);
    expect(await store.lock('k')).toBe(false);
    await store.unlock('k');
    expect(await store.lock('k')).toBe(true);
  });

  it('clears the lock when a record is committed', async () => {
    const store = new MemoryIdempotencyStore();
    await store.lock('k');
    await store.set('k', record('fp'));
    expect(await store.lock('k')).toBe(true);
  });
});

describe('OpenAPI documents the idempotency contract', () => {
  type Operation = {
    parameters?: Array<{ name?: string; in?: string }>;
    responses?: Record<string, unknown>;
  };

  async function postOperations() {
    const spec = (await request(freshApp()).get('/openapi.json')).body;
    return Object.entries(spec.paths as Record<string, Record<string, Operation>>).flatMap(
      ([path, item]) => (item.post ? [[path, item.post] as const] : []),
    );
  }

  it('declares the header and both failures on every POST', async () => {
    const posts = await postOperations();
    // Guards against the assertion below silently passing on an empty list.
    expect(posts.length).toBeGreaterThanOrEqual(7);

    for (const [path, operation] of posts) {
      const headers = (operation.parameters ?? [])
        .filter((p) => p.in === 'header')
        .map((p) => p.name);
      expect({ path, headers }).toEqual({ path, headers: expect.arrayContaining(['Idempotency-Key']) });

      const statuses = Object.keys(operation.responses ?? {});
      expect({ path, statuses }).toEqual({
        path,
        statuses: expect.arrayContaining(['409', '422']),
      });
    }
  });

  it('leaves GET operations untouched', async () => {
    const spec = (await request(freshApp()).get('/openapi.json')).body;
    for (const item of Object.values(spec.paths as Record<string, Record<string, Operation>>)) {
      if (!item.get) continue;
      const headers = (item.get.parameters ?? [])
        .filter((p) => p.in === 'header')
        .map((p) => p.name);
      expect(headers).not.toContain('Idempotency-Key');
    }
  });

  it('still serves a valid OpenAPI 3.0.3 document', async () => {
    const spec = (await request(freshApp()).get('/openapi.json')).body;
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info.title).toBe('TalentTrust API');
    // The shared error body is referenced by the new responses.
    expect(spec.paths['/api/v1/contracts'].post.responses['422'].content['application/json']).toBeDefined();
  });
});

describe('canonicalJson / fingerprint', () => {  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(canonicalJson({ o: { y: 1, x: 2 } })).toBe(canonicalJson({ o: { x: 2, y: 1 } }));
  });

  it('keeps array order significant', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('hashes equal bodies equally and different bodies differently', () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint(undefined)).toBe(fingerprint(null));
  });
});

describe('isValidKey', () => {
  it('accepts 1-255 printable ASCII characters', () => {
    expect(isValidKey('a')).toBe(true);
    expect(isValidKey('x'.repeat(255))).toBe(true);
    expect(isValidKey('key-with_1.punct:tion')).toBe(true);
    // Space is 0x20, inside the printable ASCII range the issue specifies, so
    // it is accepted. An opaque token is free to contain one.
    expect(isValidKey('has space')).toBe(true);
  });

  it('rejects empty, over-long and non-printable keys', () => {
    expect(isValidKey('')).toBe(false);
    expect(isValidKey('x'.repeat(256))).toBe(false);
    expect(isValidKey('has\nnewline')).toBe(false);
    expect(isValidKey('has\ttab')).toBe(false);
    expect(isValidKey('nul\u0000byte')).toBe(false);
    expect(isValidKey('control\u0001byte')).toBe(false);
    expect(isValidKey('non-ascii-cl\u00e9')).toBe(false);
    expect(isValidKey('emoji-\u{1F600}')).toBe(false);
  });
});
