# Deployment Guide

Full setup guide for running hledger Mobile from scratch.

## Prerequisites

- A Linux machine running 24/7 (home server, VPS, etc.)
- [hledger](https://hledger.org/install.html) installed on the server
- A hledger journal file in a git repository
- A Cloudflare account (free tier is sufficient)
- A domain managed by Cloudflare DNS
- Node.js 18+ on your dev machine

---

## 1. Home server — FastAPI

### Clone and install

```bash
git clone <your-repo-url> ~/hledger-wrapper
cd ~/hledger-wrapper/api
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Configure

```bash
cp env.example .env
```

Edit `.env`:

```ini
# Journal location (both point inside your journal git repo)
JOURNAL_DIR=/path/to/journal-repo                 # directory containing the journal
JOURNAL_FILE=/path/to/journal-repo/main.journal   # the journal file itself

# Optional: a chart-of-accounts journal of `account` directives. When set,
# /accounts serves declared accounts instead of accounts used in the journal.
ACCOUNTS_FILE=/path/to/journal-repo/accounts.journal

# API auth — a strong random secret; generate with: openssl rand -hex 32
BEARER_TOKEN=<strong-random-string>

# Currency symbol used in your journal
DEFAULT_CURRENCY=$

# hledger binary (only needed if it is not on PATH)
HLEDGER_BIN=/usr/local/bin/hledger

# Feature data files — plain JSON, committed to the journal repo like the
# journal itself. Point each at a path inside the repo; the loaders create
# the default keys on first write.
ENVELOPE_DATA_FILE=/path/to/journal-repo/envelopes.json   # see docs/envelopes.md
INBOX_DATA_FILE=/path/to/journal-repo/inbox.json          # see docs/transaction-inbox.md
```

`ENVELOPE_DATA_FILE` and `INBOX_DATA_FILE` are optional — leave them unset to
run without the Envelopes or Transaction Inbox features. When unset, those
endpoints return `503` and the rest of the app is unaffected.

### Verify locally

```bash
source venv/bin/activate
uvicorn main:app --host 127.0.0.1 --port 8000 --env-file .env
```

```bash
# Health check (no auth required)
curl http://localhost:8000/health
# → {"status":"ok"}

# Balance (auth required)
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8000/balance
```

### Install as a systemd service

```bash
sudo cp ~/hledger-wrapper/api/hledger-api.service /etc/systemd/system/
# Edit the service file to set your username and correct paths
sudo systemctl daemon-reload
sudo systemctl enable hledger-api
sudo systemctl start hledger-api
sudo systemctl status hledger-api
```

Logs:
```bash
journalctl -u hledger-api -f
```

---

## 2. Cloudflare Tunnel

The tunnel exposes the FastAPI app to the internet without opening any inbound ports on your server.

```bash
# Install cloudflared on the server
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Authenticate
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create hledger

# Route a subdomain to the tunnel
cloudflared tunnel route dns hledger api.yourdomain.com

# Install as a systemd service
cloudflared service install
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <your-tunnel-id>
credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: api.yourdomain.com
    service: http://localhost:8000
  - service: http_status:404
```

```bash
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

Verify: `curl https://api.yourdomain.com/health` should return `{"status":"ok"}`.

---

## 3. Cloudflare Access

Access sits in front of the tunnel URL and blocks unauthenticated requests before they reach the server.

In the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/):

1. **Applications → Add an application → Self-hosted**
   - Application name: hledger API
   - Domain: `api.yourdomain.com`
   - Session duration: 24 hours (or longer)

2. **Add a policy** — allow your email address via One-time PIN or your identity provider

3. **Service Tokens → Create service token**
   - Name: hledger-worker
   - Copy the **Client ID** and **Client Secret** — you will only see the secret once

4. **Add a second policy** on the same application:
   - Action: Service Auth
   - Rule: Service Token → hledger-worker

This allows the Cloudflare Worker to call the API using the service token, bypassing the browser login flow.

---

## 4. Cloudflare Worker — secrets

```bash
cd hledger-worker
npm install

wrangler secret put API_BASE_URL
# → https://api.yourdomain.com

wrangler secret put BEARER_TOKEN
# → same value as BEARER_TOKEN in your .env

wrangler secret put CF_ACCESS_CLIENT_ID
# → Client ID from step 3

wrangler secret put CF_ACCESS_CLIENT_SECRET
# → Client Secret from step 3
```

---

## 5. Deploy

```bash
cd hledger-worker
npm run deploy
# runs: vite build && wrangler deploy
```

The worker is deployed to `<worker-name>.<your-subdomain>.workers.dev` by default. To use a custom domain, configure a Worker Route in the Cloudflare dashboard.

---

## 6. Verify end-to-end

1. Open the Worker URL in a browser
2. You should see the React app load
3. Tap **Sync** — the button should spin and display a timestamp
4. Tap **Balance** in the Reports tab — your account tree should appear
5. Install as a PWA via "Add to Home Screen" on iOS/Android

---

## Local development

```bash
cd hledger-worker
npm run dev
# Vite dev server on http://localhost:5173
# Worker runs via @cloudflare/vite-plugin
```

Create `hledger-worker/.dev.vars` with the same secrets:

```ini
API_BASE_URL=https://api.yourdomain.com
BEARER_TOKEN=your-token
CF_ACCESS_CLIENT_ID=your-client-id
CF_ACCESS_CLIENT_SECRET=your-client-secret
```

After changing bindings in `wrangler.jsonc`:

```bash
npm run cf-typegen   # regenerates worker-configuration.d.ts
```

---

## API reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (no auth) |
| `POST` | `/sync` | `git pull` + reload |
| `GET` | `/balance` | All account balances |
| `GET` | `/is` | Income statement |
| `GET` | `/monthly` | Monthly breakdown (depth 2) |
| `GET` | `/transactions` | `?month=YYYY-MM` |
| `GET` | `/search` | `?q=<query>` full-text |
| `GET` | `/daily-totals` | `?from_date=YYYY-MM-DD` — YTD activity for heatmap |
| `POST` | `/add` | Append transaction, commit, push |
| `GET` | `/accounts` | Account list (autocomplete) |
| `GET` | `/descriptions` | Recent descriptions (autocomplete) |
| `GET` | `/lookup` | `?description=<text>` — predicted postings |
| `GET` | `/envelopes` | Envelope balances + pending |
| `POST` | `/envelopes/scan` | Scan for unassigned transactions |
| `POST` | `/envelopes/assign` | Assign transaction to envelope(s) |
| `POST` | `/envelopes/transfer` | Transfer between envelopes |
| `POST` | `/envelopes/adjust` | Manual balance adjustment |
| `POST` | `/envelopes/dismiss` | Dismiss pending transaction |
| `POST` | `/envelopes/create` | Create envelope |
| `DELETE` | `/envelopes/<id>` | Delete envelope |

The Transaction Inbox endpoints (`/inbox/...`) are documented in
[transaction-inbox.md](transaction-inbox.md); the envelope endpoints are
covered in depth in [envelopes.md](envelopes.md).

See the [documentation index](README.md) for the full set of reference
documents.
