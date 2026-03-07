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
def get_transactions(limit: int = 50, token: str = Security(verify_token)):
    """Recent transactions, most recent first. Default last 50."""
    import json
    output = run_hledger("print", "--output-format", "json")
    try:
        all_txns = json.loads(output)
        recent = all_txns[-limit:]
        recent.reverse()
        return {"raw": json.dumps(recent)}
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
    # Calculate amount2 if not provided
    amount2 = tx.amount2 if tx.amount2 is not None else -tx.amount1

    # Format as a valid hledger journal entry
    entry = (
        f"\n{tx.date} {tx.description}\n"
        f"    {tx.account1}    {tx.currency}{tx.amount1:.2f}\n"
        f"    {tx.account2}    {tx.currency}{amount2:.2f}\n"
    )

    # Find the journal file — looks for the first .journal or .ledger file
    journal_file = _find_journal_file()

    # Append to journal
    try:
        with open(journal_file, "a") as f:
            f.write(entry)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Could not write to journal: {e}")

    # Commit with source tag so we can identify mobile-added entries in git log
    commit_message = (
        f"add: {tx.description} {tx.date}\n\n"
        f"Source: hledger-mobile-api"
    )

    run_git("add", journal_file)
    run_git("commit", "-m", commit_message)
    run_git("push")

    return {"status": "ok", "entry": entry.strip()}


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