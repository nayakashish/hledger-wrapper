import os
import subprocess
from datetime import date
from functools import wraps

from fastapi import FastAPI, HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

JOURNAL_DIR = os.getenv("JOURNAL_DIR", "")
JOURNAL_FILE = os.getenv("JOURNAL_FILE", "")
HLEDGER_BIN = os.getenv("HLEDGER_BIN", "hledger")
BEARER_TOKEN = os.getenv("BEARER_TOKEN", "")
DEFAULT_CURRENCY = os.getenv("DEFAULT_CURRENCY", "$")

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
    date: str           # YYYY-MM-DD
    description: str
    account1: str
    amount1: float
    account2: str
    amount2: float | None = None   # auto-calculated if omitted
    currency: str = DEFAULT_CURRENCY


@app.post("/add")
def add_transaction(tx: Transaction, token: str = Security(verify_token)):
    """
    Append a transaction to the journal, commit, and push.
    Commits are tagged with 'Source: hledger-mobile-api' trailer
    so they can be identified and filtered in git log.
    """
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

    commit_message = (
        f"add: {tx.description} {tx.date}\n\n"
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