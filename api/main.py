import os
import re as _re
import subprocess
import threading
from datetime import date
from functools import wraps

from fastapi import FastAPI, HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import json as _json
from datetime import date as _date
from datetime import datetime as _datetime, timezone as _timezone
import uuid as _uuid

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

JOURNAL_DIR = os.getenv("JOURNAL_DIR", "")
JOURNAL_FILE = os.getenv("JOURNAL_FILE", "")
ACCOUNTS_FILE = os.getenv("ACCOUNTS_FILE", "")  # chart-of-accounts journal (account directives)
HLEDGER_BIN = os.getenv("HLEDGER_BIN", "hledger")
BEARER_TOKEN = os.getenv("BEARER_TOKEN", "")
DEFAULT_CURRENCY = os.getenv("DEFAULT_CURRENCY", "$")
ENVELOPE_CONFIG_FILE = os.getenv("ENVELOPE_CONFIG_FILE", "")
ENVELOPE_DATA_FILE   = os.getenv("ENVELOPE_DATA_FILE", "")
ENVELOPE_DATA_FILE = os.getenv("ENVELOPE_DATA_FILE", "")
INBOX_DATA_FILE = os.getenv("INBOX_DATA_FILE", "")

app = FastAPI(title="hledger API", version="1.0.0")
security = HTTPBearer()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tightened to your Worker domain once deployed
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization"],
)

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def verify_token(credentials: HTTPAuthorizationCredentials = Security(security)):
    if not BEARER_TOKEN:
        raise HTTPException(status_code=500, detail="Server misconfigured: BEARER_TOKEN not set")
    if credentials.credentials != BEARER_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid token")
    return credentials.credentials


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def run_hledger(*args: str) -> str:
    """Run an hledger command against the configured journal file and return stdout."""
    if not JOURNAL_FILE:
        raise HTTPException(status_code=500, detail="Server misconfigured: JOURNAL_FILE not set")
    return run_hledger_file(JOURNAL_FILE, *args)


def run_hledger_file(journal_file: str, *args: str) -> str:
    """Run an hledger command against a specific journal file and return stdout."""
    cmd = [HLEDGER_BIN, "-f", journal_file, *args]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail=f"hledger binary not found at: {HLEDGER_BIN}")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="hledger command timed out")

    if result.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"hledger error: {result.stderr.strip()}"
        )
    return result.stdout


def run_git(*args: str) -> str:
    """Run a git command in JOURNAL_DIR and return stdout."""
    if not JOURNAL_DIR:
        raise HTTPException(status_code=500, detail="Server misconfigured: JOURNAL_DIR not set")
    cmd = ["git", *args]
    try:
        result = subprocess.run(
            cmd,
            cwd=JOURNAL_DIR,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="git command timed out")

    if result.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"git error: {result.stderr.strip()}"
        )
    return result.stdout


# ---------------------------------------------------------------------------
# Read endpoints
# ---------------------------------------------------------------------------

@app.get("/balance")
def get_balance(token: str = Security(verify_token)):
    """All account balances."""
    output = run_hledger("balance", "--output-format", "json")
    return {"raw": output}


@app.get("/is")
def get_income_statement(token: str = Security(verify_token)):
    """Income statement."""
    output = run_hledger("is", "--output-format", "json")
    return {"raw": output}


@app.get("/monthly")
def get_monthly(token: str = Security(verify_token)):
    """Monthly balance breakdown at depth 2 (top two account levels)."""
    output = run_hledger("balance", "--monthly", "--depth", "2", "--output-format", "json")
    return {"raw": output}


@app.get("/monthly-detail")
def get_monthly_detail(token: str = Security(verify_token)):
    """Monthly balance breakdown at full account depth (for sub-account charts)."""
    output = run_hledger("balance", "--monthly", "--output-format", "json")
    return {"raw": output}


