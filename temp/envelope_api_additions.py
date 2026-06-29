# ---------------------------------------------------------------------------
# Envelope endpoints
# ---------------------------------------------------------------------------
# Add these imports to the top of main.py:
#   import json as _json  (json is already imported inline in some endpoints)
#
# Add these env vars to .env:
#   ENVELOPE_CONFIG_FILE=/home/server/repos/2026.ledger/envelope_config.json
#   ENVELOPE_DATA_FILE=/home/server/repos/2026.ledger/envelopes.json

import json

ENVELOPE_CONFIG_FILE = os.getenv("ENVELOPE_CONFIG_FILE", "")
ENVELOPE_DATA_FILE   = os.getenv("ENVELOPE_DATA_FILE", "")


def _load_envelope_config():
    if not ENVELOPE_CONFIG_FILE or not os.path.exists(ENVELOPE_CONFIG_FILE):
        raise HTTPException(status_code=503, detail="Envelope config not found")
    with open(ENVELOPE_CONFIG_FILE) as f:
        return json.load(f)


def _load_envelope_data():
    if not ENVELOPE_DATA_FILE or not os.path.exists(ENVELOPE_DATA_FILE):
        raise HTTPException(status_code=503, detail="Envelope data not found")
    with open(ENVELOPE_DATA_FILE) as f:
        return json.load(f)


def _save_envelope_data(data: dict):
    if not ENVELOPE_DATA_FILE:
        raise HTTPException(status_code=503, detail="Envelope data file not configured")
    with open(ENVELOPE_DATA_FILE, "w") as f:
        json.dump(data, f, indent=2)


def _commit_envelopes(message: str):
    run_git("add", ENVELOPE_DATA_FILE)
    run_git("commit", "-m", f"{message}\n\nSource: hledger-mobile-api")
    run_git("push")


# -- GET /envelopes -----------------------------------------------------------

@app.get("/envelopes")
def get_envelopes(token: str = Security(verify_token)):
    """
    Returns merged config + live balances + recent history.
    The UI uses this as its single data source for the envelopes tab.
    """
    config = _load_envelope_config()
    data   = _load_envelope_data()

    balances = data.get("balances", {})
    history  = data.get("history", [])

    # Attach balances to each envelope definition
    envelopes = []
    for env in config["envelopes"]:
        eid = env["id"]
        envelopes.append({
            **env,
            "balance": round(balances.get(eid, 0.0), 2),
            "history": [h for h in history if h.get("envelope") == eid][-20:]
        })

    return {
        "income_split_default": config.get("income_split_default", {}),
        "envelopes": envelopes,
        "matched_hledger_txns": data.get("matched_hledger_txns", [])
    }


# -- GET /envelopes/config -----------------------------------------------------

@app.get("/envelopes/config")
def get_envelopes_config(token: str = Security(verify_token)):
    """Read-only view of envelope_config.json for display in app."""
    config = _load_envelope_config()
    return config


# -- POST /envelopes/allocate --------------------------------------------------

class AllocateIncome(BaseModel):
    amount: float
    date: str | None = None          # YYYY-MM-DD, defaults to today
    note: str | None = None
    splits: dict | None = None       # override: {"savings": 1200, "chequing": 1500, "tithe": 300}


@app.post("/envelopes/allocate")
def allocate_income(body: AllocateIncome, token: str = Security(verify_token)):
    """
    Allocate an income event across envelopes.
    Uses income_split_default unless splits override provided.
    Tithe is calculated as income_pct of gross amount, deducted from chequing.
    """
    config = _load_envelope_config()
    data   = _load_envelope_data()

    defaults = config.get("income_split_default", {})
    today = body.date or date.today().isoformat()
    gross = body.amount

    if body.splits:
        splits = body.splits
    else:
        tithe_amt   = round(gross * defaults.get("tithe_pct", 0.10), 2)
        savings_amt = round(gross * defaults.get("savings", 0.40), 2)
        cheq_gross  = round(gross * defaults.get("chequing", 0.50), 2)
        cheq_amt    = round(cheq_gross - tithe_amt, 2)  # tithe comes out of chequing
        splits = {
            "savings": savings_amt,
            "chequing": cheq_amt,
            "tithe": tithe_amt,
        }

    history_entries = []
    for eid, amt in splits.items():
        if amt == 0:
            continue
        before = data["balances"].get(eid, 0.0)
        data["balances"][eid] = round(before + amt, 2)
        entry = {
            "date": today,
            "type": "income_allocation",
            "envelope": eid,
            "amount": amt,
            "note": body.note or f"Income ${gross:.2f}"
        }
        data["history"].append(entry)
        history_entries.append(entry)

    _save_envelope_data(data)
    _commit_envelopes(f"envelopes: allocate income ${gross:.2f} on {today}")

    return {"status": "ok", "splits": splits, "entries": history_entries}


# -- POST /envelopes/transfer --------------------------------------------------

class EnvelopeTransfer(BaseModel):
    from_envelope: str
    to_envelope: str | None = None   # None = "paid out" (drains to zero or by amount)
    amount: float
    date: str | None = None
    note: str | None = None


