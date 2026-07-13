import json
import os
from datetime import date

from fastapi import APIRouter, HTTPException, Security

from ..auth import verify_token
from ..config import get_settings
from ..git_ops import git_transaction
from ..hledger import run_hledger
from ..models import Assignment, EnvAdjust, EnvCreate, EnvTransfer
from ..storage import load_json, save_json

router = APIRouter()

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


def _is_income(txn: dict) -> bool:
    for p in txn.get("tpostings", []):
        if p.get("paccount", "").startswith("income"):
            return True
    return False


def _txn_id(txn: dict) -> str:
    return f"{txn.get('tdate','')}|{txn.get('tdescription','')}|{txn.get('tindex', txn.get('tdate',''))}"


def _main_amount(txn: dict) -> float:
    """Return the primary non-income, non-asset posting amount (positive = expense)."""
    for p in txn.get("tpostings", []):
        acct = p.get("paccount", "")
        if acct.startswith("expenses") or acct.startswith("income"):
            amt = _extract_amount(p)
            return abs(amt)
    # fallback: first posting
    postings = txn.get("tpostings", [])
    return abs(_extract_amount(postings[0])) if postings else 0.0


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
    already_matched = set(data.get("matched_hledger_txns", []))
    pending_ids = {p["txn_id"] for p in data.get("pending", [])}
    envelopes = data.get("envelopes", [])

    raw = run_hledger("print", "--output-format", "json")
    try:
        txns = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Could not parse hledger output")

    added = []
    for txn in reversed(txns):  # most recent first
        tid = _txn_id(txn)
        if tid in already_matched or tid in pending_ids:
            continue

        is_income = _is_income(txn)
        amt = _main_amount(txn)
        if amt == 0:
            continue

        suggestion = None if is_income else _suggest_envelope(txn, envelopes)

        pending_entry = {
            "txn_id": tid,
            "date": txn.get("tdate", ""),
            "description": txn.get("tdescription", ""),
            "amount": amt,
            "type": "income" if is_income else "expense",
            "suggested_envelope": suggestion,
            "accounts": [p.get("paccount", "") for p in txn.get("tpostings", [])],
        }
        data["pending"].append(pending_entry)
        pending_ids.add(tid)
        added.append(pending_entry)

    _save_env_data(data)
    return {"status": "ok", "added": len(added), "pending_total": len(data["pending"])}


@router.post("/envelopes/assign")
def assign_transaction(body: Assignment, token: str = Security(verify_token)):
    """
    Assign a pending transaction to envelope(s).
    Expense: provide envelope_id — drains that envelope by the txn amount.
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
        if not body.envelope_id:
            raise HTTPException(status_code=400, detail="envelope_id required for expense")
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

    elif txn["type"] == "income":
        if not body.splits:
            raise HTTPException(status_code=400, detail="splits required for income")
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
    data["history"].append({"date": today, "type": "adjustment", "envelope": body.envelope, "amount": body.amount, "note": body.note or "Manual adjustment"})

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
