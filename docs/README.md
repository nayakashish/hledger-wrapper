# Documentation

Reference documentation for hledger Mobile — a self-hosted personal finance PWA
that puts a mobile interface on top of [hledger](https://hledger.org/). Start
with the [project README](../README.md) for the overview and feature summary;
the documents below go deeper.

## Contents

| Document | What it covers |
|----------|----------------|
| [architecture.md](architecture.md) | System overview, request flow, authentication layers, caching strategy, and the git journal flow, with sequence diagrams. |
| [deploy.md](deploy.md) | End-to-end setup guide: home server (FastAPI + hledger), Cloudflare Tunnel, Cloudflare Access, the Worker, bank-alert email routing, and local development. |
| [configuration.md](configuration.md) | Every server variable, Worker secret, journal folder file, and browser storage key. |
| [api-reference.md](api-reference.md) | Every endpoint with parameters, bodies, and error codes. |
| [envelopes.md](envelopes.md) | The virtual envelope budgeting system — model, reconciliation, the scan/assign lifecycle, splitting, and the full API. |
| [transaction-inbox.md](transaction-inbox.md) | Semi-automated transaction capture from bank-alert emails — the email pipeline, suggestion engine, and dedup. |
| [api-testing.md](api-testing.md) | The API test suite: mocking approach, coverage, and CI. |
| [CHANGELOG.md](CHANGELOG.md) | Per-version changelog. |