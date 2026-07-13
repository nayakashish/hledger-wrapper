import json
import os
import re
import threading
import uuid
from datetime import date, datetime, timezone

from fastapi import APIRouter, HTTPException, Security

from ..auth import verify_token
from ..config import get_settings
from ..git_ops import git_transaction
from ..hledger import extract_amount, run_hledger
from ..models import InboxDismissBody, InboxIngest, InboxPostBody, InboxRuleBody
from ..storage import load_json, save_json

router = APIRouter()

# Serializes read-modify-write access to the inbox JSON store across requests
# (the git lock in git_ops only covers the git-side commit/push race).
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
    settings = get_settings()
    if not settings.inbox_data_file:
        raise HTTPException(status_code=503, detail="INBOX_DATA_FILE not configured. Set it in .env")
    if not os.path.exists(settings.inbox_data_file):
        raise HTTPException(status_code=503, detail=f"Inbox data file not found: {settings.inbox_data_file}")
    data = load_json(settings.inbox_data_file)
    for key, default in _default_inbox_data().items():
        data.setdefault(key, default)
    return data


def _save_inbox_data(data: dict) -> None:
    settings = get_settings()
    data["seen_message_ids"] = data.get("seen_message_ids", [])[-INBOX_SEEN_IDS_MAX:]
    save_json(settings.inbox_data_file, data)


def _clean_merchant(raw: str) -> str:
    """Strip payment-processor prefixes and trailing store numbers from a
    bank merchant descriptor, e.g. 'TST-The Samosa Factory' -> 'The Samosa Factory'."""
    s = raw.strip()
    upper = s.upper()
    for prefix in _MERCHANT_PREFIXES:
        if upper.startswith(prefix):
            s = s[len(prefix):].strip()
            break
    s = re.sub(r"[#\s][\d-]{3,}$", "", s).strip()
    return s or raw.strip()


def _merchant_tokens(s: str) -> set:
    return {t for t in re.split(r"[^a-z0-9]+", s.lower()) if len(t) >= 3}


def _journal_txns() -> list:
    try:
        return json.loads(run_hledger("print", "--output-format", "json"))
    except json.JSONDecodeError:
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
        center = date.fromisoformat(txn_date)
    except ValueError:
        return None
    target = round(abs(amount), 2)
    if target == 0:
        return None
    for txn in reversed(txns):
        try:
            d = date.fromisoformat(txn.get("tdate", ""))
        except ValueError:
            continue
        if abs((d - center).days) > INBOX_MATCH_WINDOW_DAYS:
            continue
        for p in txn.get("tpostings", []):
            if round(abs(extract_amount(p)), 2) == target:
                return {"date": txn.get("tdate", ""), "description": txn.get("tdescription", "")}
    return None


@router.post("/inbox/ingest")
def inbox_ingest(body: InboxIngest, token: str = Security(verify_token)):
    """
    Called by the Worker email handler when a bank alert arrives.
    Dedupes (message id, pending items, journal), generates a suggested
    posting, and stores the item as pending.
    """
    settings = get_settings()
    if abs(body.amount) > 1_000_000:
        raise HTTPException(status_code=400, detail="amount out of range")
    if body.parsed and round(body.amount, 2) == 0:
        raise HTTPException(status_code=400, detail="amount required for parsed alerts")
    merchant = body.merchant.strip()[:200]
    if not merchant:
        raise HTTPException(status_code=400, detail="merchant required")
    txn_date = body.txn_date.strip()
    try:
        center = date.fromisoformat(txn_date)
    except ValueError:
        center = date.today()
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
                    d = date.fromisoformat(item.get("txn_date", ""))
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
            "id": f"ibx-{uuid.uuid4().hex[:6]}",
            "source": "email",
            "received_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "txn_date": txn_date,
            "amount": round(body.amount, 2),
            "currency": settings.default_currency,
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

        with git_transaction([settings.inbox_data_file], f"inbox: ingest {item['merchant_clean'][:40]} {txn_date}"):
            _save_inbox_data(data)

    return {"status": "ok", "id": item["id"]}


@router.get("/inbox")
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


@router.get("/inbox/count")
def get_inbox_count(token: str = Security(verify_token)):
    with _inbox_lock:
        data = _load_inbox_data()
    return {"pending": len(data["items"])}


@router.post("/inbox/post")
def inbox_post(body: InboxPostBody, token: str = Security(verify_token)):
    """
    Post an inbox item to the journal — the stored suggestion by default,
    or the user-edited raw_entry. Removes the item; one commit covers both
    the journal append and the inbox file.
    """
    settings = get_settings()
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
            cur = item.get("currency", settings.default_currency)
            entry = (
                f"\n{item['txn_date']} {s['description']}\n"
                f"    {s['account1']}    {cur}{s['amount1']:.2f}\n"
                f"    {s['account2']}    {cur}{s['amount2']:.2f}\n"
            )

        data["items"] = [i for i in data["items"] if i["id"] != body.id]

        with git_transaction(
            [settings.journal_file, settings.inbox_data_file],
            f"add: {item['merchant_clean'][:40]} {item['txn_date']} (inbox)",
        ):
            try:
                with open(settings.journal_file, "a") as f:
                    f.write(entry)
            except OSError as e:
                raise HTTPException(status_code=500, detail=f"Could not write to journal: {e}")
            _save_inbox_data(data)

    return {"status": "ok", "entry": entry.strip()}


@router.post("/inbox/dismiss")
def inbox_dismiss(body: InboxDismissBody, token: str = Security(verify_token)):
    """Dismiss (delete) an inbox item. Nothing touches the journal."""
    settings = get_settings()
    with _inbox_lock:
        data = _load_inbox_data()
        item = next((i for i in data["items"] if i["id"] == body.id), None)
        if not item:
            raise HTTPException(status_code=404, detail="Inbox item not found")
        data["items"] = [i for i in data["items"] if i["id"] != body.id]

        with git_transaction([settings.inbox_data_file], f"inbox: dismiss {item['merchant_clean'][:40]}"):
            _save_inbox_data(data)

    return {"status": "ok"}


@router.post("/inbox/rule")
def inbox_add_rule(body: InboxRuleBody, token: str = Security(verify_token)):
    """
    Save (or replace) a merchant rule from the app's "Remember merchant"
    action. Future alerts whose merchant contains `pattern` get this
    account and description at high confidence.
    """
    settings = get_settings()
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

        with git_transaction([settings.inbox_data_file], f"inbox: rule {pattern[:40]} -> {account[:40]}"):
            _save_inbox_data(data)

    return {"status": "ok", "rules": len(rules)}
