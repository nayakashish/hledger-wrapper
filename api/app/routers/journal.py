from fastapi import APIRouter, HTTPException, Security

from ..auth import verify_token
from ..config import get_settings
from ..git_ops import git_revert_head, git_transaction, run_git
from ..models import Transaction, UndoBody
from ..prediction import load_transactions, match_by_description
from .inbox import _inbox_lock

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

    with git_transaction([settings.journal_file], commit_message) as commit:
        try:
            with open(settings.journal_file, "a") as f:
                f.write(entry)
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"Could not write to journal: {e}")

    return {"status": "ok", "entry": entry.strip(), "commit": commit.sha}


@router.post("/undo")
def undo(body: UndoBody, token: str = Security(verify_token)):
    """
    Revert the save that returned `commit`, as long as nothing has been
    written since. An inbox post's commit holds the journal and inbox.json,
    so its revert also puts the alert back in the inbox; the inbox lock
    keeps an ingest from saving over that.
    """
    with _inbox_lock:
        subject = git_revert_head(body.commit)
    return {"status": "ok", "inbox": subject.endswith("(inbox)")}


@router.get("/descriptions")
def get_descriptions(token: str = Security(verify_token)):
    """All unique transaction descriptions, sorted by most recent first."""
    txns = load_transactions()
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
    return {"match": match_by_description(description)}


@router.post("/sync")
def sync(token: str = Security(verify_token)):
    """Pull latest journal from git remote."""
    output = run_git("pull")
    return {"status": "ok", "detail": output.strip()}
