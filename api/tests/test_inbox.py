from conftest import make_txn


def base_inbox_data(**overrides):
    data = {"items": [], "seen_message_ids": [], "merchant_rules": [], "card_map": {"1234": "liabilities:creditcard:CIBC"}}
    data.update(overrides)
    return data


def test_ingest_happy_path_stores_item_with_suggestion(client, auth, fake_hledger, fake_git, seed_inbox):
    seed_inbox(base_inbox_data())
    fake_hledger.set_txns([])
    resp = client.post("/inbox/ingest", headers=auth, json={
        "amount": 12.50, "merchant": "TST-The Samosa Factory", "card_last4": "1234",
        "txn_date": "2026-01-06", "email_message_id": "msg1",
    })
    assert resp.status_code == 200
    items = client.get("/inbox", headers=auth).json()["items"]
    assert len(items) == 1
    assert items[0]["merchant_clean"] == "The Samosa Factory"
    assert items[0]["suggestion"]["account1"] == "expenses:uncategorized"


def test_ingest_dedup_by_message_id(client, auth, fake_hledger, fake_git, seed_inbox):
    seed_inbox(base_inbox_data(seen_message_ids=["msg1"]))
    fake_hledger.set_txns([])
    resp = client.post("/inbox/ingest", headers=auth, json={
        "amount": 12.50, "merchant": "Store", "card_last4": "1234",
        "txn_date": "2026-01-06", "email_message_id": "msg1",
    })
    assert resp.json() == {"status": "duplicate", "reason": "message_id"}


def test_ingest_dedup_by_pending_amount_and_card_within_window(client, auth, fake_hledger, fake_git, seed_inbox):
    seed_inbox(base_inbox_data(items=[{
        "id": "ibx-1", "card_last4": "1234", "amount": 12.50, "txn_date": "2026-01-05",
        "merchant_clean": "x", "parsed": True,
    }]))
    fake_hledger.set_txns([])
    resp = client.post("/inbox/ingest", headers=auth, json={
        "amount": 12.50, "merchant": "Store", "card_last4": "1234", "txn_date": "2026-01-06",
    })
    assert resp.json() == {"status": "duplicate", "reason": "pending"}


def test_ingest_dedup_by_journal_match(client, auth, fake_hledger, fake_git, seed_inbox):
    seed_inbox(base_inbox_data())
    fake_hledger.set_txns([make_txn("2026-01-06", "Already Posted", [("expenses:misc", 12.50), ("assets:chequing", -12.50)])])
    resp = client.post("/inbox/ingest", headers=auth, json={
        "amount": 12.50, "merchant": "Store", "card_last4": "1234", "txn_date": "2026-01-06",
    })
    assert resp.json() == {"status": "duplicate", "reason": "journal"}


def test_ingest_amount_out_of_range_400(client, auth, fake_hledger, seed_inbox):
    seed_inbox(base_inbox_data())
    resp = client.post("/inbox/ingest", headers=auth, json={"amount": 2_000_000, "merchant": "Store"})
    assert resp.status_code == 400


def test_ingest_missing_merchant_400(client, auth, fake_hledger, seed_inbox):
    seed_inbox(base_inbox_data())
    resp = client.post("/inbox/ingest", headers=auth, json={"amount": 5, "merchant": "  "})
    assert resp.status_code == 400


def test_ingest_parsed_zero_amount_400(client, auth, fake_hledger, seed_inbox):
    seed_inbox(base_inbox_data())
    resp = client.post("/inbox/ingest", headers=auth, json={"amount": 0, "merchant": "Store", "parsed": True})
    assert resp.status_code == 400


def test_ingest_unparsed_zero_amount_allowed(client, auth, fake_hledger, fake_git, seed_inbox):
    seed_inbox(base_inbox_data())
    fake_hledger.set_txns([])
    resp = client.post("/inbox/ingest", headers=auth, json={"amount": 0, "merchant": "Store", "parsed": False})
    assert resp.status_code == 200


def test_ingest_inbox_full_429(client, auth, fake_hledger, seed_inbox):
    items = [{"id": f"ibx-{i}", "card_last4": "0000", "amount": float(i), "txn_date": "2026-01-01", "merchant_clean": "x", "parsed": True} for i in range(200)]
    seed_inbox(base_inbox_data(items=items))
    resp = client.post("/inbox/ingest", headers=auth, json={"amount": 999, "merchant": "Store", "card_last4": "9999", "txn_date": "2026-01-06"})
    assert resp.status_code == 429


def test_get_inbox_newest_first_with_live_journal_match(client, auth, fake_hledger, seed_inbox):
    seed_inbox(base_inbox_data(items=[
        {"id": "a", "received_at": "2026-01-01T00:00:00Z", "amount": 5, "txn_date": "2026-01-01", "card_last4": "1234", "merchant_clean": "A", "parsed": True},
        {"id": "b", "received_at": "2026-01-02T00:00:00Z", "amount": 5, "txn_date": "2026-01-02", "card_last4": "1234", "merchant_clean": "B", "parsed": True},
    ]))
    fake_hledger.set_txns([])
    resp = client.get("/inbox", headers=auth)
    items = resp.json()["items"]
    assert [i["id"] for i in items] == ["b", "a"]
    assert items[0]["journal_match"] is None