@app.get("/transactions")
def get_transactions(month: str = None, token: str = Security(verify_token)):
    """
    Transactions for a given month (YYYY-MM). If no month given, returns current month.
    hledger date filter: YYYY-MM-01..YYYY-MM+1-01
    """
    import json
    from datetime import date

    if month:
        try:
            year, mon = int(month[:4]), int(month[5:7])
        except (ValueError, IndexError):
            raise HTTPException(status_code=400, detail="month must be YYYY-MM format")
    else:
        today = date.today()
        year, mon = today.year, today.month

    # Build next month for end of range
    if mon == 12:
        next_year, next_mon = year + 1, 1
    else:
        next_year, next_mon = year, mon + 1

    date_filter = f"{year}-{mon:02d}-01..{next_year}-{next_mon:02d}-01"
    output = run_hledger("print", "--output-format", "json", "-p", date_filter)
    try:
        txns = json.loads(output)
        txns.reverse()  # most recent first
        return {"raw": json.dumps(txns)}
    except json.JSONDecodeError:
        return {"raw": output}


@app.get("/search")
def search_transactions(q: str, token: str = Security(verify_token)):
    """
    Full-text search across all transactions (description, payee, account names).
    Returns matching transactions sorted most recent first.
    Uses hledger's built-in description/account search via `print`.
    Falls back to in-process filtering for broader matching.
    """
    import json

    if not q or not q.strip():
        return {"raw": "[]"}

    query = q.strip()

    # Fetch all transactions then filter in Python for flexible matching
    # (hledger's query syntax is powerful but we want substring match on
    # description OR any account name, which is easier to do here)
    output = run_hledger("print", "--output-format", "json")
    try:
        all_txns = json.loads(output)
    except json.JSONDecodeError:
        return {"raw": "[]"}

    ql = query.lower()
    matches = []
    for txn in reversed(all_txns):  # most recent first
        desc = txn.get("tdescription", "").lower()
        payee = txn.get("tpayee", "").lower()
        note = txn.get("tnote", "").lower()
        accounts = [p.get("paccount", "").lower() for p in txn.get("tpostings", [])]
        comments = [p.get("pcomment", "").lower() for p in txn.get("tpostings", [])]
        tcomment = txn.get("tcomment", "").lower()

        haystack = " ".join([desc, payee, note, tcomment] + accounts + comments)
        if ql in haystack:
            matches.append(txn)

    return {"raw": json.dumps(matches)}


@app.get("/accounts")
def get_accounts(token: str = Security(verify_token)):
    """
    Chart of accounts. When ACCOUNTS_FILE is set (a journal of `account`
    directives, e.g. 2026accounts.journal), returns the declared accounts —
    the authoritative CoA. Otherwise falls back to accounts used in the
    journal. Used for autocomplete and the Reports CoA view.
    """
    if ACCOUNTS_FILE:
        output = run_hledger_file(ACCOUNTS_FILE, "accounts", "--declared")
    else:
        output = run_hledger("accounts")
    accounts = [line.strip() for line in output.splitlines() if line.strip()]
    return {"accounts": accounts}


# ---------------------------------------------------------------------------
# Sync endpoint
# ---------------------------------------------------------------------------

@app.post("/sync")
def sync(token: str = Security(verify_token)):
    """Pull latest journal from git remote."""
    output = run_git("pull")
    return {"status": "ok", "detail": output.strip()}


# ---------------------------------------------------------------------------
# Write endpoints (v2)
# ---------------------------------------------------------------------------

class Transaction(BaseModel):
    date: str | None = None        # YYYY-MM-DD
    description: str | None = None
    account1: str | None = None
    amount1: float | None = None
    account2: str | None = None
    amount2: float | None = None   # auto-calculated if omitted
    currency: str = DEFAULT_CURRENCY
    raw_entry: str | None = None   # if set, written directly (supports comments)


