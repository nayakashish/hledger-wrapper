# Envelopes

Envelope budgeting on top of hledger. Envelopes divide the money that already
exists in your real accounts into named buckets: groceries, gas, tithe, savings.
The journal does not change. It stays the record of what happened, while the
envelopes answer a different question — not how much is in the chequing account,
but how much of it is already committed.

No part of this feature writes to the journal. Envelope state lives in its own
JSON file, `envelopes.json`, which is committed next to the journal. The app
compares the two by their totals, not by shared entries. See
[Reconciliation](#reconciliation).

## Model

An envelope is a named bucket with a balance. Envelopes form a tree of two
levels: a **parent** envelope groups related **child** envelopes. Money is
always held in one specific envelope. The total shown for a parent is its own
balance plus the balances of its children.

```
Everyday (parent)                 $1,240.00   ← total = unallocated + children
  Unallocated                       $180.00   ← held directly on the parent
  Groceries                         $420.00
  Dining out                        $110.00
  Gas                               $530.00
Savings (parent)                  $8,000.00
Tithe                                $320.00
```

Two envelopes are **system envelopes**: `savings` and `chequing`. You cannot
delete them. They receive income by default, and they take the expenses that
match no other envelope.

### Data file

The server reads and writes one JSON file. Its path comes from
`ENVELOPE_DATA_FILE` in the server `.env`. The server commits and pushes the
file after every change, in the same way as the inbox file. The file has this
shape:

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
| `envelopes` | The tree. Each entry has `id`, `name`, an optional `parent`, and `sort_order` (its position among its siblings). |
| `balances` | The current balance of each envelope. This is the authoritative number. |
| `pending` | Transactions read from the journal that have no envelope yet. |
| `history` | An append-only log of every balance change: assignments, income allocations, transfers, and adjustments. |
| `matched_hledger_txns` | The ids of journal transactions that are already assigned or dismissed. A new scan does not show them again. |
| `income_split_default` | Optional default percentages for the income allocation form. |

The balances are the stored truth. The history explains how each balance reached
its value. The server does not recompute balances from the history. It trusts
`balances` and appends to `history` with each change.

## Reconciliation

Envelopes never touch the journal, so the two records can move apart. The
Envelopes view shows one indicator to make this visible. It adds up all envelope
balances and compares the sum with the liquid net worth that hledger reports,
which is assets plus liabilities from the Balance report.

- **in sync** — the envelope total agrees with hledger to within one cent.
- **+/- $X vs hledger** — the two disagree by that amount. Every real dollar
  must be in exactly one envelope. A difference thus means that a transaction
  was scanned but not assigned, that an assignment was missed, or that a manual
  adjustment is needed.

This is intentional. The envelope layer is permitted to be wrong, and the app
shows the error instead of forcing the two records to share state. To drive the
difference back to zero, assign the pending transactions and correct the rest
with manual adjustments.

## Lifecycle

The main loop is scan, then assign. A journal transaction becomes a pending
item. You assign it to one or more envelopes, or you dismiss it. The balances
move, and the item is marked as handled so that it does not come back.

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

`POST /envelopes/scan` reads every transaction from the journal with
`hledger print`. For each transaction that is not already in `pending` or in
`matched_hledger_txns`, the server does this:

1. It classifies the transaction as **income** if any posting goes to an
   `income:*` account. If not, the transaction is an **expense**.
2. It calculates the primary amount, which is the magnitude of the first
   `expenses:*` or `income:*` posting. If that amount is zero, the transaction
   is a transfer between asset accounts, and the server skips it.
3. For an expense, it calculates a **suggested envelope**. Income gets no
   suggestion, because you decide how to divide it.

Each remaining transaction goes into `pending` with its date, description,
amount, type, suggested envelope, and posting accounts. Scan is idempotent: it
only ever adds transactions that the envelope layer has not seen.

### Expense suggestion

The suggestion is a heuristic over the posting accounts of the transaction. The
first match wins.

1. **Account hints** — a small built-in map from expense account prefixes to
   envelope ids. For example, `expenses:generosity:tithe` gives the `tithe`
   envelope.
2. **Name in account** — if the name of a child envelope, in lower case and
   without spaces, occurs in a posting account, that envelope wins. A
   `Groceries` envelope thus matches a posting to `expenses:food:groceries`.
3. **Fallback** — all other expenses go to the `chequing` envelope.

The suggestion is only a default. On the assignment screen you can change it,
divide the amount across several envelopes, or dismiss the transaction.

### Assign

`POST /envelopes/assign` takes the id of a pending transaction and moves the
money. The body depends on the type of transaction and on whether you split it:

- **Single-envelope expense** — `{ txn_id, envelope_id, note? }`. The server
  subtracts the full amount from that envelope.
- **Split expense** — `{ txn_id, splits: [{ envelope_id, amount }], note? }`.
  The server subtracts each share from its envelope.
- **Income allocation** — `{ txn_id, splits: [{ envelope_id, amount }] }`. The
  server adds each share to its envelope. Income must always be split, even into
  a single envelope, so that the allocation stays explicit.

For a split, the server first makes sure that the amounts add up to the
transaction total to within one cent. If they do not, it returns `400` and
changes nothing. If they do, it moves each balance, appends one `history` entry
per envelope (`expense` or `income_allocation`), removes the item from
`pending`, and adds its id to `matched_hledger_txns`.

### Dismiss

`POST /envelopes/dismiss` with `{ txn_id }` removes a pending item without
moving money, and marks it as matched so that a new scan does not show it again.
Use it for journal transactions that do not concern the envelope layer, such as
a transfer between two of your own accounts.

## Splitting by amount or percent

Income allocation and split expenses use the same split editor. It has two entry
modes:

- **$ Amount** — you type a dollar figure for each envelope.
- **% Percent** — you type a percentage for each envelope, and the editor shows
  the equivalent dollar figure beside each row as you type.

The editor converts percentages into cent-exact amounts with the
largest-remainder method (Hamilton's apportionment). It rounds each share down
to the cent, then gives the remaining cents to the envelopes that were nearest
to the next cent. The shares therefore always add up to the transaction total,
and the same input always produces the same cents. The API receives dollar
amounts only. Percentage entry stays in the browser, and the server runs the
same sum check for both modes.

If you change mode, the editor fills the other mode from what you already
entered, so no work is lost.

The editor also tracks the remainder, which is the transaction total minus the
amount allocated so far. It shows the remainder as **fully allocated**,
**$X unassigned**, or **$X over-allocated**, and it keeps the confirm button
disabled until the split balances. Three helpers are available:

- **Reset defaults** (income only) — applies the default percentages again.
- **Clear all** — sets every row to zero.
- **Auto-balance** — puts the remainder into one target envelope: the suggested
  envelope, or `chequing`, or the first envelope. The split then balances with
  one tap.

### Income defaults

The income form is filled from `income_split_default`: a tithe percentage,
10 percent by default, and a savings percentage, 40 percent by default. The rest
goes to `chequing`. These are start values only. You can change them before you
confirm, and you edit the defaults themselves in `envelopes.json`.

## Envelope detail: transfer, adjust, correct

Tap an envelope to open its detail sheet. The sheet shows the current balance,
the action buttons, and the part of the history log that belongs to that
envelope. Four operations are available here.

### Transfer

`POST /envelopes/transfer` with `{ from_envelope, to_envelope, amount, note? }`
moves money between two envelopes. It subtracts from the source, adds to the
destination, and writes two matching `history` entries. The real account
balances do not change, because this only re-divides money that already exists.

### Adjust

`POST /envelopes/adjust` with `{ envelope, amount, note? }` adds a signed amount
to one envelope. A positive amount adds, a negative amount subtracts. The server
logs an `adjustment` entry. This is the manual control for driving the
reconciliation difference to zero, or for correcting a wrong split.

### Correct a split

You can reopen income allocations and multi-envelope expense splits from the
history log. The correction form shows the current share of each envelope for
that transaction, and you type the new amounts. On submit, the server calculates
the difference for each envelope and applies it as an `adjustment`. The original
history stays intact, and the correction is itself auditable. A history row can
be corrected when it is an income allocation, or when more than one envelope
shares its `txn_id`, which means it was part of a split.

### Create and delete

`POST /envelopes/create` with `{ name, parent? }` adds an envelope. The server
makes the id from the name: lower case, with spaces and hyphens changed to
underscores, and with a number added if that id already exists. It sets
`sort_order` to one more than the highest value among the siblings.

`DELETE /envelopes/<id>` removes an envelope. Two guards apply. The system
envelopes `savings` and `chequing` can never be deleted, and any other envelope
must have a zero balance first. You must move the money out before the envelope
can go.

## Privacy

Envelope balances are sensitive. When the privacy toggle in the header is on,
the app masks every envelope balance, the total of all envelopes, and the income
amounts in the pending list. See
[architecture.md](architecture.md#privacy-toggle). Expense amounts, envelope
names, dates, and descriptions stay visible.

## Storage and git

`envelopes.json` lives in the journal repository, at the path given by
`ENVELOPE_DATA_FILE`. Every endpoint that changes it — scan, assign, dismiss,
transfer, adjust, create, and delete — writes the file and then commits and
pushes it with a message tagged `Source: hledger-mobile-api`. A scan that finds
no new transactions writes nothing and makes no commit. The git history is
the durable audit trail. The `history` array in the file is the one you see in
the app.

Because each change is committed, the envelope state survives a rebuild of the
server, and you can recover it from git like any other tracked file. The app
keeps the last loaded state in `localStorage` (`hledger_envelopes_v3`), so the
Envelopes view opens immediately and refreshes on the next sync or change.

## API reference

All endpoints use bearer authentication, are served by FastAPI, and are reached
through the Worker proxy as `/api/envelopes/...`.

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

The GET response comes straight from `envelopes.json`. Each POST and DELETE
changes the file, commits, pushes, and returns the part of the state that
changed.

## Known limitations

- **Reconciliation runs in one direction.** The app shows the difference but
  does not correct it. You close the gap with an adjustment or with the missing
  assignment.
- **The expense suggestion is a heuristic.** It depends on account naming and on
  a small built-in hint map. An unusual account structure falls back to
  `chequing`, and you correct it when you assign.
- **The tree has two levels.** There are parents and children, but no third
  level.
- **Deletion needs a zero balance.** This is intentional, because it makes you
  move the money somewhere else instead of losing it. It is nonetheless a
  two-step operation.
