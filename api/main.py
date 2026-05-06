import os
import subprocess
from datetime import date
from functools import wraps

from fastapi import FastAPI, HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import json as _json
from datetime import date as _date
import uuid as _uuid

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

JOURNAL_DIR = os.getenv("JOURNAL_DIR", "")
JOURNAL_FILE = os.getenv("JOURNAL_FILE", "")
HLEDGER_BIN = os.getenv("HLEDGER_BIN", "hledger")
BEARER_TOKEN = os.getenv("BEARER_TOKEN", "")
DEFAULT_CURRENCY = os.getenv("DEFAULT_CURRENCY", "$")
ENVELOPE_CONFIG_FILE = os.getenv("ENVELOPE_CONFIG_FILE", "")
ENVELOPE_DATA_FILE   = os.getenv("ENVELOPE_DATA_FILE", "")
ENVELOPE_DATA_FILE = os.getenv("ENVELOPE_DATA_FILE", "")

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
    cmd = [HLEDGER_BIN, "-f", JOURNAL_FILE, *args]
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
    """Monthly balance breakdown."""
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
    """All account names. Used for autocomplete in the frontend."""
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