@app.post("/add")
def add_transaction(tx: Transaction, token: str = Security(verify_token)):
    """
    Append a transaction to the journal, commit, and push.
    Commits are tagged with 'Source: hledger-mobile-api' trailer
    so they can be identified and filtered in git log.
    """
    # If raw_entry provided (from editable preview), write directly
    if tx.raw_entry:
        entry = "\n" + tx.raw_entry.strip() + "\n"
    else:
        amount2 = tx.amount2 if tx.amount2 is not None else -tx.amount1
        entry = (
            f"\n{tx.date} {tx.description}\n"
            f"    {tx.account1}    {tx.currency}{tx.amount1:.2f}\n"
            f"    {tx.account2}    {tx.currency}{amount2:.2f}\n"
        )

    try:
        with open(JOURNAL_FILE, "a") as f:
            f.write(entry)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Could not write to journal: {e}")

    desc_label = tx.description or "transaction"
    date_label = tx.date or "unknown"
    commit_message = (
        f"add: {desc_label} {date_label}\n\n"
        f"Source: hledger-mobile-api"
    )

    run_git("add", JOURNAL_FILE)
    run_git("commit", "-m", commit_message)
    run_git("push")

    return {"status": "ok", "entry": entry.strip()}


# ---------------------------------------------------------------------------
# Autocomplete endpoints
# ---------------------------------------------------------------------------

@app.get("/descriptions")
def get_descriptions(token: str = Security(verify_token)):
    """All unique transaction descriptions, sorted by most recent first."""
    import json
    output = run_hledger("print", "--output-format", "json")
    try:
        txns = json.loads(output)
    except json.JSONDecodeError:
        return {"descriptions": []}
    seen = []
    for txn in reversed(txns):  # most recent first
        desc = txn.get("tdescription", "").strip()
        if desc and desc not in seen:
            seen.append(desc)
    return {"descriptions": seen}


@app.get("/lookup")
def lookup_description(description: str, token: str = Security(verify_token)):
    """
    Given a description, return the most recent matching transaction's
    account1, amount1, account2, amount2 for pre-filling the add form.
    """
    import json
    output = run_hledger("print", "--output-format", "json")
    try:
        txns = json.loads(output)
    except json.JSONDecodeError:
        return {"match": None}

    q = description.strip().lower()
    for txn in reversed(txns):
        if txn.get("tdescription", "").strip().lower() == q:
            postings = txn.get("tpostings", [])
            if len(postings) >= 2:
                def extract(p):
                    amounts = p.get("pamount", [])
                    if not amounts:
                        return 0.0
                    a = amounts[0]
                    q = a.get("aquantity", {})
                    if isinstance(q, dict):
                        return float(q.get("decimalMantissa", 0)) / (10 ** q.get("decimalPlaces", 0))
                    return float(q or 0)
                return {"match": {
                    "account1": postings[0].get("paccount", ""),
                    "amount1": extract(postings[0]),
                    "account2": postings[1].get("paccount", ""),
                    "amount2": extract(postings[1]),
                }}
    return {"match": None}


# ---------------------------------------------------------------------------
# Daily totals — for dashboard heatmap
# ---------------------------------------------------------------------------

@app.get("/daily-totals")
def get_daily_totals(from_date: str = None, token: str = Security(verify_token)):
    """
    Returns transaction counts and absolute totals per day from from_date to today.
    Defaults to Jan 1 of the current year.
    Response: [{ date: "YYYY-MM-DD", count: int, total: float }, ...]
    """
    import json
    from datetime import date

    today = date.today()
    if from_date:
        try:
            start = date.fromisoformat(from_date)
        except ValueError:
            start = date(today.year, 1, 1)
    else:
        start = date(today.year, 1, 1)
    date_filter = f"{start.isoformat()}..{today.isoformat()}"

    output = run_hledger("print", "--output-format", "json", "-p", date_filter)
    try:
        txns = json.loads(output)
    except json.JSONDecodeError:
        return []

    by_date: dict[str, dict] = {}
    for txn in txns:
        d = txn.get("tdate", "")
        if not d:
            continue
        if d not in by_date:
            by_date[d] = {"count": 0, "total": 0.0}
        by_date[d]["count"] += 1
        for posting in txn.get("tpostings", []):
            for amt in posting.get("pamount", []):
                qty = amt.get("aquantity", 0)
                if isinstance(qty, dict):
                    mantissa = qty.get("decimalMantissa", 0)
                    places = qty.get("decimalPlaces", 0)
                    qty = mantissa / (10 ** places) if places else float(mantissa)
                by_date[d]["total"] += abs(float(qty))

    result = [
        {"date": d, "count": v["count"], "total": round(v["total"], 2)}
        for d, v in sorted(by_date.items())
    ]
    return result


