# hledger Worker — Developer Reference

## What This Is

A personal finance PWA that acts as a secure mobile interface to an hledger instance running on a home server. The app:

- Proxies API requests through Cloudflare to a home Linux machine running FastAPI + hledger
- Injects auth secrets server-side (secrets never reach the browser)
- Serves a React SPA as the frontend
- Receives bank alert emails via Cloudflare Email Routing and stages them as pending transactions (the Transaction Inbox — see `docs/transaction-inbox.md`)

## Architecture

```
Browser (React SPA)
       |
Cloudflare Worker (hledger-worker)
       |-- fetch: /api/*         → proxy to FastAPI on home server via CF Tunnel
       |-- fetch: everything else → Workers Assets (built React app)
       |-- email: txn-alerts@    → parse bank alert, POST /inbox/ingest to FastAPI
```

**Cloudflare secrets** (set via `wrangler secret put`, never committed):
- `API_BASE_URL` — e.g. `https://hledger-api.nayakashish.cc`
- `BEARER_TOKEN` — FastAPI auth token
- `CF_ACCESS_CLIENT_ID` — Cloudflare Access service token ID
- `CF_ACCESS_CLIENT_SECRET` — Cloudflare Access service token secret

**Vars** (in `wrangler.jsonc`, not secret):
- `FORWARD_VERIFICATION_EMAIL` — where the email handler forwards Gmail's forwarding-confirmation emails; also the trusted sender for manually forwarded alerts.

## Project Layout

```
hledger-worker/
├── CLAUDE.md              ← you are here
├── index.html             ← Vite root (mounts React at #root)
├── vite.config.ts         ← Vite + Cloudflare Vite plugin
├── wrangler.jsonc         ← Worker config + vars + Assets binding
├── tsconfig.json          ← TypeScript config
├── package.json
├── public/                ← static assets copied as-is to dist/client
│   ├── manifest.json      ← PWA manifest
│   ├── sw.js              ← service worker
│   └── *.png              ← app icons
└── src/
    ├── index.ts           ← Worker entry (API proxy + email handler)
    └── frontend/          ← React SPA
        ├── main.tsx
        ├── App.tsx
        ├── types.ts
        ├── styles/
        │   └── global.css
        ├── context/
        │   └── PrivacyContext.tsx
        ├── utils/
        │   ├── format.ts  ← fmtAmount, amountClass, extractAmount
        │   └── api.ts     ← fetch helpers (apiGet, apiPost, apiDelete, loadRawEndpoint)
        ├── hooks/
        │   └── useSheetSwipe.ts
        └── components/
            ├── Header.tsx        ← title + inbox icon + privacy toggle
            ├── Nav.tsx
            ├── SummaryCards.tsx
            ├── SyncRow.tsx
            ├── VerseCard.tsx
            ├── MaskedAmount.tsx
            ├── Toast.tsx
            ├── Banners.tsx
            ├── views/
            │   ├── DashboardView.tsx
            │   ├── ReportsView.tsx  (wraps BalanceView + MonthlyView + CoAView)
            │   ├── BalanceView.tsx
            │   ├── MonthlyView.tsx
            │   ├── CoAView.tsx      (chart of accounts tree)
            │   ├── TransactionsView.tsx
            │   └── EnvelopesView.tsx
            └── sheets/
                ├── AddSheet.tsx
                ├── DetailSheet.tsx   ← shared bottom sheet (txn + env detail)
                ├── AssignSheet.tsx
                └── InboxSheet.tsx    ← transaction inbox review (list + review)
```

## Development

```bash
npm install
npm run dev          # Vite dev server (port 5173) + Worker via CF Vite plugin
```

For wrangler dev without Vite (Worker only):
```bash
npx wrangler dev
```

## Build and Deploy

```bash
npm run build        # vite build → dist/client/
wrangler deploy      # deploy Worker + Workers Assets
```

After changing bindings in `wrangler.jsonc`:
```bash
npm run cf-typegen   # regenerates worker-configuration.d.ts
```

## Security Standards

- **No secrets in code or committed files.** All secrets go through `wrangler secret put`.
- **React JSX** provides automatic XSS protection (no manual escaping needed, unlike the old `escHtml`).
- **CORS**: The Worker adds `Access-Control-Allow-Origin: *` on API responses only. Static assets are served by Workers Assets.
- **Authentication**: The Worker injects `Authorization`, `CF-Access-Client-Id`, and `CF-Access-Client-Secret` headers server-side. The browser only ever sees `/api/*` URLs with no auth headers.
- **Inbound email**: the email handler only acts on senders it recognizes (bank domains, Google's forwarding verification, the owner's own address for manual forwards); everything else is dropped. Ingested alerts can only create pending inbox items — nothing reaches the journal without a user action in the app.

## Key API Endpoints (served by FastAPI on home server)

The backend lives in `../api/` (a package under `api/app/`, split by domain
into config/auth/hledger/git_ops/storage/models plus one router per area, with
an atomic git-write wrapper for every mutating endpoint). See `api/README.md`
for the package layout and how to run its pytest suite; the routes below are
unchanged by that structure.

| Path | Method | Description |
|------|--------|-------------|
| `/api/sync` | POST | Git pull + rebuild hledger data |
| `/api/balance` | GET | Account balances (JSON) |
| `/api/is` | GET | Income statement |
| `/api/monthly` | GET | Monthly breakdown |
| `/api/transactions` | GET | `?month=YYYY-MM` |
| `/api/search` | GET | `?q=<query>` full-text search |
| `/api/add` | POST | Append transaction to journal |
| `/api/accounts` | GET | Chart of accounts — declared accounts from the CoA journal when `ACCOUNTS_FILE` is set in the server `.env`, else accounts used in the journal |
| `/api/descriptions` | GET | List of recent descriptions |
| `/api/lookup` | GET | `?description=<text>` predicted postings |
| `/api/envelopes` | GET | Envelope balances + pending txns |
| `/api/envelopes/scan` | POST | Scan for new transactions |
| `/api/envelopes/assign` | POST | Assign transaction to envelope(s) |
| `/api/envelopes/transfer` | POST | Transfer between envelopes |
| `/api/envelopes/adjust` | POST | Manual balance adjustment |
| `/api/envelopes/dismiss` | POST | Dismiss a pending transaction |
| `/api/envelopes/create` | POST | Create a new envelope |
| `/api/envelopes/<id>` | DELETE | Delete an envelope |
| `/api/monthly-detail` | GET | Monthly breakdown with transaction drilldown |
| `/api/daily-totals` | GET | `?from_date=YYYY-MM-DD` per-day counts/totals (heatmap) |
| `/api/inbox` | GET | Pending inbox items + live journal match |
| `/api/inbox/count` | GET | Pending count (header icon) |
| `/api/inbox/ingest` | POST | Stage a bank alert (called by the email handler) |
| `/api/inbox/post` | POST | Post an inbox item to the journal |
| `/api/inbox/dismiss` | POST | Delete an inbox item without posting |
| `/api/inbox/rule` | POST | Save/replace a merchant rule ("Remember merchant") |

The Transaction Inbox (email pipeline, suggestion engine, dedup) is documented in depth in `docs/transaction-inbox.md`.

## Coding Standards

- TypeScript strict mode throughout.
- React functional components with hooks only.
- No `dangerouslySetInnerHTML` — use JSX.
- Keep Worker logic in `src/index.ts`. Keep UI logic in `src/frontend/`.
- CSS lives in `src/frontend/styles/global.css` using the same class names as the original design.
- Commits early and often; branches for significant changes.
- No `console.log` in production code.
- Use feat, style, chore, etc for commit prefixes.
