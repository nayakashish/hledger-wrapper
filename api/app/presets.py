"""Add-transaction presets: named transaction shapes for the common flows.

A preset never names a concrete account. It names a *shape* — "a positive
liabilities: posting against a negative assets: one" — and the accounts come
out of the journal, which already records them. That keeps personal account
names out of this (public) repo and makes every preset work on any journal.

Resolution order, per the plan doc:

1. Infer from the journal's own history.
2. Fall back to the stored resolution in the journal's presets.json, for a
   fresh January with nothing to infer from.
3. Give up and let the form ask.

The picked legs (a `pick=True` side) always ask; history only preselects.
"""

from dataclasses import dataclass

from .prediction import ShapeMatch, match_by_shape


@dataclass(frozen=True)
class Leg:
    """One side of a preset's two postings. `prefixes` is a "|"-separated
    account prefix list; `pick` means the form asks every time and the
    prefixes only filter the choices."""

    prefixes: str
    label: str
    pick: bool = False


@dataclass(frozen=True)
class Preset:
    id: str
    label: str
    debit: Leg | None = None   # takes the positive amount
    credit: Leg | None = None  # takes the negative amount
    title: str | None = None           # "{name}" is filled in by the form
    title_from_history: bool = False   # reuse the matched transaction's own wording
    description_hint: str | None = None
    asks_party: bool = False
    primary: bool = False      # the common path, highlighted in the picker
    free_form: bool = False    # the existing seven-step flow, no prefill


# Ordered as the picker shows them. Labels and copy live here so there is one
# place to change wording.
CATALOG: tuple[Preset, ...] = (
    Preset(
        id="expense",
        label="Regular expense",
        primary=True,
        debit=Leg("expenses:", "Category", pick=True),
        credit=Leg("assets:|liabilities:", "Paid from"),
    ),
    Preset(
        id="pay-card",
        label="Pay credit card",
        debit=Leg("liabilities:", "Card"),
        credit=Leg("assets:", "Paid from"),
        title_from_history=True,
    ),
    Preset(
        id="transfer",
        label="Transfer between accounts",
        debit=Leg("assets:|liabilities:", "To", pick=True),
        credit=Leg("assets:|liabilities:", "From", pick=True),
    ),
    Preset(
        id="receive-etransfer",
        label="Receive e-transfer",
        debit=Leg("assets:", "Deposited to"),
        credit=Leg("income:", "From"),
        title="e-transfer from {name}",
        description_hint="e-transfer",
        asks_party=True,
    ),
    Preset(
        id="send-etransfer",
        label="Send e-transfer",
        debit=Leg("expenses:", "Category", pick=True),
        credit=Leg("assets:", "Paid from"),
        title="e-transfer to {name}",
        description_hint="transfer",
        asks_party=True,
    ),
    Preset(
        id="standard",
        label="Something else…",
        free_form=True,
    ),
)


def _leg_json(leg: Leg | None, account: str) -> dict | None:
    if leg is None:
        return None
    return {
        "prefixes": leg.prefixes,
        "label": leg.label,
        "pick": leg.pick,
        "account": account,
    }


def resolve(preset: Preset, txns: list[dict], stored: dict) -> dict:
    """Fill in a preset's accounts and title, and say where they came from so
    the UI (and a future Settings screen) can tell inferred from remembered."""
    if preset.free_form:
        return {
            "id": preset.id,
            "label": preset.label,
            "free_form": True,
            "primary": preset.primary,
        }

    match: ShapeMatch | None = match_by_shape(
        preset.debit.prefixes,
        preset.credit.prefixes,
        preset.description_hint,
        txns,
    )

    remembered = stored.get(preset.id, {})
    if match:
        debit, credit, source = match.debit_account, match.credit_account, match.matched_on
        title = match.description if preset.title_from_history else preset.title
    else:
        debit = remembered.get("debit", "")
        credit = remembered.get("credit", "")
        source = "remembered" if (debit or credit) else "none"
        title = remembered.get("title", "") if preset.title_from_history else preset.title

    return {
        "id": preset.id,
        "label": preset.label,
        "free_form": False,
        "primary": preset.primary,
        "asks_party": preset.asks_party,
        "title": title or "",
        "debit": _leg_json(preset.debit, debit),
        "credit": _leg_json(preset.credit, credit),
        "source": source,
    }


def resolve_all(txns: list[dict], stored: dict) -> list[dict]:
    """Every preset, resolved against one journal scan rather than one per
    preset."""
    return [resolve(p, txns, stored) for p in CATALOG]


def snapshot(resolved: list[dict]) -> dict:
    """The accounts and titles worth carrying into a new journal, keyed by
    preset id. Only what was actually resolved — a preset the journal could
    not answer for is left out rather than stored blank."""
    out = {}
    for r in resolved:
        if r.get("free_form") or r.get("source") in (None, "none"):
            continue
        entry = {
            "debit": (r.get("debit") or {}).get("account", ""),
            "credit": (r.get("credit") or {}).get("account", ""),
        }
        if r.get("title"):
            entry["title"] = r["title"]
        if entry["debit"] or entry["credit"]:
            out[r["id"]] = entry
    return out
