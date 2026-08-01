import json
from datetime import date

from fastapi import APIRouter, HTTPException, Security

from ..auth import verify_token
from ..config import get_settings
from ..hledger import run_hledger, run_hledger_file

router = APIRouter()


@router.get("/balance")
def get_balance(token: str = Security(verify_token)):
    """All account balances."""
    output = run_hledger("balance", "--output-format", "json")
    return {"raw": output}


@router.get("/is")
def get_income_statement(token: str = Security(verify_token)):
    """Income statement."""
    output = run_hledger("is", "--output-format", "json")
    return {"raw": output}


@router.get("/monthly")
def get_monthly(token: str = Security(verify_token)):
    """Monthly balance breakdown at depth 2 (top two account levels)."""
    output = run_hledger("balance", "--monthly", "--depth", "2", "--output-format", "json")
    return {"raw": output}


@router.get("/monthly-detail")
def get_monthly_detail(token: str = Security(verify_token)):
    """Monthly balance breakdown at full account depth (for sub-account charts)."""
    output = run_hledger("balance", "--monthly", "--output-format", "json")
    return {"raw": output}


@router.get("/transactions")
def get_transactions(month: str = None, token: str = Security(verify_token)):
    """
    Transactions for a given month (YYYY-MM). If no month given, returns current month.
    hledger date filter: YYYY-MM-01..YYYY-MM+1-01
    """
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


@router.get("/search")
def search_transactions(q: str, token: str = Security(verify_token)):
    """
    Full-text search across all transactions (description, payee, account names).
    Returns matching transactions sorted most recent first.
    Uses hledger's built-in description/account search via `print`.
    Falls back to in-process filtering for broader matching.
    """
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


@router.get("/accounts")
def get_accounts(token: str = Security(verify_token)):
    """
    Chart of accounts. When ACCOUNTS_FILE is set (a journal of `account`
    directives, e.g. 2026accounts.journal), returns the declared accounts —
    the authoritative CoA. Otherwise falls back to accounts used in the
    journal. Used for autocomplete and the Reports CoA view.
    """
    settings = get_settings()
    if settings.accounts_file:
        output = run_hledger_file(settings.accounts_file, "accounts", "--declared")
    else:
        output = run_hledger("accounts")
    accounts = [line.strip() for line in output.splitlines() if line.strip()]
    return {"accounts": accounts}


@router.get("/daily-totals")
def get_daily_totals(from_date: str = None, token: str = Security(verify_token)):
    """
    Returns transaction counts and absolute totals per day from from_date to today.
    Defaults to Jan 1 of the current year.
    Response: [{ date: "YYYY-MM-DD", count: int, total: float }, ...]
    """
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