# Health check (no auth — used to verify service is up)
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _find_journal_file() -> str:
    """Return path to the journal file inside JOURNAL_DIR."""
    for ext in (".ledger", ".journal", ".hledger"):
        for fname in os.listdir(JOURNAL_DIR):
            if fname.endswith(ext):
                return os.path.join(JOURNAL_DIR, fname)
    raise HTTPException(
        status_code=500,
        detail=f"No journal file found in {JOURNAL_DIR}"
    )





def _load_env_data() -> dict:
    if not ENVELOPE_DATA_FILE or not os.path.exists(ENVELOPE_DATA_FILE):
        raise HTTPException(status_code=503, detail="Envelope data file not found. Set ENVELOPE_DATA_FILE in .env")
    with open(ENVELOPE_DATA_FILE) as f:
        return _json.load(f)


def _save_env_data(data: dict):
    if not ENVELOPE_DATA_FILE:
        raise HTTPException(status_code=503, detail="ENVELOPE_DATA_FILE not configured")
    with open(ENVELOPE_DATA_FILE, "w") as f:
        _json.dump(data, f, indent=2)


def _commit_env(message: str):
    run_git("add", ENVELOPE_DATA_FILE)
    run_git("commit", "-m", f"{message}\n\nSource: hledger-mobile-api")
    run_git("push")


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
    # Build prefix map from envelope names (simple heuristic)
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

        # Default expense → chequing
        if acct.startswith("expenses"):
            return "chequing"

    return None


# ---------------------------------------------------------------------------
# GET /envelopes — full state
# ---------------------------------------------------------------------------

@app.get("/envelopes")
def get_envelopes(token: str = Security(verify_token)):
    data = _load_env_data()
    return data


# ---------------------------------------------------------------------------
# POST /envelopes/scan — scan hledger for new transactions, add to pending
# ---------------------------------------------------------------------------

@app.post("/envelopes/scan")
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
        txns = _json.loads(raw)
    except _json.JSONDecodeError:
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


# ---------------------------------------------------------------------------
# POST /envelopes/assign — assign a pending transaction to envelope(s)
# ---------------------------------------------------------------------------

class Assignment(BaseModel):
    txn_id: str
    # For expenses: single envelope drain
    envelope_id: str | None = None
    # For income: list of {envelope_id, amount} splits
    splits: list | None = None
    note: str | None = None


@app.post("/envelopes/assign")
def assign_transaction(body: Assignment, token: str = Security(verify_token)):
    """
    Assign a pending transaction to envelope(s).
    Expense: provide envelope_id — drains that envelope by the txn amount.
    Income: provide splits [{envelope_id, amount}] — fills envelopes.
    Removes from pending, adds to matched, appends history.
    """
    data = _load_env_data()
    today = _date.today().isoformat()

    # Find pending entry
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
        total_split = sum(s.get("amount", 0) for s in body.splits)
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

    _save_env_data(data)
    _commit_env(f"envelopes: assign {txn['type']} {txn['description'][:40]} {txn['date']}")

    return {"status": "ok", "entries": history_entries}


# ---------------------------------------------------------------------------
# POST /envelopes/dismiss — remove from pending without assigning
# ---------------------------------------------------------------------------

@app.post("/envelopes/dismiss")
def dismiss_transaction(body: dict, token: str = Security(verify_token)):
    """Dismiss a pending transaction (mark matched but don't affect any envelope)."""
    txn_id = body.get("txn_id")
    if not txn_id:
        raise HTTPException(status_code=400, detail="txn_id required")
    data = _load_env_data()
    data["pending"] = [p for p in data.get("pending", []) if p["txn_id"] != txn_id]
    data["matched_hledger_txns"] = list(set(data.get("matched_hledger_txns", [])) | {txn_id})
    _save_env_data(data)
    _commit_env(f"envelopes: dismiss {txn_id[:40]}")
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# POST /envelopes/transfer — move money between envelopes
# ---------------------------------------------------------------------------

