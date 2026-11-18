# API Reference

Every server endpoint. The Worker proxies them as `/api/...`.

All endpoints require `Authorization: Bearer <token>` except `/health`. Write
endpoints commit and push as one unit; a failed push rolls the change back (see
[architecture.md](architecture.md)).

## Health and sync

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness. No auth |
| `POST` | `/sync` | `git pull` on the journal repo |

## Reports

| Method | Path | Parameters | Description |
|--------|------|------------|-------------|
| `GET` | `/balance` | none | All account balances |
| `GET` | `/is` | none | Income statement |
| `GET` | `/monthly` | none | Monthly breakdown, depth 2 |
| `GET` | `/monthly-detail` | none | Monthly breakdown, full depth |
| `GET` | `/transactions` | `month=YYYY-MM` | Transactions for one month |
| `GET` | `/search` | `q`, `from_date`, `to_date`, `period`, `account` (repeatable) | Text search with date and account filters. Accounts are OR'd |
| `GET` | `/daily-totals` | `from_date=YYYY-MM-DD` | Per-day count and total, for the heatmap |
| `GET` | `/accounts` | none | Account list |

## Entry

| Method | Path | Body or parameters | Description |
|--------|------|--------------------|-------------|
| `POST` | `/add` | `{date, description, account1, amount1, account2, amount2?, currency?, raw_entry?}` | Append an entry, commit, push. `raw_entry` is written as given. `amount2` defaults to `-amount1` |
| `GET` | `/descriptions` | none | Recent descriptions |
| `GET` | `/lookup` | `description` | Accounts used by the last matching entry |

## Journals

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/journals` | none | Journals found, flagged `active`, `inbox`, `demo` |
| `POST` | `/journals/select` | `{name}` | Set the active journal. `400` if the name is not a found journal |
| `POST` | `/journals/select-inbox` | `{name}` | Set the inbox journal. `400` for the demo journal |

## Envelopes

| Method | Path | Body |
|--------|------|------|
| `GET` | `/envelopes` | none |
| `POST` | `/envelopes/scan` | none |
| `POST` | `/envelopes/assign` | `{txn_id, envelope_id \| splits, note?}` |
| `POST` | `/envelopes/dismiss` | `{txn_id}` |
| `POST` | `/envelopes/transfer` | `{from_envelope, to_envelope, amount, note?}` |
| `POST` | `/envelopes/adjust` | `{envelope, amount, note?}` |
| `POST` | `/envelopes/create` | `{name, parent?}` |
| `DELETE` | `/envelopes/{id}` | none |

Details: [envelopes.md](envelopes.md).

## Inbox

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/inbox/ingest` | Parsed alert | Called by the Worker email handler |
| `GET` | `/inbox` | none | Pending items |
| `GET` | `/inbox/count` | none | `{pending, active_journal}` |
| `POST` | `/inbox/post` | `{id}` or `{id, raw_entry}` | Post to the journal |
| `POST` | `/inbox/dismiss` | `{id}` | Delete without posting |
| `POST` | `/inbox/rule` | `{pattern, account, description}` | Save a merchant rule |

Details: [transaction-inbox.md](transaction-inbox.md).

## Errors

| Status | Meaning |
|--------|---------|
| `401` | Wrong bearer token |
| `500` | `BEARER_TOKEN` unset, or a journal write failed |
| `503` | A data file is not configured or missing |

The Worker returns `{"error": "Failed to reach API"}` when the server or tunnel
is unreachable.
