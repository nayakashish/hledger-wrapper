# Envelopes

Virtual envelope budgeting layered on top of hledger. Envelopes partition the
money that already exists in real accounts into named buckets — groceries, gas,
tithe, savings — without ever changing the journal. The journal remains the
single source of truth for what happened; envelopes are a second ledger that
answers a different question: not "how much is in my chequing account" but "how
much of it is already spoken for."

Nothing in this feature writes to the hledger journal. Envelope state lives in
its own JSON file (`envelopes.json`) committed alongside the journal. The two
are reconciled by a running total, not by shared entries — see
[Reconciliation](#reconciliation).

## Model

An envelope is a named bucket with a balance. Envelopes form a two-level tree:
top-level **parent** envelopes group related **child** envelopes. Money is only
ever held in a specific envelope; a parent's displayed total is the sum of its
own balance plus its children's.

```
Everyday (parent)                 $1,240.00   ← total = unallocated + children
  Unallocated                       $180.00   ← held directly on the parent
  Groceries                         $420.00
  Dining out                        $110.00
  Gas                               $530.00
Savings (parent)                  $8,000.00
Tithe                                $320.00
```

Two envelopes are treated as **system envelopes** and cannot be deleted:
`savings` and `chequing`. They are the default landing spots for income
allocation and for expenses that do not match a more specific envelope.

### Data file

The server reads and writes a single JSON file whose path is set by
`ENVELOPE_DATA_FILE` in the server `.env`. It is committed and pushed on every
mutation, exactly like the transaction inbox's `inbox.json`. Its shape:

```json
{
  "envelopes": [
    { "id": "everyday",  "name": "Everyday",  "parent": null,       "sort_order": 1 },
    { "id": "groceries", "name": "Groceries", "parent": "everyday", "sort_order": 1 },
    { "id": "savings",   "name": "Savings",   "parent": null,       "sort_order": 2 }
  ],
  "balances": {
    "everyday": 180.0,
    "groceries": 420.0,
    "savings": 8000.0
  },
  "pending": [],
  "history": [],
  "matched_hledger_txns": [],
  "income_split_default": { "tithe_pct": 0.10, "savings": 0.40 }
}
```

| Key | Meaning |
|-----|---------|
| `envelopes` | The tree. Each entry has `id`, `name`, optional `parent`, and `sort_order` (position among siblings). |
| `balances` | Current dollar balance per envelope id. The authoritative number. |
| `pending` | Transactions scanned from the journal but not yet assigned to an envelope. |
| `history` | Append-only log of every balance change: assignments, income allocations, transfers, adjustments. |
| `matched_hledger_txns` | Ids of journal transactions already handled (assigned or dismissed), so a re-scan never surfaces them twice. |
| `income_split_default` | Optional default percentages used to pre-fill the income allocation form. |

Balances are the stored truth; `history` is the audit trail that explains how
each balance got where it is. Nothing is recomputed from history on read — the
server trusts `balances` and appends to `history` alongside every change.

## Reconciliation

Envelopes never touch the journal, so the two can drift. The Envelopes view
guards against silent drift with a single indicator. It sums every envelope
balance and compares that against the real liquid net worth hledger reports
(assets plus liabilities from the Balance report):

- **in sync** — the envelope total matches hledger within one cent.
- **+/- $X vs hledger** — the two disagree by that amount. Every real dollar
  should live in exactly one envelope, so a non-zero difference means a
  transaction was scanned but not assigned, an assignment was missed, or a
  manual adjustment is needed.

This is a deliberate design choice: the envelope layer is allowed to be wrong,
and the app makes the wrongness visible rather than forcing the two ledgers to
share state. Assigning every pending transaction and correcting with manual
adjustments is what drives the difference back to zero.

## Lifecycle

The core loop is scan, then assign. A journal transaction becomes a pending
item; the user assigns it to one or more envelopes (or dismisses it); the
balances move and the item is marked handled so it never reappears.

```mermaid
sequenceDiagram
    participant App as Envelopes view
    participant API as FastAPI (home server)
    participant H as hledger
    participant Git as Journal repo

    Note over App: user taps Scan Txns
    App->>API: POST /envelopes/scan
    API->>H: hledger print --output-format json
    H-->>API: all journal transactions
    Note over API: skip already-matched and already-pending;<br>classify income vs expense; suggest an envelope
    API->>Git: commit envelopes.json
    API-->>App: pending list

    Note over App: user taps a pending item
    App->>API: POST /envelopes/assign (txn_id, envelope_id or splits)
    Note over API: move balances, append history;<br>remove from pending, mark matched
    API->>Git: commit envelopes.json
    API-->>App: updated state
```

### Scan

`POST /envelopes/scan` reads every transaction from the journal
(`hledger print`) and, for each one not already in `pending` or
`matched_hledger_txns`:

1. Classifies it as **income** (any posting to an `income:*` account) or
   **expense**.
2. Computes its primary amount — the magnitude of the first `expenses:*` or
   `income:*` posting. Transactions with a zero primary amount (pure transfers
   between asset accounts) are skipped.
3. For expenses only, computes a **suggested envelope** (income is always left
   unsuggested, because the user decides how to divide it).

Each surviving transaction is appended to `pending` with its date,
description, amount, type, the suggested envelope, and its posting accounts.
Scanning is idempotent: running it repeatedly only ever adds transactions the
envelope layer has not seen.

### Expense suggestion

The suggestion for an expense is a heuristic over the transaction's posting
accounts, first match wins:

1. **Account hints** — a small built-in map from expense account prefixes to
   envelope ids (for example `expenses:generosity:tithe` → the `tithe`
   envelope).
2. **Name-in-account** — if a child envelope's name (lowercased, spaces
   removed) appears inside a posting account, that envelope wins. A `Groceries`
   envelope matches a posting to `expenses:food:groceries`.