class EnvTransfer(BaseModel):
    from_envelope: str
    to_envelope: str
    amount: float
    note: str | None = None


@app.post("/envelopes/transfer")
def envelope_transfer(body: EnvTransfer, token: str = Security(verify_token)):
    data = _load_env_data()
    today = _date.today().isoformat()

    src = data["balances"].get(body.from_envelope, 0.0)
    data["balances"][body.from_envelope] = round(src - body.amount, 2)
    dst = data["balances"].get(body.to_envelope, 0.0)
    data["balances"][body.to_envelope] = round(dst + body.amount, 2)

    note = body.note or f"Transfer to {body.to_envelope}"
    data["history"].append({"date": today, "type": "transfer", "envelope": body.from_envelope, "amount": -body.amount, "note": note})
    data["history"].append({"date": today, "type": "transfer", "envelope": body.to_envelope, "amount": body.amount, "note": f"Transfer from {body.from_envelope}"})

    _save_env_data(data)
    _commit_env(f"envelopes: transfer ${body.amount:.2f} {body.from_envelope}->{body.to_envelope}")
    return {"status": "ok", "balances": data["balances"]}


# ---------------------------------------------------------------------------
# POST /envelopes/adjust — manual correction
# ---------------------------------------------------------------------------

class EnvAdjust(BaseModel):
    envelope: str
    amount: float
    note: str | None = None


@app.post("/envelopes/adjust")
def envelope_adjust(body: EnvAdjust, token: str = Security(verify_token)):
    data = _load_env_data()
    today = _date.today().isoformat()
    cur = data["balances"].get(body.envelope, 0.0)
    data["balances"][body.envelope] = round(cur + body.amount, 2)
    data["history"].append({"date": today, "type": "adjustment", "envelope": body.envelope, "amount": body.amount, "note": body.note or "Manual adjustment"})
    _save_env_data(data)
    _commit_env(f"envelopes: adjust {body.envelope} {body.amount:+.2f}")
    return {"status": "ok", "balance": data["balances"][body.envelope]}


# ---------------------------------------------------------------------------
# POST /envelopes/create — create a new envelope
# ---------------------------------------------------------------------------

class EnvCreate(BaseModel):
    name: str
    parent: str | None = None


@app.post("/envelopes/create")
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
    _save_env_data(data)
    _commit_env(f"envelopes: create {body.name}")
    return {"status": "ok", "envelope": new_env}


# ---------------------------------------------------------------------------
# DELETE /envelopes/{envelope_id} — delete an envelope (must have zero balance)
# ---------------------------------------------------------------------------

@app.delete("/envelopes/{envelope_id}")
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
    _save_env_data(data)
    _commit_env(f"envelopes: delete {envelope_id}")
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Transaction Inbox — staging area for bank-alert transactions
# ---------------------------------------------------------------------------

_inbox_lock = threading.Lock()

INBOX_MAX_PENDING = 200
INBOX_SEEN_IDS_MAX = 200
INBOX_MATCH_WINDOW_DAYS = 2
INBOX_FALLBACK_ACCOUNT = "expenses:uncategorized"
INBOX_UNKNOWN_CARD_ACCOUNT = "liabilities:creditcard:CIBC"

_MERCHANT_PREFIXES = (
    "SQ *", "SQ*", "TST-", "TST*", "TST ",
    "PAYPAL *", "PAYPAL*", "PY *", "SP ", "APLPAY ",
)


def _default_inbox_data() -> dict:
    return {"items": [], "seen_message_ids": [], "merchant_rules": [], "card_map": {}}


def _load_inbox_data() -> dict:
    if not INBOX_DATA_FILE:
        raise HTTPException(status_code=503, detail="INBOX_DATA_FILE not configured. Set it in .env")
    if not os.path.exists(INBOX_DATA_FILE):
        raise HTTPException(status_code=503, detail=f"Inbox data file not found: {INBOX_DATA_FILE}")
    with open(INBOX_DATA_FILE) as f:
        data = _json.load(f)
    for key, default in _default_inbox_data().items():
        data.setdefault(key, default)
    return data


