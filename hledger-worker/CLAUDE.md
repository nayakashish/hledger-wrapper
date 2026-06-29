# hledger Worker — Developer Reference

## What This Is

A personal finance PWA that acts as a secure mobile interface to an hledger instance running on a home server. The app:

- Proxies API requests through Cloudflare to a home Linux machine running FastAPI + hledger
- Injects auth secrets server-side (secrets never reach the browser)
- Serves a React SPA as the frontend
- Supports a demo mode backed by KV-stored mock data

## Architecture

```
Browser (React SPA)
       |
Cloudflare Worker (hledger-worker)
       |-- /api/*           → proxy to FastAPI on home server via CF Tunnel
       |-- /api/demo/*      → serve mock data from KV namespace (DEMO_DATA)
       |-- everything else  → Workers Assets (built React app)
```

**Cloudflare secrets** (set via `wrangler secret put`, never committed):
- `API_BASE_URL` — e.g. `https://hledger-api.nayakashish.cc`
- `BEARER_TOKEN` — FastAPI auth token
- `CF_ACCESS_CLIENT_ID` — Cloudflare Access service token ID
- `CF_ACCESS_CLIENT_SECRET` — Cloudflare Access service token secret

**KV namespace**: `DEMO_DATA` — stores mock data for demo mode (balance, is, monthly, transactions, accounts, descriptions).

**Demo PIN**: hardcoded in `src/index.ts` as `DEMO_PIN`. Anyone with repo access can see it — that is intentional. The pin gate keeps casual users out of real data, not adversarial attackers.

## Project Layout

```
hledger-worker/
├── CLAUDE.md              ← you are here
├── index.html             ← Vite root (mounts React at #root)
├── vite.config.ts         ← Vite + Cloudflare Vite plugin
├── wrangler.jsonc         ← Worker config + KV + Assets binding
├── tsconfig.json          ← TypeScript config
├── package.json
├── public/                ← static assets copied as-is to dist/client
│   ├── manifest.json      ← PWA manifest
│   ├── sw.js              ← service worker
│   └── *.png              ← app icons
└── src/
    ├── index.ts           ← Worker entry (API proxy + demo handler)
    └── frontend/          ← React SPA
        ├── main.tsx
        ├── App.tsx
        ├── types.ts
        ├── styles/
        │   └── global.css
        ├── utils/
        │   ├── format.ts  ← fmtAmount, amountClass, extractAmount
        │   └── api.ts     ← fetch helpers (apiGet, envFetch, etc.)
        ├── hooks/
        │   └── useSheetSwipe.ts
        └── components/
            ├── Header.tsx
            ├── Nav.tsx
            ├── SummaryCards.tsx
            ├── Toast.tsx
            ├── Banners.tsx
            ├── views/
            │   ├── BalanceView.tsx
            │   ├── MonthlyView.tsx
            │   ├── TransactionsView.tsx
            │   └── EnvelopesView.tsx
            ├── sheets/
            │   ├── AddSheet.tsx
            │   ├── DetailSheet.tsx   ← shared bottom sheet (txn + env detail)
            │   └── AssignSheet.tsx
            └── modals/
                └── PinModal.tsx
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
- **Demo mode**: The demo PIN lives only in the Worker (`src/index.ts`). It is never sent to the browser.
- **Authentication**: The Worker injects `Authorization`, `CF-Access-Client-Id`, and `CF-Access-Client-Secret` headers server-side. The browser only ever sees `/api/*` URLs with no auth headers.
- Keep `wrangler.jsonc` KV IDs in source (they are not secrets), but keep the `kv_namespaces` remote IDs private enough — they are scoped to this Cloudflare account.

## Key API Endpoints (served by FastAPI on home server)

| Path | Method | Description |
|------|--------|-------------|
| `/api/sync` | POST | Git pull + rebuild hledger data |
| `/api/balance` | GET | Account balances (JSON) |
| `/api/is` | GET | Income statement |
| `/api/monthly` | GET | Monthly breakdown |
| `/api/transactions` | GET | `?month=YYYY-MM` |
| `/api/search` | GET | `?q=<query>` full-text search |
| `/api/add` | POST | Append transaction to journal |
| `/api/accounts` | GET | List of account names |
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

## Coding Standards

- TypeScript strict mode throughout.
- React functional components with hooks only.
- No `dangerouslySetInnerHTML` — use JSX.
- Keep Worker logic in `src/index.ts`. Keep UI logic in `src/frontend/`.
- CSS lives in `src/frontend/styles/global.css` using the same class names as the original design.
- Commits early and often; branches for significant changes.
- No `console.log` in production code.
