# TalentTrust Backend

## Live

- Website: https://talenttrust-frontend.vercel.app
- Docs: https://talenttrust-frontend.vercel.app/docs
- API: https://talenttrust-backend.vercel.app
- API docs (Swagger UI): https://talenttrust-backend.vercel.app/docs
- Contract (Stellar testnet): [`CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W`](https://stellar.expert/explorer/testnet/contract/CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W)

Express + TypeScript API for TalentTrust, a milestone-based freelancer escrow protocol on Stellar.
The API mirrors the state machine of the Soroban escrow contract
([Talenttrust-Contracts](https://github.com/Talenttrust/Talenttrust-Contracts)) so clients and
freelancers can create engagements, fund escrow, release milestones, raise disputes and build reputation.

Storage is in-memory (seeded with demo data), so no database is required. On serverless hosting the
data is per-instance and resets on redeploy.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Service info and endpoint list (JSON) |
| GET | `/health` | Health check |
| GET | `/docs` | Swagger UI |
| GET | `/openapi.json` | OpenAPI 3 spec |
| GET | `/api/v1/chain` | On-chain contract deployment info |
| GET | `/api/v1/stats` | Aggregate statistics |
| GET/POST | `/api/v1/contracts` | List (`?status=`, `?party=`) / create escrow contracts |
| GET | `/api/v1/contracts/:id` | Get a contract |
| POST | `/api/v1/contracts/:id/deposit` | `{ "amount": 100 }` |
| POST | `/api/v1/contracts/:id/milestones/:index/release` | Release a milestone |
| POST | `/api/v1/contracts/:id/dispute` | `{ "raisedBy": "G...", "reason": "..." }` |
| POST | `/api/v1/contracts/:id/resolve` | `{ "freelancerBps": 5000 }` |
| POST | `/api/v1/contracts/:id/cancel` | Cancel and refund |
| POST | `/api/v1/contracts/:id/reputation` | `{ "rating": 5 }` |
| GET | `/api/v1/reputation/:address` | Freelancer reputation |

### Retry safety

Every `POST` accepts an optional `Idempotency-Key` header (1–255 printable ASCII characters). Sending
the same key with the same body returns the original response with `Idempotent-Replayed: true`
instead of applying the mutation twice — so a wallet or mobile client that retries after a timeout
does not double-deposit or create a duplicate escrow.

| Situation | Response |
| --- | --- |
| No header | Current behaviour (unless `IDEMPOTENCY_REQUIRED=true`) |
| Malformed key | `400 invalid_idempotency_key` |
| Same key, same body, already completed | Original status and body + `Idempotent-Replayed: true` |
| Same key, **different** body | `422 idempotency_key_reused` |
| Same key, first request still running | `409 idempotency_request_in_progress` + `Retry-After: 1` |
| First attempt returned 5xx | Not cached; the key is released so the retry runs for real |

Records live in memory for 24 hours (10 000 entries max, LRU eviction) and reset on redeploy. The
store is an async interface, so a shared adapter can replace it without touching the middleware.
See [docs/backend/idempotency.md](docs/backend/idempotency.md).

## Development

```bash
npm ci
npm run dev      # http://localhost:3001
npm run lint     # type check
npm test
npm run build && npm start
```

Configuration (all optional, see `.env.example`): `PORT`, `ESCROW_CONTRACT_ID`, `STELLAR_NETWORK`,
`STELLAR_RPC_URL`, `FRONTEND_URL`, `IDEMPOTENCY_REQUIRED`.

`IDEMPOTENCY_REQUIRED=true` makes `Idempotency-Key` mandatory on every `POST`; a request without it
is rejected with `400 idempotency_key_required`. Defaults to `false`, which keeps the header optional.

## Deployment

Deployed on Vercel as a serverless function: `api/index.ts` exports the Express app and
`vercel.json` rewrites every path to it. `src/index.ts` only calls `listen()` when run directly.

```bash
vercel deploy --prod
```

## License

MIT