def _save_inbox_data(data: dict):
    data["seen_message_ids"] = data.get("seen_message_ids", [])[-INBOX_SEEN_IDS_MAX:]
    with open(INBOX_DATA_FILE, "w") as f:
        _json.dump(data, f, indent=2)


def _commit_inbox(message: str):
    run_git("add", INBOX_DATA_FILE)
    run_git("commit", "-m", f"{message}\n\nSource: hledger-mobile-api")
    run_git("push")


def _clean_merchant(raw: str) -> str:
    """Strip payment-processor prefixes and trailing store numbers from a
    bank merchant descriptor, e.g. 'TST-The Samosa Factory' -> 'The Samosa Factory'."""
    s = raw.strip()
    upper = s.upper()
    for prefix in _MERCHANT_PREFIXES:
        if upper.startswith(prefix):
            s = s[len(prefix):].strip()
            break
    s = _re.sub(r"[#\s][\d-]{3,}$", "", s).strip()
    return s or raw.strip()


def _merchant_tokens(s: str) -> set:
    return {t for t in _re.split(r"[^a-z0-9]+", s.lower()) if len(t) >= 3}


def _journal_txns() -> list:
    try:
        return _json.loads(run_hledger("print", "--output-format", "json"))
    except _json.JSONDecodeError:
        return []


def _history_match(merchant_clean: str, txns: list):
    """Find the best past transaction matching a merchant descriptor.
    Returns (description, expense_account, matched_on) or None."""
    target = merchant_clean.lower()
    tokens = _merchant_tokens(merchant_clean)
    best = None  # (score, description, account)
    for txn in reversed(txns):  # most recent first
        desc = txn.get("tdescription", "").strip()
        if not desc:
            continue
        acct = next(
            (p.get("paccount", "") for p in txn.get("tpostings", [])
             if p.get("paccount", "").startswith("expenses")),
            None,
        )
        if not acct:
            continue
        if desc.lower() == target:
            return desc, acct, "history:exact"
        if tokens:
            overlap = len(tokens & _merchant_tokens(desc)) / len(tokens)
            if overlap >= 0.5 and (best is None or overlap > best[0]):
                best = (overlap, desc, acct)
    if best:
        return best[1], best[2], "history:tokens"
    return None


def _suggest_inbox_posting(merchant_raw: str, amount: float, card_last4: str, data: dict, txns: list) -> dict:
    merchant_clean = _clean_merchant(merchant_raw)
    account2 = data.get("card_map", {}).get(card_last4)
    card_known = account2 is not None
    if not card_known:
        account2 = INBOX_UNKNOWN_CARD_ACCOUNT

    description = merchant_clean
    account1 = INBOX_FALLBACK_ACCOUNT
    confidence = "low"
    matched_on = "fallback"

    upper = merchant_raw.upper()
    rule = next(
        (r for r in data.get("merchant_rules", [])
         if r.get("pattern") and r["pattern"].upper() in upper),
        None,
    )
    if rule:
        account1 = rule.get("account", INBOX_FALLBACK_ACCOUNT)
        description = rule.get("description") or merchant_clean
        confidence = "high"
        matched_on = "rule"
    else:
        hist = _history_match(merchant_clean, txns)
        if hist:
            description, account1, matched_on = hist
            confidence = "high" if matched_on == "history:exact" else "medium"

    if not card_known:
        confidence = "low"

    return {
        "description": description,
        "account1": account1,
        "amount1": round(amount, 2),
        "account2": account2,
        "amount2": round(-amount, 2),
        "confidence": confidence,
        "matched_on": matched_on,
    }


