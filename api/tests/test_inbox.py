import json

import pytest

from conftest import make_txn


def base_inbox_data(**overrides):
    data = {"items": [], "seen_message_ids": [], "merchant_rules": [], "card_map": {"1234": "liabilities:creditcard:CIBC"}}
    data.update(overrides)
    return data


@pytest.fixture
def multi_journal_env(env, monkeypatch):
    """Layer real folder-based journals (2026, 2027, demo) on top of the flat
    `env` fixture (which already points JOURNAL_DIR at tmp_path), plus an
    app_config.json, so active_journal and inbox_journal can be set
    independently — see fix-email-inbox-journal-targeting.md."""
    root = env["tmp_path"]
    cfg = root / "app_config.json"
    monkeypatch.setenv("APP_CONFIG_FILE", str(cfg))

    paths = {}
    for name in ("2026", "2027", "demo"):
        folder = root / name
        folder.mkdir()
        (folder / f"{name}.journal").write_text("")
        paths[name] = folder

    def _configure(**app_config) -> None:
        cfg.write_text(json.dumps(app_config))

    return {"root": root, "cfg": cfg, "paths": paths, "configure": _configure}


def test_get_inbox_missing_data_file_503(client, auth, env):
    # env never creates inbox_file — it's written lazily by write endpoints.
    assert not env["inbox_file"].exists()
    resp = client.get("/inbox", headers=auth)
    assert resp.status_code == 503


def test_get_inbox_unconfigured_503(client, auth, monkeypatch):
    monkeypatch.setenv("INBOX_DATA_FILE", "")
    resp = client.get("/inbox", headers=auth)
    assert resp.status_code == 503
    assert "not configured" in resp.json()["detail"].lower()


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


def test_ingest_pending_dedup_commits_seen_message_id(client, auth, env, fake_hledger, fake_git, seed_inbox):
    """The seen-id guard is only useful if it reaches the remote — otherwise a
    re-forwarded alert re-ingests on another device (#17)."""
    seed_inbox(base_inbox_data(items=[{
        "id": "ibx-1", "card_last4": "1234", "amount": 12.50, "txn_date": "2026-01-05",
        "merchant_clean": "x", "parsed": True,
    }]))
    fake_hledger.set_txns([])
    resp = client.post("/inbox/ingest", headers=auth, json={
        "amount": 12.50, "merchant": "Store", "card_last4": "1234",
        "txn_date": "2026-01-06", "email_message_id": "msg1",
    })
    assert resp.json() == {"status": "duplicate", "reason": "pending"}
    assert [c[0] for c in fake_git.calls] == ["rev-parse", "add", "commit", "push"]
    assert json.loads(env["inbox_file"].read_text())["seen_message_ids"] == ["msg1"]


def test_ingest_journal_dedup_commits_seen_message_id(client, auth, env, fake_hledger, fake_git, seed_inbox):
    seed_inbox(base_inbox_data())
    fake_hledger.set_txns([make_txn("2026-01-06", "Already Posted", [("expenses:misc", 12.50), ("assets:chequing", -12.50)])])
    resp = client.post("/inbox/ingest", headers=auth, json={
        "amount": 12.50, "merchant": "Store", "card_last4": "1234",
        "txn_date": "2026-01-06", "email_message_id": "msg1",
    })
    assert resp.json() == {"status": "duplicate", "reason": "journal"}
    assert [c[0] for c in fake_git.calls] == ["rev-parse", "add", "commit", "push"]
    assert json.loads(env["inbox_file"].read_text())["seen_message_ids"] == ["msg1"]


def test_ingest_dedup_without_message_id_makes_no_commit(client, auth, fake_hledger, fake_git, seed_inbox):
    seed_inbox(base_inbox_data(items=[{
        "id": "ibx-1", "card_last4": "1234", "amount": 12.50, "txn_date": "2026-01-05",
        "merchant_clean": "x", "parsed": True,
    }]))
    fake_hledger.set_txns([])
    resp = client.post("/inbox/ingest", headers=auth, json={
        "amount": 12.50, "merchant": "Store", "card_last4": "1234", "txn_date": "2026-01-06",
    })
    assert resp.json() == {"status": "duplicate", "reason": "pending"}
    assert fake_git.calls == []


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
    assert resp.json() == {"pending": 1, "active_journal": ""}


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
    assert remaining == {"pending": 0, "active_journal": ""}


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
    assert client.get("/inbox/count", headers=auth).json() == {"pending": 0, "active_journal": ""}


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


# --- inbox_journal targeting (decoupled from active_journal) -----------------
# See temp/bug-fixing/fix-email-inbox-journal-targeting.md.

def test_ingest_lands_in_inbox_journal_not_active_view(client, auth, fake_hledger, fake_git, multi_journal_env):
    multi_journal_env["configure"](active_journal="demo", inbox_journal="2026")
    (multi_journal_env["paths"]["2026"] / "inbox.json").write_text(json.dumps(base_inbox_data()))
    fake_hledger.set_txns([])

    resp = client.post("/inbox/ingest", headers=auth, json={
        "amount": 5.0, "merchant": "Store", "card_last4": "1234", "txn_date": "2026-01-06",
    })
    assert resp.status_code == 200
    data_2026 = json.loads((multi_journal_env["paths"]["2026"] / "inbox.json").read_text())
    assert len(data_2026["items"]) == 1
    assert not (multi_journal_env["paths"]["demo"] / "inbox.json").exists()


