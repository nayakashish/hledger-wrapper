import hashlib
import json
import os
from collections import Counter
from datetime import date

from fastapi import APIRouter, HTTPException, Security

from ..auth import verify_token
from ..config import get_settings
from ..git_ops import git_transaction
from ..hledger import run_hledger
from ..models import Assignment, EnvAdjust, EnvCreate, EnvTransfer, ReconcileAck
from ..storage import load_json, save_json

router = APIRouter()

# Version of the transaction-id scheme stored in envelopes.json. 1 (absent)
# was date|description|tindex; 2 is a content fingerprint. See _txn_ids.
TXN_ID_VERSION = 2

# Direct account-prefix -> envelope-id hints, checked before the by-name match.
ACCOUNT_HINTS = {
    "expenses:food:diningout": None,  # will match by name
    "expenses:food:groceries": None,
    "expenses:jetta:gas": None,
    "expenses:jetta:maintenance": None,
    "expenses:transportation:buspass": None,
    "expenses:phoneplan": None,
    "expenses:housing": None,
    "expenses:generosity:tithe": "tithe",
    "expenses:entertainment": None,
    "expenses:hobby": None,
    "expenses:personal": None,
    "expenses:education": None,
    "expenses:office": None,
}


def _default_env_data() -> dict:
    """Empty envelope store — used to seed a newly selected journal's
    envelopes.json so the envelope endpoints work against it immediately."""
    return {"envelopes": [], "pending": [], "matched_hledger_txns": [], "balances": {}, "history": [], "txn_id_version": TXN_ID_VERSION}


def _load_env_data() -> dict:
    settings = get_settings()
    if not settings.envelope_data_file or not os.path.exists(settings.envelope_data_file):
        raise HTTPException(status_code=503, detail="Envelope data file not found. Set ENVELOPE_DATA_FILE in .env")
    return load_json(settings.envelope_data_file)


def _save_env_data(data: dict) -> None:
    settings = get_settings()
    if not settings.envelope_data_file:
        raise HTTPException(status_code=503, detail="ENVELOPE_DATA_FILE not configured")
    save_json(settings.envelope_data_file, data)


def _extract_amount(posting: dict) -> float:
    amounts = posting.get("pamount", [])
    if not amounts:
        return 0.0
    a = amounts[0]
    q = a.get("aquantity", {})
    if isinstance(q, dict):
        return float(q.get("decimalMantissa", 0)) / (10 ** q.get("decimalPlaces", 0))
    return float(q or 0)


def _legacy_txn_id(txn: dict) -> str:
    """The version-1 id, kept only to migrate stores that still use it.
    tindex is the entry's position in the file, so inserting or deleting any
    earlier entry changed the id of everything after it."""
    return f"{txn.get('tdate','')}|{txn.get('tdescription','')}|{txn.get('tindex', txn.get('tdate',''))}"


def _content_hash(txn: dict) -> str:
    """Fingerprint of what the transaction is: date, description, and every
    posting's account and amount. Comments and the entry's position in the
    file are left out, so moving or annotating an entry keeps its id while
    changing its money gives it a new one."""
    postings = []
    for p in txn.get("tpostings", []):
        for a in p.get("pamount", []) or [{}]:
            q = a.get("aquantity", 0)
            qty = float(q.get("decimalMantissa", 0)) / (10 ** q.get("decimalPlaces", 0)) if isinstance(q, dict) else float(q or 0)
            postings.append(f"{p.get('paccount', '')}={a.get('acommodity', '')}{qty:.6f}")
    parts = [txn.get("tdate", ""), txn.get("tdescription", ""), *sorted(postings)]
    return hashlib.sha1("\n".join(parts).encode()).hexdigest()[:10]


def _txn_ids(txns: list[dict]) -> list[str]:
    """Stable ids for a whole journal, in hledger print order.

    `date|description|hash`, readable in git messages and history. Genuinely
    identical entries (same date, description and postings) share a hash, so
    the n-th copy gets a `#n` suffix."""
    seen: Counter = Counter()
    ids = []
    for t in txns:
        h = _content_hash(t)
        seen[h] += 1
        base = f"{t.get('tdate', '')}|{t.get('tdescription', '')}|{h}"
        ids.append(base if seen[h] == 1 else f"{base}#{seen[h]}")
    return ids


def _txn_id(txn: dict) -> str:
    """Id of a single transaction, for callers without the whole journal.
    Only safe when the transaction has no identical twin."""
    return _txn_ids([txn])[0]


