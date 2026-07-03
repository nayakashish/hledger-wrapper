# Changelog

All notable changes to this project are documented here. Though since this is personal project, I am not super strict with this. Versioning follows
`major.minor`; the major version stays at `1` for now.

## [1.4] - 2026-07-02

Transaction Inbox — semi-automated transaction capture from bank alert
emails. Full write-up in `docs/transaction-inbox.md`.

- Added email handler to the Worker: Cloudflare Email Routing delivers CIBC
  alerts (Gmail filter auto-forward), postal-mime parses them, and the alert
  is staged via the new FastAPI ingest endpoint using the existing injected
  auth (no bypass rules, no new secrets)
- Added FastAPI inbox endpoints: ingest, list, count, post, dismiss, backed
  by inbox.json in the journal repo (committed like envelopes)
- Added suggestion engine: merchant rules, history matching (exact and token
  overlap) against the journal, card_map for the funding account, with
  high/medium/low confidence
- Added three-layer dedup (message id, pending items, journal) and a live
  "already in journal" check for transactions entered manually elsewhere
- Added InboxSheet UI (list + review with editable entry preview,
  Post/Edit/Dismiss) and a header inbox icon that turns teal when items are
  pending
- Manual forwards from the owner's address are unwrapped and ingested with
  the original alert date — used for testing and backfilling old alerts
- Refreshed CLAUDE.md (removed stale demo-mode references, corrected layout)

## [1.3] - 2026-07-01

Dashboard/report polish pass following the React rewrite.

- Rewrote docs with proper Mermaid diagrams, added system diagram to README, renamed "problem" section to "overview"
- Reworked heatmap labels, GitHub-style layout, and theme color; masked income in balance view
- Changed heatmap color and connected heatmap to sync
- Fixed balance report to be depth-2 and redid heatmap colors
- Fixed balance report to show the sum of sub-accounts
- Updated dashboard graphs and other minor fixes
- Added verse card

## [1.2] - 2026-06-28

Migration of the frontend from vanilla JS to React + Vite, plus the new
dashboard/heatmap feature set.

- Set up React + Vite infrastructure for the migration
- Added React app foundation: types, utils, hooks, views, and shared components
- Added all sheet and modal components; fixed build
- Removed old vanilla JS `index.html`
- Removed demo mode, added privacy toggle
- Masked income in monthly view, restructured to 4-tab layout
- Added monthly drilldown — tap a row to expand transactions
- Added dashboard with heatmap and 3 charts
- Added `/daily-totals` endpoint for the dashboard heatmap
- Heatmap scroll + click, monthly depth-2, unmasked reports, rewrote docs
- Cleaned up repo — removed temp/, stale artefacts, demo scripts
- Heatmap YTD range + teal colors, balance drilldown, removed section label

## [1.1] - 2026-05-06

- Added search feature, demo mode, and updated transactions list
- Updated envelopes feature

## [1.0] - 2026-03-08

Initial tagged release.

- Added local API
- Added initial documentation
- Updated API and added frontend worker
- Added transactions and sync to repo
- Fixed UI/UX of the add-transaction process
- Added PWA features
- Fixed banner and text styling