def test_ingest_dedup_reads_inbox_journal_history_not_active(client, auth, fake_hledger, fake_git, multi_journal_env):
    """If ingest read the *active* journal's history instead of inbox_journal's
    (the bug the rev-1 plan would have left in), this duplicate would be missed
    entirely and a fresh pending item would be created."""
    multi_journal_env["configure"](active_journal="2027", inbox_journal="2026")
    (multi_journal_env["paths"]["2026"] / "inbox.json").write_text(json.dumps(base_inbox_data()))

    journal_2026 = str(multi_journal_env["paths"]["2026"] / "2026.journal")
    journal_2027 = str(multi_journal_env["paths"]["2027"] / "2027.journal")
    fake_hledger.set_file_txns(journal_2026, [
        make_txn("2026-01-06", "Already Posted", [("expenses:misc", 12.50), ("assets:chequing", -12.50)])
    ])
    fake_hledger.set_file_txns(journal_2027, [])  # active journal has nothing matching

    resp = client.post("/inbox/ingest", headers=auth, json={
        "amount": 12.50, "merchant": "Store", "card_last4": "1234", "txn_date": "2026-01-06",
    })
    assert resp.json() == {"status": "duplicate", "reason": "journal"}
    assert any(fc[0] == journal_2026 for fc in fake_hledger.file_calls)


def test_ingest_suggestion_reads_inbox_journal_history_not_active(client, auth, fake_hledger, fake_git, multi_journal_env):
    multi_journal_env["configure"](active_journal="2027", inbox_journal="2026")
    (multi_journal_env["paths"]["2026"] / "inbox.json").write_text(json.dumps(base_inbox_data()))

    journal_2026 = str(multi_journal_env["paths"]["2026"] / "2026.journal")
    journal_2027 = str(multi_journal_env["paths"]["2027"] / "2027.journal")
    fake_hledger.set_file_txns(journal_2026, [
        make_txn("2026-01-01", "The Coffee Shop", [("expenses:food:coffee", 5.00), ("assets:chequing", -5.00)])
    ])
    fake_hledger.set_file_txns(journal_2027, [
        make_txn("2026-01-01", "The Coffee Shop", [("expenses:misc", 5.00), ("assets:chequing", -5.00)])
    ])

    resp = client.post("/inbox/ingest", headers=auth, json={
        "amount": 5.00, "merchant": "The Coffee Shop", "card_last4": "1234",
        "txn_date": "2026-01-07", "parsed": False,
    })
    assert resp.status_code == 200
    # Read the ingest-journal's file directly — GET /inbox stays on the
    # *active* journal (2027) by design, which is a different one here.
    data = json.loads((multi_journal_env["paths"]["2026"] / "inbox.json").read_text())
    assert data["items"][0]["suggestion"]["account1"] == "expenses:food:coffee"


def test_ingest_rejected_when_inbox_journal_unset(client, auth, fake_hledger, multi_journal_env):
    multi_journal_env["configure"](active_journal="2026")  # no inbox_journal picked
    resp = client.post("/inbox/ingest", headers=auth, json={
        "amount": 5.0, "merchant": "Store", "card_last4": "1234", "txn_date": "2026-01-06",
    })
    assert resp.status_code == 503
    for name in ("2026", "2027", "demo"):
        assert not (multi_journal_env["paths"][name] / "inbox.json").exists()


def test_ingest_rejected_when_inbox_journal_is_demo(client, auth, fake_hledger, multi_journal_env):
    """Defense in depth: even a hand-edited app_config.json naming demo as the
    ingest target is refused, not just the /journals/select-inbox endpoint."""
    multi_journal_env["configure"](inbox_journal="demo")
    resp = client.post("/inbox/ingest", headers=auth, json={
        "amount": 5.0, "merchant": "Store", "card_last4": "1234", "txn_date": "2026-01-06",
    })
    assert resp.status_code == 503
    assert not (multi_journal_env["paths"]["demo"] / "inbox.json").exists()


def test_ingest_rejected_when_inbox_journal_folder_missing(client, auth, fake_hledger, multi_journal_env):
    multi_journal_env["configure"](inbox_journal="1999")  # renamed/deleted since it was picked
    resp = client.post("/inbox/ingest", headers=auth, json={
        "amount": 5.0, "merchant": "Store", "card_last4": "1234", "txn_date": "2026-01-06",
    })
    assert resp.status_code == 503


def test_ingest_seeds_missing_inbox_json_for_resolved_target(client, auth, fake_hledger, fake_git, multi_journal_env):
    multi_journal_env["configure"](inbox_journal="2027")  # 2027 has no inbox.json yet
    fake_hledger.set_txns([])
    resp = client.post("/inbox/ingest", headers=auth, json={
        "amount": 5.0, "merchant": "Store", "card_last4": "1234", "txn_date": "2026-01-06",
    })
    assert resp.status_code == 200
    data = json.loads((multi_journal_env["paths"]["2027"] / "inbox.json").read_text())
    assert len(data["items"]) == 1
