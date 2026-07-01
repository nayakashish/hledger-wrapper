# Architecture

## System Overview

```mermaid
graph TD
    Browser["Phone / Browser\nReact PWA"]
    Worker["Cloudflare Worker\nhledger-worker/src/index.ts"]
    Assets["Workers Assets\nReact SPA (static)"]
    Access["Cloudflare Access\nService token validation"]
    Tunnel["Cloudflare Tunnel\noutbound only — no open ports"]
    FastAPI["FastAPI\nlocalhost:8000"]
    hledger["hledger CLI"]
    Journal["journal.hledger\ngit repository"]

    Browser -->|"HTTPS /api/*"| Worker
    Browser -->|"HTTPS /*"| Assets
    Worker -->|"inject auth headers"| Access
    Access -->|"validated request"| Tunnel
    Tunnel --> FastAPI
    FastAPI --> hledger
    hledger --> Journal
```

---

## Flow 1 — Authentication & First Load

```mermaid
sequenceDiagram
    actor User as User (Browser)
    participant W as Cloudflare Worker
    participant Access as Cloudflare Access
    participant Assets as Workers Assets
    participant API as FastAPI (Home Server)

    User->>W: GET /
    W->>Access: validate CF_Authorization cookie
    Access-->>User: 302 → login (no valid session)
    User->>Access: authenticate (email OTP / OAuth)
    Access-->>User: set CF_Authorization cookie

    User->>W: GET / (with cookie)
    W->>Access: validate cookie
    Access-->>W: authenticated
    W->>Assets: fetch(request)
    Assets-->>User: index.html + hashed JS/CSS bundles

    Note over User: React app boots

    User->>W: GET /api/balance
    W->>W: inject Bearer + CF Access service token headers
    W->>Access: validate service token
    Access-->>W: pass
    W->>API: GET /balance
    API-->>W: {raw: "..."}
    W-->>User: account balances rendered
```

---

## Flow 2 — Sync & Read

```mermaid
sequenceDiagram
    actor User as User (Browser)
    participant W as Cloudflare Worker
    participant API as FastAPI (Home Server)
    participant Git as Git Remote
    participant H as hledger

    User->>W: POST /api/sync
    W->>API: POST /sync (+ auth headers)
    API->>Git: git pull
    Git-->>API: latest commits
    API-->>W: {detail: "ok"}
    W-->>User: sync timestamp shown

    User->>W: GET /api/balance
    W->>API: GET /balance (+ auth headers)
    API->>H: hledger balance --output-format json
    H-->>API: account tree JSON
    API-->>W: {raw: "..."}
    W-->>User: balance view rendered

    User->>W: GET /api/daily-totals?from_date=YYYY-01-01
    W->>API: GET /daily-totals (+ auth headers)
    API->>H: hledger print --output-format json -p YYYY-01-01..today
    H-->>API: transaction list
    API-->>W: [{date, count, total}, ...]
    W-->>User: YTD heatmap rendered
```

---

## Flow 3 — Add Transaction

```mermaid
sequenceDiagram
    actor User as User (Browser)
    participant W as Cloudflare Worker
    participant API as FastAPI (Home Server)
    participant H as hledger
    participant Git as Git Remote

    Note over User: tap + Add, open 7-step form

    User->>W: GET /api/descriptions
    W->>API: GET /descriptions (+ auth headers)
    API->>H: hledger print --output-format json
    H-->>API: recent transactions
    API-->>W: {descriptions: [...]}
    W-->>User: autocomplete list

    User->>W: GET /api/lookup?description=Coffee
    W->>API: GET /lookup (+ auth headers)
    API-->>W: {account1: "expenses:food", account2: "assets:chequing"}
    W-->>User: pre-filled accounts

    Note over User: review preview, tap Submit

    User->>W: POST /api/add {date, description, postings}
    W->>API: POST /add (+ auth headers)
    API->>API: append entry to journal.hledger
    API->>Git: git commit + git push
    Git-->>API: ok
    API-->>W: {ok: true}
    W-->>User: confirmation toast shown
```

---

## Authentication Layers

| Layer | Mechanism | Protects |
|-------|-----------|----------|
| Cloudflare Access | Service token (Client ID + Secret headers) | Blocks requests not originating from the Worker |
| FastAPI Bearer token | `Authorization: Bearer ...` | Second layer if Access is bypassed |

Neither token ever reaches the browser — both are injected by the Worker from its secret store (`wrangler secret put`).

---

## Frontend State

All state lives in `App.tsx` and is prop-drilled. No Redux or Context beyond `PrivacyContext` (an in-memory boolean). At the current scale (~20 components) this is intentional.

### Caching Strategy

| Data | Where cached | TTL |
|------|-------------|-----|
| Balance / Monthly / Transactions | `localStorage` (`hledger_cache`) | Until next sync |
| Envelope data | `localStorage` (`hledger_envelopes_v3`) | Until next sync |
| Last sync time | `localStorage` (`hledger_last_sync`) | Displayed in header |
| Account / description lists | `localStorage` | Until next sync |
| Monthly drilldown transactions | Component state | Until page reload |
| Dashboard heatmap | Component state | Until page reload |

---

## Privacy Toggle

The eye icon in the header toggles `privacyMode` in `PrivacyContext`. Resets on page reload — never persisted.

**Masked** (rendered as `••••` via `<MaskedAmount>`):
- Net worth, assets, liabilities in summary cards
- Envelope balances and totals
- Income transaction amounts (posting account starts with `income`)
- Income row amounts in the Monthly report

**Never masked:**
- Expense amounts
- Account names, dates, descriptions
- Dashboard charts (aggregate trend data)

---

## Journal Git Flow

```mermaid
sequenceDiagram
    participant Dev as Developer (Mac)
    participant Remote as Git Remote
    participant Server as Home Server

    Dev->>Remote: git push (journal edits)
    Note over Server: user taps Sync in app
    Server->>Remote: git pull (/sync endpoint)
    Remote-->>Server: latest commits

    Note over Server: user adds transaction in app
    Server->>Remote: git commit + git push (/add endpoint)
    Remote-->>Dev: available on next pull
```

---

## systemd Services (Home Server)

Two services run permanently:

**FastAPI** (`/etc/systemd/system/hledger-api.service`):
```ini
[Unit]
Description=hledger FastAPI
After=network.target

[Service]
User=<user>
WorkingDirectory=/path/to/hledger-wrapper/api
EnvironmentFile=/path/to/hledger-wrapper/api/.env
ExecStart=/path/to/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

**Cloudflare Tunnel** — managed by `cloudflared service install` after authenticating.

---

## Build & Deploy

```bash
cd hledger-worker
npm run deploy   # vite build → dist/client/ then wrangler deploy
```

After changing `wrangler.jsonc` bindings: `npm run cf-typegen` to regenerate `worker-configuration.d.ts`.
