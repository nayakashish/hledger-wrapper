# hledger Mobile Access

A self-hosted, privacy-first mobile interface for [hledger](https://hledger.org/) — built as a personal finance tool and portfolio project.

---

## Project Background

[hledger](https://hledger.org/) is a plain-text, double-entry accounting tool that runs on the command line. It is fast, reliable, and keeps financial data in a simple text file that lives in a git repository. The problem it does not solve is mobile access — it is a terminal tool, and there is no good way to check your balances or add a transaction from your phone without being at your computer.

This project solves that by building a secure, self-hosted API layer around hledger, exposed to the internet via Cloudflare Tunnel, with a mobile-friendly Single Page Application served through Cloudflare Workers. The journal file never leaves the home server. No financial data is stored in any cloud service.

This is a fully functional personal finance tool, not a demo. It is designed to run 24/7 on a home Linux machine and be accessed from any device.

---

## Guiding Principles

- **Data stays local.** The journal file never leaves the home Linux machine. Only query results (JSON) travel over the network.
- **Git-agnostic sync.** The journal lives in a git repository. Where that repository is hosted — GitHub, GitLab, a self-hosted bare repo, or anywhere else — does not affect the architecture. The API layer simply pulls when asked.
- **Minimal moving parts.** Each layer does one job. No over-engineering.

---

## Stack

| Layer | Technology |
|-------|------------|
| API server | Python, FastAPI, uvicorn |
| Process management | systemd |
| Accounting engine | hledger |
| Journal storage | Plain text file, git |
| Tunnel | Cloudflare Tunnel (cloudflared) |
| Authentication | Cloudflare Access |
| Edge middleware | Cloudflare Workers |
| Frontend | Vanilla HTML/CSS/JS (Single Page Application) |
| Development assistance | Anthropic Claude AI |

---

## System Components

### 1. Linux Machine (always-on)

**Role:** The compute layer. Runs hledger, serves the API, and holds the journal repository.

**What lives here:**
- The git repository containing `journal.hledger`
- FastAPI application (`uvicorn`, managed by `systemd`)
- hledger binary
- Cloudflare Tunnel daemon (`cloudflared`, managed by `systemd`)

---

### 2. FastAPI Application (Python)

**Role:** Thin wrapper around the hledger CLI. Translates HTTP requests into hledger commands and returns JSON. No business logic beyond that.

**v1 Endpoints (read-only):**

| Method | Path | hledger command | Description |
|--------|------|-----------------|-------------|
| GET | `/balance` | `hledger balance --output-format json` | All account balances |
| GET | `/is` | `hledger is --output-format json` | Income statement |
| GET | `/monthly` | `hledger balance --monthly --output-format json` | Monthly breakdown |
| GET | `/transactions` | `hledger print --output-format json` | Recent transactions (last 50) |
| GET | `/accounts` | `hledger accounts --output-format json` | Account list (used for autocomplete in v2) |
| POST | `/sync` | `git pull` | Pull latest from git remote |

**v2 Endpoints (writes):**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/add` | Accepts transaction payload, appends to journal, commits, and pushes |

**Security:** Every request is validated against a `Bearer` token (stored as an environment variable, never hardcoded) as a last-resort layer of defense.

**Notes:**
- All hledger commands run against the journal repository directory
- The write path (v2) serializes requests to prevent journal file lock conflicts
- No database, no cache — every request runs hledger fresh

---

### 3. Cloudflare Tunnel

**Role:** Exposes the FastAPI app to the internet without opening any inbound ports on the Linux machine. The `cloudflared` daemon makes an outbound connection to Cloudflare — no firewall rules or static IP required.

**Configuration:**
- Routes a subdomain (e.g. `api.yourdomain.com`) to `localhost:8000` on the Linux machine
- Managed by `cloudflared` running as a `systemd` service

---

### 4. Cloudflare Access

**Role:** Authentication gate that sits in front of the tunnel URL. Anyone reaching the tunnel URL without valid credentials receives a login wall before any request touches the Linux machine.

**Two access policies:**

| Policy | Who | Method |
|--------|-----|--------|
| Browser login | User in a browser | One-time email code or OAuth — sets a JWT cookie for subsequent requests |
| Service token | Cloudflare Workers (server-side) | `CF-Access-Client-Id` + `CF-Access-Client-Secret` request headers |

The service token is how the Workers middleware calls the API without triggering the browser login flow.

---

### 5. Cloudflare Workers (Middleware + Frontend Host)

**Role:** A single Cloudflare Worker that does two jobs:
1. **Serves the frontend** — returns the SPA HTML/JS to the browser
2. **Proxies API calls** — receives fetch requests from the frontend, injects the Cloudflare Access service token and Bearer token server-side, forwards to the tunnel, and returns the response

**Why this matters:** The service token secret never reaches the browser. It lives as a Workers environment secret. The browser only ever communicates with the Worker — never directly with the Linux machine.

**Routing:**
- `GET /` — serves the SPA HTML
- `GET /api/*` — proxies to FastAPI with secrets injected
- `POST /api/*` — same, for write operations in v2

---

### 6. Frontend — Single Page Application

A Single Page Application (SPA) is a web app that loads once and updates its content dynamically — tapping a view swaps the content in place rather than navigating to a new URL. This gives it a native app-like feel on mobile without requiring an app store install.

**v1 Views:**
- **Balance** — account tree with balances
- **Income Statement** — revenue and expense summary
- **Monthly** — monthly breakdown, scrollable on mobile
- **Transactions** — list of recent entries
- **Sync button** — triggers `/sync` and displays the last-synced timestamp

**v2 Additions:**
- **Add Transaction** — a form that replicates the `hledger add` interactive flow:
  - Date (defaults to today)
  - Description
  - Account 1 — text input with live autocomplete: account suggestions filter as you type, tap to select
  - Amount 1
  - Account 2 — same autocomplete behaviour
  - Amount 2 — auto-calculated as the inverse of Amount 1, editable
  - Confirm and submit

**Design:** Minimal, clean, mobile-first. No charts in v1. Vanilla JS — no heavy frontend frameworks.

---

## Git & Sync Flow

The journal lives in a git repository. Where that repository is hosted is flexible — it could be GitHub, GitLab, a self-hosted solution, or anything else. The API layer pulls from wherever the remote is configured to point.

```
Mac (source of truth)
  │
  │  git push  (after every manual add)
  ▼
Git repository  (hosted anywhere)
  │
  │  git pull  (triggered only when user taps the Sync button)
  ▼
Linux machine  (journal.hledger read by hledger)
  │
  ▼
FastAPI → Worker → Browser
```

The Linux machine never initiates anything on its own. It only responds to requests.

In v2, after a transaction is added via the mobile UI, the Linux machine commits and pushes back to the git remote so other devices pick it up on their next pull.

---

## Build Phases

### Phase 1 — Local Foundation
- [ ] Ensure git repository is accessible from the Linux machine
- [ ] Install hledger on Linux machine, verify it reads the journal correctly
- [ ] Write FastAPI app with all v1 read endpoints and `/sync`
- [ ] Configure as a `systemd` service (starts on boot, restarts on crash)
- [ ] Verify all endpoints return correct JSON via `curl` locally

### Phase 2 — Cloudflare Setup
- [ ] Set up Cloudflare Tunnel pointing to `localhost:8000`
- [ ] Configure Cloudflare Access on the tunnel URL
- [ ] Create service token for Workers use
- [ ] Test: browser login flow works; service token bypasses login

### Phase 3 — Workers Middleware
- [ ] Create Worker that serves a placeholder HTML page
- [ ] Add proxy routes (`/api/*`) that inject service token and Bearer token
- [ ] Verify end-to-end: browser → Worker → Tunnel → FastAPI → hledger

### Phase 4 — Frontend v1
- [ ] Build the SPA: balance, income statement, monthly, and transactions views
- [ ] Sync button with last-synced timestamp
- [ ] Mobile-friendly layout and styling
- [ ] Test on phone

### Phase 5 — Frontend v2 (Writes)
- [ ] Add transaction form with live autocomplete
- [ ] FastAPI `/add` endpoint
- [ ] Git commit and push after successful write
- [ ] Test full add flow from phone through to journal file

---

## Open Questions / Decisions Deferred

- **Bearer token management** — stored as an environment variable on the Linux machine and as a Workers secret. Rotation is manual when needed.
- **`/transactions` count** — last 50 transactions as a starting point. Adjustable once the UI is in use.
- **Monthly view layout** — scrollable table vs stacked cards on mobile. To be decided when the UI is visible.
- **v2 commit message format** — e.g. `add: [description] [date]`. Minor but worth a consistent format for a clean git log.