def _migrate_txn_ids(data: dict, txns: list[dict], ids: list[str]) -> bool:
    """Move a version-1 store onto content ids, once. Returns True if it ran.

    Every current journal entry whose old id was matched becomes matched under
    its new id, and pending items are renamed in place. An entry whose old id
    went stale because an insert shifted it after the last scan is matched by
    date and description instead, as long as the store had at least as many
    matched ids for that date and description as the journal has entries.
    History keeps its old ids as labels; nothing reads them as keys."""
    if data.get("txn_id_version") == TXN_ID_VERSION:
        return False
    matched = set(data.get("matched_hledger_txns", []))
    pending_by_old = {p["txn_id"]: p for p in data.get("pending", [])}
    matched_per_day_desc = Counter(m.rsplit("|", 1)[0] for m in matched)
    journal_per_day_desc = Counter(f"{t.get('tdate', '')}|{t.get('tdescription', '')}" for t in txns)

    new_matched = set()
    for txn, new_id in zip(txns, ids):
        old_id = _legacy_txn_id(txn)
        day_desc = old_id.rsplit("|", 1)[0]
        if old_id in pending_by_old:
            pending_by_old[old_id]["txn_id"] = new_id
        elif old_id in matched or matched_per_day_desc[day_desc] >= journal_per_day_desc[day_desc]:
            new_matched.add(new_id)

    data["matched_hledger_txns"] = sorted(new_matched)
    data["txn_id_version"] = TXN_ID_VERSION
    return True


def _liquid_delta(txn: dict) -> float:
    """Net change the transaction makes to assets + liabilities, signed.

    This is the same quantity the reconciliation indicator compares against
    (envelope total vs assets + liabilities), so measuring it here means a
    fully assigned scan can never drift from that indicator. Positive is
    money in, negative is money out, and zero is a move between your own
    accounts (a card payment, savings to chequing) that envelopes don't care
    about."""
    total = 0.0
    for p in txn.get("tpostings", []):
        acct = p.get("paccount", "")
        if acct.startswith("assets") or acct.startswith("liabilities"):
            total += _extract_amount(p)
    return round(total, 2)


def _is_refund(txn: dict) -> bool:
    """Money coming back against an expense account, with no income posting."""
    accts = [p.get("paccount", "") for p in txn.get("tpostings", [])]
    return any(a.startswith("expenses") for a in accts) and not any(a.startswith("income") for a in accts)


def _validate_splits_sum(splits: list, target_amount: float) -> None:
    """Splits must sum to the transaction amount (within a cent) — catches
    both bad client math and, for the percent-entry UI, any conversion bug,
    since the frontend always converts percentages to dollar amounts before
    calling this endpoint."""
    total = round(sum(float(s.get("amount", 0)) for s in splits), 2)
    target = round(target_amount, 2)
    if abs(total - target) > 0.01:
        raise HTTPException(
            status_code=400,
            detail=f"splits must sum to {target:.2f} (got {total:.2f})",
        )


def _suggest_envelope(txn: dict, envelopes: list) -> str | None:
    """Suggest an envelope based on hledger account names. Returns envelope id or None."""
    child_envs = [e for e in envelopes if e.get("parent")]

    for p in txn.get("tpostings", []):
        acct = p.get("paccount", "").lower()

        # Direct hint match
        for prefix, eid in ACCOUNT_HINTS.items():
            if acct.startswith(prefix) and eid:
                return eid

        # Match by envelope name contained in account
        for env in child_envs:
            name_lower = env["name"].lower().replace(" ", "")
            acct_clean = acct.replace(":", "").replace("_", "")
            if name_lower in acct_clean:
                return env["id"]

        # Default expense -> chequing
        if acct.startswith("expenses"):
            return "chequing"

    return None


@router.get("/envelopes")
def get_envelopes(token: str = Security(verify_token)):
    return _load_env_data()


