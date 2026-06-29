# Architecture

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Phone / Browser                                                │
│                                                                 │
│  React PWA (Workers Assets)                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Dashboard │ Envelopes │ Transactions │ Reports          │   │
│  │  Add Sheet │ Detail Sheet │ Assign Sheet                 │   │
│  │  Privacy toggle (in-memory, income + balances only)      │   │
│  └─────────────────────────────────────────────────────────┘   │
└────────────────────────┬────────────────────────────────────────┘
                         │  HTTPS  /api/*
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Cloudflare Edge                                                │
│                                                                 │
│  Cloudflare Worker  (hledger-worker/src/index.ts)              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  /api/* → inject auth headers → forward to tunnel       │   │
│  │  /*     → Workers Assets (React SPA)                    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Worker secrets (never reach browser):                         │
│    API_BASE_URL, BEARER_TOKEN,                                  │
│    CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET                 │
└────────────────────────┬────────────────────────────────────────┘
                         │  Cloudflare Tunnel (outbound only)
                         │  No open inbound ports on home server
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Home Linux Server                                              │
│                                                                 │
│  cloudflared daemon  ──→  FastAPI (localhost:8000)             │
│                              │                                  │
│                              ▼                                  │
│                           hledger CLI                           │
│                              │                                  │
│                              ▼                                  │
│                        journal.hledger  (git repo)             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Request flow

1. Browser fetches `/api/balance`
2. Cloudflare Worker intercepts — path starts with `/api/`
3. Worker builds a new request to `$API_BASE_URL/balance` with:
   - `Authorization: Bearer $BEARER_TOKEN`
   - `CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID`
   - `CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET`
4. Cloudflare Tunnel receives the request at the home server
5. Cloudflare Access validates the service token headers
6. FastAPI receives the request, validates the Bearer token, runs `hledger balance --output-format json`, returns JSON
7. Worker forwards the response body to the browser

---

## Authentication layers

| Layer | Mechanism | Protects |
|-------|-----------|----------|
| Cloudflare Access | Service token (Client ID + Secret headers) | Blocks requests that don't come from the Worker |
| FastAPI Bearer token | `Authorization: Bearer ...` header | Second layer if Access is bypassed |

Neither token ever reaches the browser — both are injected by the Worker from its secret store.

---

## Frontend state management

All state lives in `App.tsx` and is prop-drilled down. No Redux or Context beyond `PrivacyContext` (which only holds a boolean). At the current scale (~20 components) this is intentional — adding a state library would be premature.

### Caching strategy

| Data | Where cached | TTL |
|------|-------------|-----|
| Balance / Monthly / Transactions | `localStorage` (`hledger_cache`) | Until next sync |
| Envelope data | `localStorage` (`hledger_envelopes_v3`) | Until next sync |
| Last sync time | `localStorage` (`hledger_last_sync`) | Displayed in header |
| Account / description lists | `localStorage` | Until next sync |
| Monthly drilldown transactions | Component state | Until page reload |
| Dashboard heatmap | Component state | Until page reload |

---

## Privacy toggle

The eye icon in the header toggles `privacyMode` in `PrivacyContext`. This is an in-memory state — it resets on page reload.

**What is masked** (replaced with `••••` via `<MaskedAmount>`):
- Net worth, assets, liabilities in the summary cards
- All envelope balances and totals
- Income transaction amounts in the transaction list (posting account starts with `income`)
- Income row amounts in the Monthly report

**What is never masked:**
- Expense amounts
- Account names, dates, descriptions
- Charts on the Dashboard (aggregate trend data, not specific amounts)

---

## Journal git flow

```
Your Mac  ──git push──▶  Remote repo  ──git pull (on /sync)──▶  Home server
                                                                      │
              ◀──git push (after /add)────────────────────────────────┘
```

The home server never initiates outbound connections except `cloudflared` (to Cloudflare) and `git push`/`git pull` (to the remote). All other traffic is inbound-only via the tunnel.

---

## systemd services on home server

Two services need to run permanently:

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

**Cloudflare Tunnel** is managed by `cloudflared service install` after authenticating.

---

## Build and deploy

```bash
cd hledger-worker
npm run build    # vite build → dist/client/ (React) + dist/hledger_worker/ (Worker)
wrangler deploy  # uploads Worker bundle + Workers Assets
```

Or in one step: `npm run deploy`

After changing `wrangler.jsonc` bindings: `npm run cf-typegen` to regenerate `worker-configuration.d.ts`.
