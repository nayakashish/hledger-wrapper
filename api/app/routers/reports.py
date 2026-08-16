import json
import re
from datetime import date

from fastapi import APIRouter, HTTPException, Query, Security

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
def search_transactions(
    q: str = "",
    from_date: str = "",
    to_date: str = "",
    period: str = "",
    account: list[str] = Query(default=[]),
    token: str = Security(verify_token),
):
    """
    Search transactions by free text and/or structured filters.

    Date range (from_date/to_date, or a named period like "thismonth") and
    account/category (one or more `account` values, OR'd together) are
    pushed down to `hledger` itself via `-p`/`acct:` query args, so the
    subprocess only has to parse and emit the already-narrowed subset.
    Free text (`q`) is then substring-matched in Python across description,
    payee, note, comments, and account names on whatever `hledger` returned
    — comments specifically have no hledger query equivalent (`tag:` only
    matches structured tag:value pairs, not arbitrary comment text), so this
    stays in Python rather than trying to push it down too.
    """
    query = q.strip()
    accounts = [a.strip() for a in account if a.strip()]
    from_date = from_date.strip()
    to_date = to_date.strip()
    period = period.strip()

    if not query and not from_date and not to_date and not period and not accounts:
        return {"raw": "[]"}

    args = ["print", "--output-format", "json"]
    if period:
        args += ["-p", period]
    elif from_date or to_date:
        args += ["-p", f"{from_date}..{to_date}"]
    for acct in accounts:
        args.append(f"acct:{re.escape(acct)}")

    output = run_hledger(*args)
    try:
        txns = json.loads(output)
    except json.JSONDecodeError:
        return {"raw": "[]"}

    if not query:
        matches = list(reversed(txns))  # most recent first
    else:
        ql = query.lower()
        matches = []
        for txn in reversed(txns):  # most recent first
            desc = txn.get("tdescription", "").lower()
            payee = txn.get("tpayee", "").lower()
            note = txn.get("tnote", "").lower()
            postings = txn.get("tpostings", [])
            acct_names = [p.get("paccount", "").lower() for p in postings]
            comments = [p.get("pcomment", "").lower() for p in postings]
            tcomment = txn.get("tcomment", "").lower()

            haystack = " ".join([desc, payee, note, tcomment] + acct_names + comments)
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