@router.post("/envelopes/scan")
def scan_transactions(token: str = Security(verify_token)):
    """
    Scan hledger for transactions not yet in pending or matched.
    Income transactions are always added to pending (no suggestion).
    Expense transactions are added to pending with a suggested envelope.
    Already-matched or already-pending txns are skipped.
    """
    data = _load_env_data()
    envelopes = data.get("envelopes", [])

    raw = run_hledger("print", "--output-format", "json")
    try:
        txns = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Could not parse hledger output")

    ids = _txn_ids(txns)
    migrated = _migrate_txn_ids(data, txns, ids)
    already_matched = set(data.get("matched_hledger_txns", []))
    pending_ids = {p["txn_id"] for p in data.get("pending", [])}

    added = []
    for txn, tid in reversed(list(zip(txns, ids))):  # most recent first
        if tid in already_matched or tid in pending_ids:
            continue

        delta = _liquid_delta(txn)
        if delta == 0:
            continue
        is_inflow = delta > 0
        amt = abs(delta)

        # Income gets no suggestion (you decide how to divide it). An
        # outflow, or a refund, belongs to its expense account's envelope.
        suggestion = _suggest_envelope(txn, envelopes) if (not is_inflow or _is_refund(txn)) else None

        pending_entry = {
            "txn_id": tid,
            "date": txn.get("tdate", ""),
            "description": txn.get("tdescription", ""),
            "amount": amt,
            "type": "income" if is_inflow else "expense",
            "suggested_envelope": suggestion,
            "accounts": [p.get("paccount", "") for p in txn.get("tpostings", [])],
        }
        data["pending"].append(pending_entry)
        pending_ids.add(tid)
        added.append(pending_entry)

    if not added and not migrated:
        # Nothing changed — skip the commit so git has nothing to complain about.
        return {"status": "ok", "added": 0, "pending_total": len(data["pending"])}

    message = f"envelopes: scan {len(added)} new pending"
    if migrated:
        message += f" (migrated to txn id v{TXN_ID_VERSION})"
    settings = get_settings()
    with git_transaction([settings.envelope_data_file], message):
        _save_env_data(data)

    return {"status": "ok", "added": len(added), "pending_total": len(data["pending"])}


@router.post("/envelopes/assign")
def assign_transaction(body: Assignment, token: str = Security(verify_token)):
    """
    Assign a pending transaction to envelope(s).
    Expense: provide envelope_id (single envelope) or splits (multiple).
    Income: provide splits [{envelope_id, amount}] — fills envelopes.
    Removes from pending, adds to matched, appends history.
    """
    data = _load_env_data()

    pending = data.get("pending", [])
    txn = next((p for p in pending if p["txn_id"] == body.txn_id), None)
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not in pending")

    history_entries = []

    if txn["type"] == "expense":
        if body.splits:
            _validate_splits_sum(body.splits, txn["amount"])
            for split in body.splits:
                eid = split["envelope_id"]
                amt = float(split["amount"])
                if amt == 0:
                    continue
                cur = data["balances"].get(eid, 0.0)
                data["balances"][eid] = round(cur - amt, 2)
                entry = {
                    "date": txn["date"],
                    "type": "expense",
                    "envelope": eid,
                    "amount": -amt,
                    "note": body.note or txn["description"],
                    "txn_id": body.txn_id,
                }
                data["history"].append(entry)
                history_entries.append(entry)
        elif body.envelope_id:
            eid = body.envelope_id
            amt = txn["amount"]
            cur = data["balances"].get(eid, 0.0)
            data["balances"][eid] = round(cur - amt, 2)
            entry = {
                "date": txn["date"],
                "type": "expense",
                "envelope": eid,
                "amount": -amt,
                "note": body.note or txn["description"],
                "txn_id": body.txn_id,
            }
            data["history"].append(entry)
            history_entries.append(entry)
        else:
            raise HTTPException(status_code=400, detail="envelope_id or splits required for expense")

    elif txn["type"] == "income":
        if not body.splits:
            raise HTTPException(status_code=400, detail="splits required for income")
        _validate_splits_sum(body.splits, txn["amount"])
        for split in body.splits:
            eid = split["envelope_id"]
            amt = float(split["amount"])
            if amt == 0:
                continue
            cur = data["balances"].get(eid, 0.0)
            data["balances"][eid] = round(cur + amt, 2)
            entry = {
                "date": txn["date"],
                "type": "income_allocation",
                "envelope": eid,
                "amount": amt,
                "note": body.note or txn["description"],
                "txn_id": body.txn_id,
            }
            data["history"].append(entry)
            history_entries.append(entry)

    # Remove from pending, mark matched
    data["pending"] = [p for p in pending if p["txn_id"] != body.txn_id]
    data["matched_hledger_txns"] = list(set(data.get("matched_hledger_txns", [])) | {body.txn_id})

    settings = get_settings()
    with git_transaction([settings.envelope_data_file], f"envelopes: assign {txn['type']} {txn['description'][:40]} {txn['date']}"):
        _save_env_data(data)

    return {"status": "ok", "entries": history_entries}


@router.post("/envelopes/dismiss")
def dismiss_transaction(body: dict, token: str = Security(verify_token)):
    """Dismiss a pending transaction (mark matched but don't affect any envelope)."""
    txn_id = body.get("txn_id")
    if not txn_id:
        raise HTTPException(status_code=400, detail="txn_id required")
    data = _load_env_data()
    data["pending"] = [p for p in data.get("pending", []) if p["txn_id"] != txn_id]
    data["matched_hledger_txns"] = list(set(data.get("matched_hledger_txns", [])) | {txn_id})

    settings = get_settings()
    with git_transaction([settings.envelope_data_file], f"envelopes: dismiss {txn_id[:40]}"):
        _save_env_data(data)

    return {"status": "ok"}