3. **Fallback** — any remaining expense defaults to the `chequing` envelope.

The suggestion is only a default; the assignment screen lets the user override
it, split across several envelopes, or dismiss the transaction entirely.

### Assign

`POST /envelopes/assign` takes a pending transaction id and moves money. The
request shape depends on the transaction type and whether the user split it:

- **Single-envelope expense** — `{ txn_id, envelope_id, note? }`. The full
  amount is subtracted from that one envelope.
- **Split expense** — `{ txn_id, splits: [{ envelope_id, amount }], note? }`.
  Each envelope is debited its share.
- **Income allocation** — `{ txn_id, splits: [{ envelope_id, amount }] }`. Each
  envelope is credited its share. Income must always be split (even if to a
  single envelope) so the allocation is explicit.

For any split, the server validates that the amounts sum to the transaction
total within one cent before touching a balance; a mismatch is a `400`. Once
validated, it debits or credits each envelope, appends a `history` entry per
envelope (`expense`, `income_allocation`), removes the item from `pending`, and
adds its id to `matched_hledger_txns`.

### Dismiss

`POST /envelopes/dismiss` with `{ txn_id }` removes a pending item without
moving any money and marks it matched, so a re-scan will not resurface it. This
is for journal transactions that are irrelevant to the envelope layer — an
internal transfer between two of the user's own accounts, say.

## Splitting: amount and percent

The assignment sheet's split editor is shared between income allocation and
split expenses. It offers two entry modes:

- **$ Amount** — type a dollar figure per envelope.
- **% Percent** — type a percentage per envelope; the editor shows the
  resulting dollar figure live beside each row.

