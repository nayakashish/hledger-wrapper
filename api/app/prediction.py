"""One place that answers "what postings should this transaction have?".

Three callers ask the same question of the same journal scan, with different
predicates: ``/lookup`` asks by description, ``/presets`` asks by transaction
shape, and the inbox suggester asks by bank merchant string. Keeping the scan
and the posting extraction here means a wrong answer gets fixed once instead
of three times.

Only the first two are wired up so far; see the plan doc's coherence section
for why the inbox suggester is a follow-up rather than part of this change.
"""

import json
from dataclasses import dataclass

from .hledger import extract_amount, run_hledger


def load_transactions() -> list[dict]:
    """Every transaction in the active journal, oldest first (hledger's own
    order). Returns [] rather than raising on unparseable output, so a caller
    degrades to "no prediction" instead of failing the request."""
    try:
        return json.loads(run_hledger("print", "--output-format", "json"))
    except json.JSONDecodeError:
        return []


def _postings(txn: dict) -> list[tuple[str, float]]:
    return [(p.get("paccount", ""), extract_amount(p)) for p in txn.get("tpostings", [])]


def under(account: str, prefixes: str) -> bool:
    """Whether an account sits under any of a "|"-separated prefix list, e.g.
    "assets:|liabilities:" for either side of an account transfer."""
    return any(account.startswith(p) for p in prefixes.split("|") if p)


def match_by_description(description: str, txns: list[dict] | None = None) -> dict | None:
    """The most recent transaction whose description matches exactly, as the
    first two postings in journal order. Backs /lookup, whose response shape
    predates this module and is kept byte-for-byte."""
    txns = load_transactions() if txns is None else txns
    q = description.strip().lower()
    for txn in reversed(txns):
        if txn.get("tdescription", "").strip().lower() != q:
            continue
        postings = _postings(txn)
        if len(postings) >= 2:
            return {
                "account1": postings[0][0],
                "amount1": postings[0][1],
                "account2": postings[1][0],
                "amount2": postings[1][1],
            }
    return None


@dataclass
class ShapeMatch:
    """A transaction identified by its shape rather than its name. `debit` is
    the account that took the positive amount, `credit` the negative one —
    which is the order the add form wants them in."""

    description: str
    debit_account: str
    credit_account: str
    matched_on: str


def _shape_of(txn: dict, debit_prefixes: str, credit_prefixes: str) -> tuple[str, str] | None:
    postings = _postings(txn)
    debit = next((a for a, v in postings if v > 0 and under(a, debit_prefixes)), None)
    credit = next((a for a, v in postings if v < 0 and under(a, credit_prefixes)), None)
    return (debit, credit) if debit and credit else None


def match_by_shape(
    debit_prefixes: str,
    credit_prefixes: str,
    description_hint: str | None = None,
    txns: list[dict] | None = None,
) -> ShapeMatch | None:
    """The most recent transaction with a positive posting under
    `debit_prefixes` and a negative one under `credit_prefixes`.

    `description_hint` narrows the search where the account shape alone is
    ambiguous — an e-transfer and a paycheque are both "assets up, income
    down", and only the wording tells them apart. The hint is tried first and
    then dropped, so a journal that has never used that wording still gets an
    answer from the shape.
    """
    txns = load_transactions() if txns is None else txns
    hint = (description_hint or "").strip().lower()

    for require_hint in ((True, False) if hint else (False,)):
        for txn in reversed(txns):
            if require_hint and hint not in txn.get("tdescription", "").lower():
                continue
            shape = _shape_of(txn, debit_prefixes, credit_prefixes)
            if shape:
                return ShapeMatch(
                    description=txn.get("tdescription", "").strip(),
                    debit_account=shape[0],
                    credit_account=shape[1],
                    matched_on="description+shape" if require_hint else "shape",
                )
    return None
