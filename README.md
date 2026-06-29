# hledger Mobile

A self-hosted, privacy-first mobile PWA for [hledger](https://hledger.org/). Checks balances, adds transactions, and views spending from any phone — without any financial data leaving the home server.

---

## Architecture

```
Phone / Browser (React PWA)
        │
        │  HTTPS
        ▼
Cloudflare Worker  (hledger-worker/)
        │── /api/*          → proxy to FastAPI, injects auth secrets server-side
        │── everything else → Workers Assets (built React SPA)
        │
        │  Cloudflare Tunnel (zero open ports)
        ▼
Linux machine  (always-on home server)
        │── FastAPI  (api/main.py)
        │── hledger  (reads journal.hledger)
        └── cloudflared daemon
```

Auth secrets (`BEARER_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`) live as Cloudflare Worker secrets — they are injected server-side and never reach the browser.

See [`docs/architecture.md`](docs/architecture.md) for a detailed breakdown.

---

## Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, Vite 6, TypeScript |
| Charts | Recharts |
| Edge runtime | Cloudflare Workers + Workers Assets |
| API server | FastAPI + uvicorn (Python) |
| Accounting engine | hledger |
| Journal storage | Plain-text `.hledger` file in git |
| Tunnel | Cloudflare Tunnel (cloudflared) |
| Auth gate | Cloudflare Access (service token) |

---

## Features

- **Dashboard** — 365-day activity heatmap (tap a day to see transactions), profit/loss bar chart, spending vs prior period, net worth trend line
- **Envelopes** — virtual envelope budgeting layered over hledger; assign income and expenses per envelope, transfer between envelopes, scan for new transactions
- **Transactions** — month picker + full-text search; tap any transaction to expand postings and raw journal entry
- **Reports** — Balance tree and Monthly breakdown (depth-2 by default, tap a row to drill into transactions for that account/month)
- **Add Transaction** — 7-step guided form with account autocomplete, description lookup, and editable preview
- **Privacy toggle** — eye icon in header masks income amounts, net worth, and envelope balances in-memory (no persistence)
- **PWA** — installable on iOS/Android via "Add to Home Screen", works offline from cache

---

## Project Layout

```
hledger-wrapper/
├── api/
│   └── main.py             ← FastAPI app (hledger wrapper)
├── hledger-worker/
│   ├── CLAUDE.md           ← developer reference (AI-readable)
│   ├── wrangler.jsonc      ← Cloudflare Worker config
│   ├── vite.config.ts
│   ├── index.html          ← Vite entry point
│   ├── public/             ← PWA manifest, icons, service worker
│   └── src/
│       ├── index.ts        ← Worker entry (API proxy + Assets fallback)
│       └── frontend/       ← React SPA
│           ├── App.tsx
│           ├── types.ts
│           ├── context/    ← PrivacyContext
│           ├── utils/      ← format.ts, api.ts
│           ├── hooks/      ← useSheetSwipe
│           ├── components/ ← shared: Header, Nav, MaskedAmount, Toast, …
│           │   ├── views/  ← DashboardView, EnvelopesView, TransactionsView, ReportsView
│           │   ├── sheets/ ← AddSheet, DetailSheet, AssignSheet
│           │   └── modals/ ← (empty — PinModal removed with demo mode)
│           └── styles/
│               └── global.css
└── docs/
    └── architecture.md
```

---

## API Endpoints

All endpoints are authenticated via Bearer token. The Worker injects the token server-side.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/sync` | `git pull` + rebuild hledger data |
| `GET` | `/balance` | Account balances (JSON) |
| `GET` | `/is` | Income statement |
| `GET` | `/monthly` | Monthly breakdown at depth 2 |
| `GET` | `/transactions` | `?month=YYYY-MM` — transactions for a month |
| `GET` | `/search` | `?q=<query>` — full-text search |
| `GET` | `/daily-totals` | `[{date, count, total}]` for trailing 365 days (heatmap) |
| `POST` | `/add` | Append transaction to journal, commit, push |
| `GET` | `/accounts` | Account name list (autocomplete) |
| `GET` | `/descriptions` | Recent description list (autocomplete) |
| `GET` | `/lookup` | `?description=<text>` — predicted postings |
| `GET` | `/envelopes` | Envelope balances + pending transactions |
| `POST` | `/envelopes/scan` | Scan for new unassigned transactions |
| `POST` | `/envelopes/assign` | Assign transaction to envelope(s) |
| `POST` | `/envelopes/transfer` | Transfer between envelopes |
| `POST` | `/envelopes/adjust` | Manual balance adjustment |
| `POST` | `/envelopes/dismiss` | Dismiss a pending transaction |
| `POST` | `/envelopes/create` | Create a new envelope |
| `DELETE` | `/envelopes/<id>` | Delete an envelope |
| `GET` | `/health` | Health check (no auth) |

---

## Setup

### 1. Home server (Linux)

```bash
# Install hledger (https://hledger.org/install.html)
# Install Python deps
cd api && pip install -r requirements.txt
# Set environment variables
export JOURNAL_DIR=/path/to/journal-repo
export API_TOKEN=<your-bearer-token>
# Run
uvicorn main:app --host 127.0.0.1 --port 8000
```

Configure as a `systemd` service so it starts on boot and restarts on crash (see `docs/architecture.md`).

### 2. Cloudflare Tunnel

```bash
cloudflared tunnel create hledger
cloudflared tunnel route dns hledger api.yourdomain.com
# Run cloudflared as a systemd service pointing to localhost:8000
```

### 3. Cloudflare Access

In the Cloudflare Zero Trust dashboard:
- Create an Access application protecting `api.yourdomain.com`
- Create a service token; note the Client ID and Secret

### 4. Worker secrets

```bash
cd hledger-worker
wrangler secret put API_BASE_URL        # e.g. https://api.yourdomain.com
wrangler secret put BEARER_TOKEN
wrangler secret put CF_ACCESS_CLIENT_ID
wrangler secret put CF_ACCESS_CLIENT_SECRET
```

### 5. Deploy

```bash
cd hledger-worker
npm install
npm run deploy   # runs vite build && wrangler deploy
```

---

## Development

```bash
cd hledger-worker
npm run dev      # Vite dev server + Worker via @cloudflare/vite-plugin
```

The dev server proxies `/api/*` to a local Wrangler instance. You will need a `.dev.vars` file with the secrets for local testing.

---

## Security notes

- No secrets in code or committed files — all secrets go through `wrangler secret put`
- Auth headers are injected by the Worker; the browser never sees them
- React JSX provides automatic XSS protection (no manual escaping)
- Privacy toggle is in-memory only and resets on page reload — it is a screen-share convenience, not a security boundary