def _find_journal_match(txns: list, amount: float, txn_date: str):
    """Look for a journal transaction with the same amount within
    INBOX_MATCH_WINDOW_DAYS of txn_date (the 'already posted from the Mac' case)."""
    try:
        center = _date.fromisoformat(txn_date)
    except ValueError:
        return None
    target = round(abs(amount), 2)
    if target == 0:
        return None
    for txn in reversed(txns):
        try:
            d = _date.fromisoformat(txn.get("tdate", ""))
        except ValueError:
            continue
        if abs((d - center).days) > INBOX_MATCH_WINDOW_DAYS:
            continue
        for p in txn.get("tpostings", []):
            if round(abs(_extract_amount(p)), 2) == target:
                return {"date": txn.get("tdate", ""), "description": txn.get("tdescription", "")}
    return None


class InboxIngest(BaseModel):
    amount: float
    merchant: str
    card_last4: str = ""
    txn_date: str = ""
    email_message_id: str = ""
    raw_subject: str = ""
    bank: str = ""
    parsed: bool = True


@app.post("/inbox/ingest")
def inbox_ingest(body: InboxIngest, token: str = Security(verify_token)):
    """
    Called by the Worker email handler when a bank alert arrives.
    Dedupes (message id, pending items, journal), generates a suggested
    posting, and stores the item as pending.
    """
    if abs(body.amount) > 1_000_000:
        raise HTTPException(status_code=400, detail="amount out of range")
    if body.parsed and round(body.amount, 2) == 0:
        raise HTTPException(status_code=400, detail="amount required for parsed alerts")
    merchant = body.merchant.strip()[:200]
    if not merchant:
        raise HTTPException(status_code=400, detail="merchant required")
    txn_date = body.txn_date.strip()
    try:
        center = _date.fromisoformat(txn_date)
    except ValueError:
        center = _date.today()
        txn_date = center.isoformat()

    with _inbox_lock:
        data = _load_inbox_data()

        msg_id = body.email_message_id.strip()[:200]
        if msg_id and msg_id in data["seen_message_ids"]:
            return {"status": "duplicate", "reason": "message_id"}

        # Same amount + card within the window already pending
        for item in data["items"]:
            if (
                item.get("card_last4") == body.card_last4
                and round(item.get("amount", 0), 2) == round(body.amount, 2)
            ):
                try:
                    d = _date.fromisoformat(item.get("txn_date", ""))
                except ValueError:
                    continue
                if abs((d - center).days) <= INBOX_MATCH_WINDOW_DAYS:
                    if msg_id:
                        data["seen_message_ids"].append(msg_id)
                        _save_inbox_data(data)
                    return {"status": "duplicate", "reason": "pending"}

        if len(data["items"]) >= INBOX_MAX_PENDING:
            raise HTTPException(status_code=429, detail="Inbox full")

        txns = _journal_txns()

        # Already posted manually (e.g. from the Mac) before the alert landed
        if body.parsed and _find_journal_match(txns, body.amount, txn_date):
            if msg_id:
                data["seen_message_ids"].append(msg_id)
                _save_inbox_data(data)
            return {"status": "duplicate", "reason": "journal"}

        item = {
            "id": f"ibx-{_uuid.uuid4().hex[:6]}",
            "source": "email",
            "received_at": _datetime.now(_timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "txn_date": txn_date,
            "amount": round(body.amount, 2),
            "currency": DEFAULT_CURRENCY,
            "merchant_raw": merchant,
            "merchant_clean": _clean_merchant(merchant),
            "card_last4": body.card_last4.strip()[:4],
            "email_message_id": msg_id,
            "raw_subject": body.raw_subject.strip()[:300],
            "bank": body.bank.strip()[:40],
            "parsed": body.parsed,
            "suggestion": _suggest_inbox_posting(merchant, body.amount, body.card_last4, data, txns),
        }
        data["items"].append(item)
        if msg_id:
            data["seen_message_ids"].append(msg_id)
        _save_inbox_data(data)
        _commit_inbox(f"inbox: ingest {item['merchant_clean'][:40]} {txn_date}")

    return {"status": "ok", "id": item["id"]}


@app.get("/inbox")
def get_inbox(token: str = Security(verify_token)):
    """Pending items, newest first, each with a live journal match check."""
    with _inbox_lock:
        data = _load_inbox_data()
        items = [dict(i) for i in data["items"]]
    txns = _journal_txns() if items else []
    for item in items:
        item["journal_match"] = (
            _find_journal_match(txns, item.get("amount", 0), item.get("txn_date", ""))
            if item.get("parsed", True)
            else None
        )
    items.sort(key=lambda i: i.get("received_at", ""), reverse=True)
    return {"items": items, "pending": len(items)}


@app.get("/inbox/count")
def get_inbox_count(token: str = Security(verify_token)):
    with _inbox_lock:
        data = _load_inbox_data()
    return {"pending": len(data["items"])}


class InboxPostBody(BaseModel):
    id: str
    raw_entry: str | None = None


@app.post("/inbox/post")
def inbox_post(body: InboxPostBody, token: str = Security(verify_token)):
    """
    Post an inbox item to the journal — the stored suggestion by default,
    or the user-edited raw_entry. Removes the item; one commit covers both
    the journal append and the inbox file.
    """
    with _inbox_lock:
        data = _load_inbox_data()
        item = next((i for i in data["items"] if i["id"] == body.id), None)
        if not item:
            raise HTTPException(status_code=404, detail="Inbox item not found")

        if body.raw_entry:
            entry = "\n" + body.raw_entry.strip() + "\n"
        else:
            s = item.get("suggestion") or {}
            if not s.get("account1"):
                raise HTTPException(status_code=400, detail="Item has no suggestion — post with raw_entry")
            cur = item.get("currency", DEFAULT_CURRENCY)
            entry = (
                f"\n{item['txn_date']} {s['description']}\n"
                f"    {s['account1']}    {cur}{s['amount1']:.2f}\n"
                f"    {s['account2']}    {cur}{s['amount2']:.2f}\n"
            )

        try:
            with open(JOURNAL_FILE, "a") as f:
                f.write(entry)
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"Could not write to journal: {e}")

        data["items"] = [i for i in data["items"] if i["id"] != body.id]
        _save_inbox_data(data)

        run_git("add", JOURNAL_FILE, INBOX_DATA_FILE)
        run_git(
            "commit", "-m",
            f"add: {item['merchant_clean'][:40]} {item['txn_date']} (inbox)\n\nSource: hledger-mobile-api",
        )
        run_git("push")

    return {"status": "ok", "entry": entry.strip()}