@app.post("/envelopes/transfer")
def envelope_transfer(body: EnvelopeTransfer, token: str = Security(verify_token)):
    """
    Transfer between envelopes, or mark a payment made (to_envelope=None drains from source).
    """
    data  = _load_envelope_data()
    today = body.date or date.today().isoformat()

    src_bal = data["balances"].get(body.from_envelope, 0.0)
    if body.amount > src_bal + 0.001:
        raise HTTPException(status_code=400, detail=f"Insufficient balance in {body.from_envelope}: ${src_bal:.2f}")

    data["balances"][body.from_envelope] = round(src_bal - body.amount, 2)
    entry_from = {
        "date": today,
        "type": "transfer_out" if body.to_envelope else "payment",
        "envelope": body.from_envelope,
        "amount": -body.amount,
        "note": body.note or (f"Transfer to {body.to_envelope}" if body.to_envelope else "Payment made")
    }
    data["history"].append(entry_from)

    if body.to_envelope:
        dst_bal = data["balances"].get(body.to_envelope, 0.0)
        data["balances"][body.to_envelope] = round(dst_bal + body.amount, 2)
        entry_to = {
            "date": today,
            "type": "transfer_in",
            "envelope": body.to_envelope,
            "amount": body.amount,
            "note": body.note or f"Transfer from {body.from_envelope}"
        }
        data["history"].append(entry_to)

    _save_envelope_data(data)
    action = f"transfer ${body.amount:.2f} {body.from_envelope}->{body.to_envelope or 'paid'}"
    _commit_envelopes(f"envelopes: {action} on {today}")

    return {"status": "ok", "balances": data["balances"]}


# -- POST /envelopes/match -----------------------------------------------------

@app.post("/envelopes/match")
def match_transactions(token: str = Security(verify_token)):
    """
    Scan recent hledger transactions and auto-match against envelope account prefixes.
    Matched transactions drain the relevant envelope.
    Already-matched txn IDs are stored in matched_hledger_txns to avoid double-counting.
    """
    import json as _json

    config = _load_envelope_config()
    data   = _load_envelope_data()

    already_matched = set(data.get("matched_hledger_txns", []))

    # Build prefix map: account_prefix -> envelope_id
    prefix_map = {}
    for env in config["envelopes"]:
        for acct in env.get("match_accounts", []):
            prefix_map[acct.lower()] = env["id"]

    if not prefix_map:
        return {"status": "ok", "matched": [], "message": "No account mappings configured"}

    # Fetch all transactions from hledger
    raw = run_hledger("print", "--output-format", "json")
    try:
        txns = _json.loads(raw)
    except _json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Could not parse hledger output")

    matched = []
    today = date.today().isoformat()

    for txn in txns:
        # Build a stable ID from date + description + index
        txn_id = f"{txn.get('tdate','')}|{txn.get('tdescription','')}|{txn.get('tindex', txn.get('tdate',''))}"

        if txn_id in already_matched:
            continue

        for posting in txn.get("tpostings", []):
            acct = posting.get("paccount", "").lower()

            matched_env = None
            for prefix, eid in prefix_map.items():
                if acct.startswith(prefix):
                    matched_env = eid
                    break

            if not matched_env:
                continue

            # Extract amount
            amounts = posting.get("pamount", [])
            if not amounts:
                continue
            a = amounts[0]
            q = a.get("aquantity", {})
            if isinstance(q, dict):
                amt = float(q.get("decimalMantissa", 0)) / (10 ** q.get("decimalPlaces", 0))
            else:
                amt = float(q or 0)

            if amt == 0:
                continue

            # Expenses are positive in hledger = drain from envelope
            drain = abs(amt)
            cur_bal = data["balances"].get(matched_env, 0.0)
            data["balances"][matched_env] = round(max(0.0, cur_bal - drain), 2)

            entry = {
                "date": txn.get("tdate", today),
                "type": "auto_match",
                "envelope": matched_env,
                "amount": -drain,
                "note": f"Auto: {txn.get('tdescription', acct)}"
            }
            data["history"].append(entry)
            already_matched.add(txn_id)
            matched.append({
                "txn_id": txn_id,
                "envelope": matched_env,
                "amount": drain,
                "description": txn.get("tdescription", ""),
                "date": txn.get("tdate", "")
            })
            break  # one posting per txn matched to one envelope

    data["matched_hledger_txns"] = list(already_matched)
    _save_envelope_data(data)

    if matched:
        _commit_envelopes(f"envelopes: auto-matched {len(matched)} transaction(s) on {today}")

    return {"status": "ok", "matched": matched, "count": len(matched)}


# -- POST /envelopes/adjust ----------------------------------------------------

class EnvelopeAdjust(BaseModel):
    envelope: str
    amount: float      # positive = add, negative = subtract
    note: str | None = None
    date: str | None = None


@app.post("/envelopes/adjust")
def adjust_envelope(body: EnvelopeAdjust, token: str = Security(verify_token)):
    """Manual balance adjustment for corrections."""
    data  = _load_envelope_data()
    today = body.date or date.today().isoformat()

    cur = data["balances"].get(body.envelope, 0.0)
    data["balances"][body.envelope] = round(cur + body.amount, 2)
    data["history"].append({
        "date": today,
        "type": "adjustment",
        "envelope": body.envelope,
        "amount": body.amount,
        "note": body.note or "Manual adjustment"
    })

    _save_envelope_data(data)
    _commit_envelopes(f"envelopes: adjust {body.envelope} {body.amount:+.2f} on {today}")

    return {"status": "ok", "balance": data["balances"][body.envelope]}
