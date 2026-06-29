# hledger Mobile — Migration & Feature Plan

This document summarizes a planning session for restructuring the hledger mobile app and adding new features. Hand this to a new Claude session to begin implementation.

---

## Context

The app is a self-hosted personal finance PWA built around hledger (plain-text double-entry accounting). It consists of:

- **FastAPI backend** (`api/main.py`) — thin wrapper around the hledger CLI, runs on a home Linux machine
- **Cloudflare Worker** (`worker/src/index.ts`) — serves the SPA and proxies `/api/*` requests with secrets injected server-side
- **Frontend** — currently a single vanilla JS/HTML SPA (`public/index.html`)

The backend and Worker proxy logic are **not changing**. The migration is frontend-only, plus minor Worker changes to serve a built `dist/` folder instead of a single HTML file.

---

## Migration Goal

Migrate the frontend from a monolithic vanilla JS SPA to a **Vite + React + TypeScript** project. This is necessary before adding new features because the upcoming changes (shared privacy toggle state, chart components, interactive drilldowns) require a proper component model. Building on the current vanilla JS foundation would result in unmaintainable spaghetti.

---

## Technology Decisions

| Concern | Decision |
|---|---|
| Framework | Vite + React + TypeScript |
| PWA | `vite-plugin-pwa` (replaces hand-rolled service worker) |
| Charts | Recharts |
| Data fetching | TanStack Query (replaces manual cache logic) |
| Deployment | Cloudflare Workers with auto-deploy from git (not Pages) |
| Demo mode | Remove entirely |

---

## New Tab Structure

Four tabs, replacing the current layout:

| Tab | Contents |
|---|---|
| Dashboard | Heatmap, charts (see below) |
| Envelopes | Existing envelope system, unchanged |
| Transactions | Existing transaction list with search |
| Reports | Balance tree, Monthly breakdown (selectable) |

On mobile the tab bar is bottom nav. On the current app, Reports and Transactions swap position from what was discussed — final order left to right: Dashboard, Envelopes, Transactions, Reports.

---

## Features to Build (in order)

### 1. Scaffold and Deploy Empty Shell
- Set up Vite + React + TypeScript project
- Configure `vite-plugin-pwa` for manifest and service worker
- Update Worker to serve `dist/` build output instead of importing a single HTML file
- Verify the empty app deploys and installs on phone as a PWA
- No features yet — just proving the pipeline works

### 2. Port Existing Views
Port each existing view as a React component. The hledger JSON parsing logic stays the same — just moving from innerHTML string building to JSX. Port in this order:

1. Transactions (simplest)
2. Balance (tree render)
3. Monthly (has select interaction)
4. Envelopes (most complex — sheets, forms, assign flow)

**During this step: remove demo mode entirely.**

What to remove:
- PIN modal
- Demo banner
- `sessionStorage` demo flag
- All `/api/demo/*` routing in the Worker
- KV namespace for demo data
- All `isDemoMode()` conditional branches in the frontend

The Worker gets meaningfully simpler after this.

### 3. Privacy Toggle
- Add a React Context holding a single boolean (`privacyMode`)
- Create a `<MaskedAmount>` component: renders formatted currency normally, or `••••` when privacy mode is on
- Replace every currency render in the app with `<MaskedAmount>`
- Add eye icon to the header to toggle
- State does **not** persist across sessions (in-memory only)

**What gets masked:**
- Net worth, assets, liabilities summary cards
- Envelope balances
- Income transaction amounts (anything under `income:` account prefix)
- Profit/loss and net worth charts (blur overlay when privacy mode on)

**What does not get masked:**
- Expense transaction amounts
- Account names
- Dates and descriptions

### 4. Tab Restructure
- Establish four-tab layout: Dashboard (placeholder), Envelopes, Transactions, Reports
- Move Balance tree and Monthly breakdown into the Reports tab
- Reports tab has a selector for which report to view

### 5. Monthly Drilldown
- Tapping a category row in the Monthly report expands to show the transactions in that category
- Filter by account prefix and date range using existing transaction data
- Render in the same transaction list component from step 2

### 6. Dashboard

#### Heatmap
- Shows transaction activity for the trailing 12 months, one cell per day
- Style: GitHub contribution graph aesthetic
- No color-coding for income vs expense — activity intensity only (darker = more transactions or higher total)
- For performance: add a new FastAPI endpoint `/daily-totals` that returns aggregated daily transaction counts/amounts rather than doing it client-side from raw transactions
- New endpoint should return: `{ date: string, count: number, total: number }[]` for a given date range

#### Charts (all showing trailing 12 months)
Four charts, no more:

1. **Profit/Loss** — net income minus expenses, monthly bar or line chart, 12-month view
2. **Spending by Category vs Prior Period** — bar chart comparing this month to either last month or 3-month rolling average; user can toggle between the two comparisons
3. **Net Worth Over Time** — line chart, monthly data points, shows whether savings trend is positive or negative
4. No "big number" summary at the top of the dashboard

All chart data sourced from existing monthly endpoint where possible. Net worth line may need an additional endpoint or client-side aggregation from balance history.

### 7. Documentation
Rewrite README once all features are stable. It currently reads as a project plan with checkboxes. It should become:
- What the project is (2–3 sentences)
- Architecture diagram or description
- Setup guide (how to get it running from scratch on a new machine)
- API reference
- How to deploy / update

---

## Project Structure

```
hledger-mobile/
├── frontend/
│   ├── src/
│   │   ├── components/      # shared UI components (MaskedAmount, Sheet, etc.)
│   │   ├── views/           # top-level tab views
│   │   ├── hooks/           # data fetching hooks
│   │   ├── context/         # PrivacyContext, etc.
│   │   └── main.tsx
│   ├── public/              # icons (managed by vite-plugin-pwa)
│   ├── vite.config.ts
│   └── package.json
├── worker/
│   └── src/index.ts         # mostly unchanged, serves dist/ instead of HTML import
├── api/
│   └── main.py              # unchanged except new /daily-totals endpoint in step 6
└── README.md
```

---

## Worker Changes (minimal)

Current Worker imports `index.html` directly as a bundled asset. After migration it should:
- Serve `dist/index.html` for `GET /`
- Serve other static assets from `dist/` (JS, CSS, icons)
- Keep all `/api/*` proxy logic completely unchanged
- Remove all `/api/demo/*` routing and the `DEMO_DATA` KV binding

The Worker secrets (`API_BASE_URL`, `BEARER_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`) are unchanged.

---

## Existing Code to Preserve

All of the following logic exists in the current vanilla JS and should be carried over during the port — it is correct and just needs to be translated to React:

- `extractAmount()` — parses hledger's nested aquantity format
- `fmtAmount()` — formats currency with symbol
- `amountClass()` — returns positive/negative/neutral CSS class
- `escHtml()` — HTML escaping for rendered strings
- All hledger JSON parsing in the balance, monthly, and transaction renderers
- The swipe-to-close gesture on bottom sheets
- The autocomplete logic for account names and descriptions in the Add Transaction flow
- The `lookupDescription()` prefill behavior

---

## What Not to Change

- FastAPI backend endpoints (except adding `/daily-totals` in step 6)
- Cloudflare Tunnel and Access configuration
- Bearer token auth pattern
- The envelope data model and all envelope API endpoints
- The git commit-and-push flow triggered by `/add` and envelope mutations