@router.post("/envelopes/transfer")
def envelope_transfer(body: EnvTransfer, token: str = Security(verify_token)):
    data = _load_env_data()
    today = date.today().isoformat()

    src = data["balances"].get(body.from_envelope, 0.0)
    data["balances"][body.from_envelope] = round(src - body.amount, 2)
    dst = data["balances"].get(body.to_envelope, 0.0)
    data["balances"][body.to_envelope] = round(dst + body.amount, 2)

    note = body.note or f"Transfer to {body.to_envelope}"
    data["history"].append({"date": today, "type": "transfer", "envelope": body.from_envelope, "amount": -body.amount, "note": note})
    data["history"].append({"date": today, "type": "transfer", "envelope": body.to_envelope, "amount": body.amount, "note": f"Transfer from {body.from_envelope}"})

    settings = get_settings()
    with git_transaction([settings.envelope_data_file], f"envelopes: transfer ${body.amount:.2f} {body.from_envelope}->{body.to_envelope}"):
        _save_env_data(data)

    return {"status": "ok", "balances": data["balances"]}


@router.post("/envelopes/adjust")
def envelope_adjust(body: EnvAdjust, token: str = Security(verify_token)):
    data = _load_env_data()
    today = date.today().isoformat()
    cur = data["balances"].get(body.envelope, 0.0)
    data["balances"][body.envelope] = round(cur + body.amount, 2)
    entry = {"date": today, "type": "adjustment", "envelope": body.envelope, "amount": body.amount, "note": body.note or "Manual adjustment"}
    if body.txn_id:
        entry["txn_id"] = body.txn_id
    data["history"].append(entry)

    settings = get_settings()
    with git_transaction([settings.envelope_data_file], f"envelopes: adjust {body.envelope} {body.amount:+.2f}"):
        _save_env_data(data)

    return {"status": "ok", "balance": data["balances"][body.envelope]}


@router.post("/envelopes/create")
def create_envelope(body: EnvCreate, token: str = Security(verify_token)):
    data = _load_env_data()
    new_id = body.name.lower().replace(" ", "_").replace("-", "_")
    # Ensure unique id
    existing_ids = {e["id"] for e in data["envelopes"]}
    base = new_id
    counter = 2
    while new_id in existing_ids:
        new_id = f"{base}_{counter}"
        counter += 1

    # Sort order = max of siblings + 1
    siblings = [e for e in data["envelopes"] if e.get("parent") == body.parent]
    sort_order = max((e.get("sort_order", 0) for e in siblings), default=0) + 1

    new_env = {"id": new_id, "name": body.name, "parent": body.parent, "sort_order": sort_order}
    data["envelopes"].append(new_env)
    data["balances"][new_id] = 0.0

    settings = get_settings()
    with git_transaction([settings.envelope_data_file], f"envelopes: create {body.name}"):
        _save_env_data(data)

    return {"status": "ok", "envelope": new_env}


@router.delete("/envelopes/{envelope_id}")
def delete_envelope(envelope_id: str, token: str = Security(verify_token)):
    data = _load_env_data()
    protected = {"savings", "chequing"}
    if envelope_id in protected:
        raise HTTPException(status_code=400, detail="Cannot delete system envelopes")
    bal = data["balances"].get(envelope_id, 0.0)
    if abs(bal) > 0.01:
        raise HTTPException(status_code=400, detail=f"Envelope has balance ${bal:.2f} — transfer out first")
    data["envelopes"] = [e for e in data["envelopes"] if e["id"] != envelope_id]
    data["balances"].pop(envelope_id, None)

    settings = get_settings()
    with git_transaction([settings.envelope_data_file], f"envelopes: delete {envelope_id}"):
        _save_env_data(data)

    return {"status": "ok"}


# --- Reconciliation: explain the gap ------------------------------------------

def _day_desc(txn_id: str) -> str:
    """`date|description` part of any transaction id, old or new scheme.
    Both schemes end in one `|`-separated segment (position or hash)."""
    return txn_id.rsplit("|", 1)[0]


def _classify(expected: float, recorded: float, n_journal: int, statuses: set[str]) -> str:
    if n_journal == 0:
        return "not_in_journal"
    if "pending" in statuses:
        return "pending"
    if "unscanned" in statuses:
        return "unscanned"
    if recorded == 0:
        return "dismissed"
    if expected != 0 and abs(recorded - 2 * expected) < 0.005:
        return "assigned_twice"
    return "amount_differs"