def test_inbox_count(client, auth, seed_inbox):
    seed_inbox(base_inbox_data(items=[{"id": "a", "amount": 1, "txn_date": "2026-01-01", "card_last4": "1234", "merchant_clean": "A", "parsed": True}]))
    resp = client.get("/inbox/count", headers=auth)
    assert resp.json() == {"pending": 1}


def test_post_suggestion_based_entry(client, auth, fake_git, seed_inbox, env):
    seed_inbox(base_inbox_data(items=[{
        "id": "ibx-1", "txn_date": "2026-01-06", "amount": 12.50, "currency": "$", "merchant_clean": "Samosa",
        "card_last4": "1234", "parsed": True,
        "suggestion": {"description": "Samosa", "account1": "expenses:food:diningout", "amount1": 12.50, "account2": "liabilities:creditcard:CIBC", "amount2": -12.50},
    }]))
    resp = client.post("/inbox/post", headers=auth, json={"id": "ibx-1"})
    assert resp.status_code == 200
    assert "expenses:food:diningout" in env["journal_file"].read_text()
    remaining = client.get("/inbox/count", headers=auth).json()
    assert remaining == {"pending": 0}


def test_post_raw_entry_overrides_suggestion(client, auth, fake_git, seed_inbox, env):
    seed_inbox(base_inbox_data(items=[{"id": "ibx-1", "txn_date": "2026-01-06", "amount": 12.50, "merchant_clean": "Samosa", "card_last4": "1234", "parsed": True, "suggestion": None}]))
    raw = "2026-01-06 Custom\n    expenses:food:diningout    $12.50\n    liabilities:creditcard:CIBC    $-12.50"
    resp = client.post("/inbox/post", headers=auth, json={"id": "ibx-1", "raw_entry": raw})
    assert resp.status_code == 200
    assert env["journal_file"].read_text().strip() == raw


def test_post_missing_item_404(client, auth, seed_inbox):
    seed_inbox(base_inbox_data())
    resp = client.post("/inbox/post", headers=auth, json={"id": "nope"})
    assert resp.status_code == 404


def test_post_no_suggestion_no_raw_entry_400(client, auth, seed_inbox):
    seed_inbox(base_inbox_data(items=[{"id": "ibx-1", "txn_date": "2026-01-06", "amount": 12.50, "merchant_clean": "X", "card_last4": "1234", "parsed": True, "suggestion": None}]))
    resp = client.post("/inbox/post", headers=auth, json={"id": "ibx-1"})
    assert resp.status_code == 400


def test_post_single_commit_covers_both_files(client, auth, fake_git, seed_inbox):
    seed_inbox(base_inbox_data(items=[{
        "id": "ibx-1", "txn_date": "2026-01-06", "amount": 12.50, "currency": "$", "merchant_clean": "Samosa",
        "card_last4": "1234", "parsed": True,
        "suggestion": {"description": "Samosa", "account1": "expenses:food:diningout", "amount1": 12.50, "account2": "liabilities:creditcard:CIBC", "amount2": -12.50},
    }]))
    client.post("/inbox/post", headers=auth, json={"id": "ibx-1"})
    add_call = next(c for c in fake_git.calls if c[0] == "add")
    assert len(add_call) == 3  # ("add", journal_file, inbox_file)


def test_dismiss_removes_item_no_journal_write(client, auth, fake_git, seed_inbox, env):
    seed_inbox(base_inbox_data(items=[{"id": "ibx-1", "txn_date": "2026-01-06", "amount": 5, "merchant_clean": "X", "card_last4": "1234", "parsed": True}]))
    resp = client.post("/inbox/dismiss", headers=auth, json={"id": "ibx-1"})
    assert resp.status_code == 200
    assert env["journal_file"].read_text() == ""
    assert client.get("/inbox/count", headers=auth).json() == {"pending": 0}


def test_dismiss_missing_item_404(client, auth, seed_inbox):
    seed_inbox(base_inbox_data())
    resp = client.post("/inbox/dismiss", headers=auth, json={"id": "nope"})
    assert resp.status_code == 404


def test_rule_adds_new_rule(client, auth, fake_git, seed_inbox):
    seed_inbox(base_inbox_data())
    resp = client.post("/inbox/rule", headers=auth, json={"pattern": "SAMOSA", "account": "expenses:food:diningout", "description": "Samosa Factory"})
    assert resp.json() == {"status": "ok", "rules": 1}


def test_rule_replaces_existing_rule_with_same_pattern(client, auth, fake_git, seed_inbox):
    seed_inbox(base_inbox_data(merchant_rules=[{"pattern": "SAMOSA", "account": "expenses:old", "description": "Old"}]))
    resp = client.post("/inbox/rule", headers=auth, json={"pattern": "samosa", "account": "expenses:new", "description": "New"})
    assert resp.json() == {"status": "ok", "rules": 1}


def test_rule_validation_empty_fields_400(client, auth, seed_inbox):
    seed_inbox(base_inbox_data())
    resp = client.post("/inbox/rule", headers=auth, json={"pattern": "", "account": "expenses:x", "description": "X"})
    assert resp.status_code == 400