class InboxDismissBody(BaseModel):
    id: str


@app.post("/inbox/dismiss")
def inbox_dismiss(body: InboxDismissBody, token: str = Security(verify_token)):
    """Dismiss (delete) an inbox item. Nothing touches the journal."""
    with _inbox_lock:
        data = _load_inbox_data()
        item = next((i for i in data["items"] if i["id"] == body.id), None)
        if not item:
            raise HTTPException(status_code=404, detail="Inbox item not found")
        data["items"] = [i for i in data["items"] if i["id"] != body.id]
        _save_inbox_data(data)
        _commit_inbox(f"inbox: dismiss {item['merchant_clean'][:40]}")
    return {"status": "ok"}


class InboxRuleBody(BaseModel):
    pattern: str
    account: str
    description: str


@app.post("/inbox/rule")
def inbox_add_rule(body: InboxRuleBody, token: str = Security(verify_token)):
    """
    Save (or replace) a merchant rule from the app's "Remember merchant"
    action. Future alerts whose merchant contains `pattern` get this
    account and description at high confidence.
    """
    pattern = body.pattern.strip()[:100]
    account = body.account.strip()[:100]
    description = body.description.strip()[:100]
    if not pattern or not account or not description:
        raise HTTPException(status_code=400, detail="pattern, account, and description required")

    with _inbox_lock:
        data = _load_inbox_data()
        rules = [r for r in data.get("merchant_rules", []) if r.get("pattern", "").upper() != pattern.upper()]
        rules.append({"pattern": pattern, "account": account, "description": description})
        data["merchant_rules"] = rules
        _save_inbox_data(data)
        _commit_inbox(f"inbox: rule {pattern[:40]} -> {account[:40]}")
    return {"status": "ok", "rules": len(rules)}