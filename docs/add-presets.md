# Add-Transaction Presets

The add button opens with a list of common transaction types instead of going
straight to the free-form form. Picking one fills in the accounts, the sign
convention, and often the title, so the usual entry is a date and an amount.

## The presets

| Preset | Positive posting | Negative posting | What it asks you |
|---|---|---|---|
| Regular expense | an `expenses:` account | the account that paid | date, category, amount |
| Pay credit card | the `liabilities:` card | the `assets:` account paying | date, amount |
| Transfer between accounts | the destination | the source | date, to, from, amount |
| Receive e-transfer | the `assets:` account it landed in | the `income:` account it came from | date, who, amount |
| Send e-transfer | the `expenses:` category | the `assets:` account paying | date, who, category, amount |
| Something else… | free-form | free-form | the original seven-step flow |

Every preset takes **one positive amount**. The account that receives it is
always the first posting, so the second is simply its inverse and there is no
second amount to enter. Paying a card down is a positive posting to the
liability, which is what reduces the debt.

Each preset ends at the same editable preview as the free-form flow, so the
finished entry can always be corrected — or given an inline `;` comment —
before it is written.

## Where the accounts come from

A preset never names a concrete account. It names a **shape**, and the
accounts come out of your own journal, which already records them. "Pay credit
card" is this query:

> the most recent transaction with a positive `liabilities:` posting against a
> negative `assets:` one

That returns both accounts and the transaction's description. The description
matters: a card payment is often titled something no account name contains, and
reusing your own wording is the only way to reproduce it.

Resolution order:

1. **Infer** from the journal's history, as above.
2. **Fall back** to `presets.json` in the journal folder.
3. **Ask**, with the account list filtered to the preset's prefixes.

Nothing is remembered per device and nothing is learned as you go: the same
journal gives the same answer every time until you record a new transaction of
that shape. `GET /api/presets` does the resolving, in one journal scan for all
presets, and reports whether each answer came from history or the stored
fallback.

### Shapes that collide

Some shapes are ambiguous. A received e-transfer and a paycheque are both
"an asset account up, an income account down", and only the wording separates
them. Those presets carry a description hint, which is tried first and then
dropped — so a journal that has never used that wording still gets an answer
from the shape alone.

## The `presets.json` fallback

Inference has one blind spot: a journal with no history. A new year's journal
starts empty, so every preset would come up blank until enough transactions
existed to infer from.

So when a journal is first selected, the presets resolved from the journal
being *left* are written to the new journal's `presets.json` — alongside
`envelopes.json` and `inbox.json` — and committed, so other devices get the
same answer. January works because December already answered.

```json
{
  "resolved": {
    "pay-card": {
      "debit": "liabilities:creditcard",
      "credit": "assets:chequing",
      "title": "Card Payment"
    }
  }
}
```

Edit it by hand to change what a preset starts from. History wins over the
file whenever the journal has a matching transaction, so an entry here only
takes effect while the journal is still too new to answer for itself. Deleting
the file is safe: the presets fall back to inference, and it is written again
the next time a journal is seeded.

Seeding is best-effort. If it fails, the journal still switches — the only
cost is that a preset asks for an account it could otherwise have preselected.

This file lives in the journal repository, not the application repository, so
account names stay with the data they describe.

## Envelopes

Received e-transfers post to an `income:` account, and the envelope scan picks
up any `expenses:` or `income:` posting — so they appear in the envelope
pending queue to be assigned, the same as any other income. Transfers between
accounts and credit-card payments touch neither prefix and stay out of the
queue.

## Adding a preset

The catalog lives in `api/app/presets.py`, one `Preset` per entry, holding its
label, the account prefixes for each side, and its title template. Adding one
is adding an entry there; the app picks it up with no frontend change, because
the form builds its steps from what the preset declares.

The step vocabulary is closed on purpose — date, party, account pick, amount,
preview. A preset that needs a step of its own is a deliberate change to that
list, not a special case, which is what keeps the add form a driver over a
declarative plan rather than a pile of per-preset conditionals.