Percentages are converted to cent-exact dollar amounts using the
largest-remainder method (Hamilton's apportionment): each share is rounded down
to the cent, then the leftover pennies are handed to the envelopes that were
closest to rounding up. The result always sums exactly to the transaction total
with no rounding drift, and identical inputs always produce identical cents.
The API only ever receives dollar amounts — percentage entry never leaves the
browser, and the server-side sum check is the same for both modes.

Switching modes seeds the other mode from what was already entered (dollar
amounts become their equivalent percentages and vice versa) so no work is lost.

The editor tracks the running remainder — the transaction total minus what has
been allocated so far — and shows it as **fully allocated**, **$X unassigned**,
or **$X over-allocated**. The confirm button is disabled until the split
balances. Three helpers assist:

- **Reset defaults** (income only) — re-applies the default percentage split.
- **Clear all** — zeroes every row.
- **Auto-balance** — pushes the outstanding remainder into a target envelope
  (the suggested one, else `chequing`, else the first envelope) so the split
  balances in one tap.

### Income defaults

Income allocation pre-fills from `income_split_default`: a tithe percentage
(default 10%) and a savings percentage (default 40%), with the remainder going
to `chequing`. These are only starting values — the user edits freely before
confirming, and the defaults themselves are edited in `envelopes.json`.

## Envelope detail: transfer, adjust, correct

Tapping an envelope opens its detail sheet: current balance, action buttons, and
its slice of the history log. Four operations live here.

### Transfer

`POST /envelopes/transfer` with `{ from_envelope, to_envelope, amount, note? }`
moves money between two envelopes. It debits the source, credits the
destination, and writes two mirrored `history` entries. Real account balances
are untouched — this only re-partitions money that already exists.

### Adjust

`POST /envelopes/adjust` with `{ envelope, amount, note? }` adds a signed
amount to one envelope (positive adds, negative subtracts) and logs an
`adjustment` history entry. This is the manual lever for pushing the
reconciliation difference back to zero, or for correcting a mis-entered split.

### Correct a split

Income allocations and multi-envelope expense splits can be reopened from the
history log. The correction form shows every envelope's current share for that
transaction and lets the user type new amounts. On submit it computes the
difference per envelope and applies each as an `adjustment`, so the original
history is preserved and the correction is itself auditable. A history row is
correctable when it is an income allocation or when its `txn_id` is shared by
more than one envelope (i.e. it was part of a split).

### Create and delete

`POST /envelopes/create` with `{ name, parent? }` adds an envelope. The id is
derived from the name (lowercased, spaces and hyphens to underscores, with a
numeric suffix if that id already exists), and `sort_order` is set to one past
the highest sibling.

`DELETE /envelopes/<id>` removes an envelope, subject to two guards: the
system envelopes (`savings`, `chequing`) can never be deleted, and an envelope
must have a zero balance first — money has to be transferred out before the
envelope can go.

## Privacy

Envelope balances are sensitive. When the header privacy toggle is on, every
envelope balance, the all-envelopes total, and income amounts in the pending
list render as masked placeholders (see [architecture.md](architecture.md#privacy-toggle)).
Expense amounts, envelope names, dates, and descriptions stay visible.

## Storage and git

`envelopes.json` lives in the journal repository (path from
`ENVELOPE_DATA_FILE`). Every mutating endpoint — scan, assign, dismiss,
transfer, adjust, create, delete — writes the file and immediately commits and
pushes it with a message tagged `Source: hledger-mobile-api`. Git history is
the durable audit trail; the in-file `history` array is the app-facing one.

Because the file is committed on every change, envelope state survives a server
rebuild and is recoverable from git like any other tracked file. The app caches
the last-loaded state in `localStorage` (`hledger_envelopes_v3`) so the
Envelopes view renders instantly on open and refreshes on the next sync or
mutation.

## API reference

All endpoints are bearer-authenticated, served by FastAPI, and reached through
the Worker proxy as `/api/envelopes/...`.

| Path | Method | Body | Description |
|------|--------|------|-------------|
| `/envelopes` | GET | — | Full state: envelopes, balances, pending, history |
| `/envelopes/scan` | POST | — | Scan the journal for new transactions into `pending` |
| `/envelopes/assign` | POST | `{ txn_id, envelope_id \| splits, note? }` | Assign a pending transaction to one or more envelopes |
| `/envelopes/dismiss` | POST | `{ txn_id }` | Drop a pending transaction without moving money |
| `/envelopes/transfer` | POST | `{ from_envelope, to_envelope, amount, note? }` | Move money between envelopes |
| `/envelopes/adjust` | POST | `{ envelope, amount, note? }` | Signed manual balance adjustment |
| `/envelopes/create` | POST | `{ name, parent? }` | Create an envelope |
| `/envelopes/<id>` | DELETE | — | Delete an envelope (zero balance, non-system only) |

The GET response is served straight from `envelopes.json`. Every POST/DELETE
mutates the file, commits, pushes, and returns the affected slice of state.

## Known limitations

- **Reconciliation is one-directional.** The app surfaces drift but does not
  auto-correct it; closing the gap is a manual adjust or a missed assignment.
- **The expense suggestion is a heuristic.** It leans on account-name
  conventions and a small built-in hint map; unusual account structures fall
  back to `chequing` and are corrected by hand at assignment time.
- **Two levels only.** The tree is parent-and-child; there is no grandchild
  nesting.
- **Deletion needs a zero balance.** Emptying an envelope before removing it is
  intentional — it forces the money to be re-homed rather than silently lost —
  but it is a two-step operation.