def _reconcile(data: dict, txns: list[dict]) -> dict:
    """Break `envelope total − (assets + liabilities)` into the transactions
    that cause it.

    Every journal transaction should move the envelopes by exactly its
    liquid delta. Transactions are grouped by date and description, which
    both id schemes share, so history written under old ids still counts.
    For each group, recorded − expected is that group's share of the gap.
    Adjustments and transfers with no txn_id are reported as one line, and
    the parts always add up to the gap exactly."""
    ids = _txn_ids(txns)
    matched = set(data.get("matched_hledger_txns", []))
    pending = {p["txn_id"] for p in data.get("pending", [])}

    groups: dict[str, dict] = {}

    def group(key: str) -> dict:
        return groups.setdefault(key, {"expected": 0.0, "recorded": 0.0, "n_journal": 0, "statuses": set(), "txn_id": None, "envelopes": []})

    for txn, tid in zip(txns, ids):
        g = group(_day_desc(tid))
        g["expected"] += _liquid_delta(txn)
        g["n_journal"] += 1
        g["txn_id"] = g["txn_id"] or tid
        g["statuses"].add("pending" if tid in pending else "matched" if tid in matched else "unscanned")

    unlinked = 0.0
    for h in data.get("history", []):
        amt = float(h.get("amount", 0))
        if h.get("txn_id"):
            g = group(_day_desc(h["txn_id"]))
            g["recorded"] += amt
            g["txn_id"] = g["txn_id"] or h["txn_id"]
            g["envelopes"].append(h.get("envelope"))
        else:
            unlinked += amt

    env_ids = {e["id"] for e in data.get("envelopes", [])}
    balances = data.get("balances", {})
    envelope_total = round(sum(balances.get(e, 0.0) for e in env_ids), 2)
    hledger_total = round(sum(_liquid_delta(t) for t in txns), 2)
    history_total = round(sum(float(h.get("amount", 0)) for h in data.get("history", [])), 2)
    acks = data.get("reconcile_ack", {})

    items, reviewed = [], 0.0
    for key, g in groups.items():
        diff = round(g["recorded"] - g["expected"], 2)
        if abs(diff) < 0.005:
            continue
        if acks.get(key) == diff:
            reviewed += diff
            continue
        date_, _, desc = key.partition("|")
        items.append({
            "key": key,
            "date": date_,
            "description": desc,
            "kind": _classify(round(g["expected"], 2), round(g["recorded"], 2), g["n_journal"], g["statuses"]),
            "journal": round(g["expected"], 2),
            "envelopes": round(g["recorded"], 2),
            "gap": diff,
            "txn_id": g["txn_id"],
            # Most recent envelope touched, the usual place to correct a
            # duplicate or a wrong amount.
            "envelope": g["envelopes"][-1] if g["envelopes"] else None,
        })
    items.sort(key=lambda i: i["date"], reverse=True)

    return {
        "gap": round(envelope_total - hledger_total, 2),
        "envelope_total": envelope_total,
        "hledger_total": hledger_total,
        "items": items,
        "reviewed": round(reviewed, 2),
        "unlinked_adjustments": round(unlinked, 2),
        # Balances that history doesn't explain: a hand-edited store, or
        # money in a balance key that isn't an envelope.
        "store_mismatch": round(envelope_total - history_total, 2),
    }


def _journal_txns() -> list[dict]:
    raw = run_hledger("print", "--output-format", "json")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Could not parse hledger output")


@router.get("/envelopes/reconcile")
def reconcile(token: str = Security(verify_token)):
    """Explain the difference between the envelope total and hledger."""
    return _reconcile(_load_env_data(), _journal_txns())


@router.post("/envelopes/reconcile/ack")
def reconcile_ack(body: ReconcileAck, token: str = Security(verify_token)):
    """Mark items as reviewed at their current gap. An item reappears if its
    gap later changes, e.g. the same transaction is assigned again."""
    data = _load_env_data()
    current = {i["key"]: i["gap"] for i in _reconcile(data, _journal_txns())["items"]}
    unknown = [k for k in body.keys if k not in current]
    if unknown:
        raise HTTPException(status_code=400, detail=f"not an open item: {unknown[0]}")
    acks = data.setdefault("reconcile_ack", {})
    for k in body.keys:
        acks[k] = current[k]

    settings = get_settings()
    with git_transaction([settings.envelope_data_file], f"envelopes: mark {len(body.keys)} reconcile item(s) reviewed"):
        _save_env_data(data)
    return {"status": "ok", "reviewed": len(body.keys)}
