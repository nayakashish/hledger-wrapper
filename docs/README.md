# Documentation

Reference documentation for hledger Mobile — a self-hosted personal finance PWA
that puts a mobile interface on top of [hledger](https://hledger.org/). Start
with the [project README](../README.md) for the overview and feature summary;
the documents below go deeper.

## Contents

| Document | What it covers |
|----------|----------------|
| [architecture.md](architecture.md) | System overview, request flow, authentication layers, caching strategy, and the git journal flow, with sequence diagrams. |
| [deploy.md](deploy.md) | End-to-end setup guide: home server (FastAPI + hledger), Cloudflare Tunnel, Cloudflare Access, the Worker, and local development. |
| [envelopes.md](envelopes.md) | The virtual envelope budgeting system — model, reconciliation, the scan/assign lifecycle, splitting, and the full API. |
| [transaction-inbox.md](transaction-inbox.md) | Semi-automated transaction capture from bank-alert emails — the email pipeline, suggestion engine, and dedup. |
| [CHANGELOG.md](CHANGELOG.md) | Per-version changelog. |

## Diagrams

All diagrams are authored inline as [Mermaid](https://mermaid.js.org/) fenced
code blocks within the documents above, so they render directly on GitHub and
in any Markdown viewer. There are no separate diagram source files to keep in
sync.
