import json

from fastapi import APIRouter, HTTPException, Security

from ..auth import verify_token
from ..config import get_settings
from ..git_ops import git_transaction, run_git
from ..hledger import extract_amount, run_hledger
from ..models import Transaction

router = APIRouter()


@router.post("/add")
def add_transaction(tx: Transaction, token: str = Security(verify_token)):
    """
    Append a transaction to the journal, commit, and push.
    Commits are tagged with 'Source: hledger-mobile-api' trailer
    so they can be identified and filtered in git log.
    """
    settings = get_settings()

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

    desc_label = tx.description or "transaction"
    date_label = tx.date or "unknown"
    commit_message = f"add: {desc_label} {date_label}"

    with git_transaction([settings.journal_file], commit_message):
        try:
            with open(settings.journal_file, "a") as f:
                f.write(entry)
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"Could not write to journal: {e}")

    return {"status": "ok", "entry": entry.strip()}


@router.get("/descriptions")
def get_descriptions(token: str = Security(verify_token)):
    """All unique transaction descriptions, sorted by most recent first."""
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


@router.get("/lookup")
def lookup_description(description: str, token: str = Security(verify_token)):
    """
    Given a description, return the most recent matching transaction's
    account1, amount1, account2, amount2 for pre-filling the add form.
    """
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
                return {"match": {
                    "account1": postings[0].get("paccount", ""),
                    "amount1": extract_amount(postings[0]),
                    "account2": postings[1].get("paccount", ""),
                    "amount2": extract_amount(postings[1]),
                }}
    return {"match": None}


@router.post("/sync")
def sync(token: str = Security(verify_token)):
    """Pull latest journal from git remote."""
    output = run_git("pull")
    return {"status": "ok", "detail": output.strip()}
