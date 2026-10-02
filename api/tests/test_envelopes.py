from conftest import make_txn

from app.routers.envelopes import TXN_ID_VERSION, _txn_id


def base_env_data(**overrides):
    data = {
        "envelopes": [{"id": "chequing", "name": "Chequing", "parent": None, "sort_order": 1}],
        "balances": {"chequing": 0.0},
        "pending": [],
        "matched_hledger_txns": [],
        "history": [],
        "txn_id_version": TXN_ID_VERSION,
    }
    data.update(overrides)
    return data


def test_get_envelopes_returns_stored_data(client, auth, seed_envelopes):
    seed_envelopes(base_env_data())
    resp = client.get("/envelopes", headers=auth)
    assert resp.status_code == 200
    assert resp.json()["envelopes"][0]["id"] == "chequing"


def test_get_envelopes_missing_data_file_503(client, auth, env):
    # env never creates envelope_file — it's written lazily by write endpoints.
    assert not env["envelope_file"].exists()
    resp = client.get("/envelopes", headers=auth)
    assert resp.status_code == 503


def test_scan_adds_new_pending_and_skips_matched(client, auth, fake_hledger, fake_git, seed_envelopes):
    old = make_txn("2026-01-01", "Old", [("expenses:misc", 5), ("assets:chequing", -5)], tindex=1)
    seed_envelopes(base_env_data(matched_hledger_txns=[_txn_id(old)]))
    fake_hledger.set_txns([
        old,
        make_txn("2026-01-05", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)], tindex=2),
    ])
    resp = client.post("/envelopes/scan", headers=auth)
    assert resp.json() == {"status": "ok", "added": 1, "pending_total": 1}


def test_scan_skips_already_pending(client, auth, fake_hledger, seed_envelopes):
    coffee = make_txn("2026-01-05", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)], tindex=2)
    seed_envelopes(base_env_data(pending=[{"txn_id": _txn_id(coffee), "date": "2026-01-05", "description": "Coffee", "amount": 5.0, "type": "expense", "suggested_envelope": None, "accounts": []}]))
    fake_hledger.set_txns([coffee])
    resp = client.post("/envelopes/scan", headers=auth)
    assert resp.json()["added"] == 0


def test_scan_types_income_vs_expense(client, auth, fake_hledger, fake_git, seed_envelopes):
    seed_envelopes(base_env_data())
    fake_hledger.set_txns([make_txn("2026-01-05", "Paycheck", [("income:salary", -100), ("assets:chequing", 100)])])
    client.post("/envelopes/scan", headers=auth)
    data = client.get("/envelopes", headers=auth).json()
    assert data["pending"][0]["type"] == "income"
    assert data["pending"][0]["suggested_envelope"] is None


def test_scan_zero_amount_skipped(client, auth, fake_hledger, seed_envelopes):
    seed_envelopes(base_env_data())
    fake_hledger.set_txns([make_txn("2026-01-05", "Zero", [("expenses:misc", 0), ("assets:chequing", 0)])])
    resp = client.post("/envelopes/scan", headers=auth)
    assert resp.json()["added"] == 0


def test_scan_amount_is_net_change_to_accounts(client, auth, fake_hledger, fake_git, seed_envelopes):
    # Two expense postings: the pending amount is the whole $131 that left
    # chequing, not the first posting's $45.
    seed_envelopes(base_env_data())
    fake_hledger.set_txns([make_txn("2026-01-05", "Two things", [("expenses:hobby", 45), ("expenses:car:gas", 86), ("assets:chequing", -131)])])
    client.post("/envelopes/scan", headers=auth)
    pending = client.get("/envelopes", headers=auth).json()["pending"][0]
    assert (pending["type"], pending["amount"]) == ("expense", 131.0)


def test_scan_refund_is_inflow_with_suggestion(client, auth, fake_hledger, fake_git, seed_envelopes):
    seed_envelopes(base_env_data(
        envelopes=[{"id": "groceries", "name": "Groceries", "parent": "everyday", "sort_order": 1}],
    ))
    fake_hledger.set_txns([make_txn("2026-01-05", "Returned", [("expenses:food:groceries", -20), ("assets:chequing", 20)])])
    client.post("/envelopes/scan", headers=auth)
    pending = client.get("/envelopes", headers=auth).json()["pending"][0]
    assert (pending["type"], pending["amount"], pending["suggested_envelope"]) == ("income", 20.0, "groceries")


def test_scan_skips_transfers_between_own_accounts(client, auth, fake_hledger, seed_envelopes):
    seed_envelopes(base_env_data())
    fake_hledger.set_txns([make_txn("2026-01-05", "Card payment", [("liabilities:card", 200), ("assets:chequing", -200)])])
    resp = client.post("/envelopes/scan", headers=auth)
    assert resp.json()["added"] == 0


def test_scan_ignores_entries_inserted_earlier_in_the_file(client, auth, fake_hledger, fake_git, seed_envelopes):
    # The bug behind double assignments: a back-dated entry inserted above
    # an assigned one shifted its position, and it came back as new.
    parking = make_txn("2026-09-24", "Parking", [("expenses:car:parking", 6.45), ("liabilities:card", -6.45)], tindex=296)
    seed_envelopes(base_env_data(matched_hledger_txns=[_txn_id(parking)]))
    inserted = make_txn("2026-09-24", "Gas", [("expenses:car:gas", 30), ("liabilities:card", -30)], tindex=296)
    shifted = {**parking, "tindex": 297}
    fake_hledger.set_txns([inserted, shifted])
    client.post("/envelopes/scan", headers=auth)
    pending = client.get("/envelopes", headers=auth).json()["pending"]
    assert [p["description"] for p in pending] == ["Gas"]


# --- migration from tindex ids (version 1) ---------------------------------

def _v1_store(**overrides):
    data = base_env_data(**overrides)
    del data["txn_id_version"]
    return data


def test_migration_carries_matched_and_pending_over(client, auth, fake_hledger, fake_git, seed_envelopes):
    done = make_txn("2026-01-01", "Done", [("expenses:misc", 5), ("assets:chequing", -5)], tindex=1)
    waiting = make_txn("2026-01-02", "Waiting", [("expenses:misc", 7), ("assets:chequing", -7)], tindex=2)
    seed_envelopes(_v1_store(
        matched_hledger_txns=["2026-01-01|Done|1"],
        pending=[{"txn_id": "2026-01-02|Waiting|2", "date": "2026-01-02", "description": "Waiting", "amount": 7.0, "type": "expense", "suggested_envelope": None, "accounts": []}],
    ))
    fake_hledger.set_txns([done, waiting])
    resp = client.post("/envelopes/scan", headers=auth)
    assert resp.json()["added"] == 0
    data = client.get("/envelopes", headers=auth).json()
    assert data["matched_hledger_txns"] == [_txn_id(done)]
    assert [p["txn_id"] for p in data["pending"]] == [_txn_id(waiting)]
    assert data["txn_id_version"] == TXN_ID_VERSION
    assert "migrated" in [c for c in fake_git.calls if c[0] == "commit"][0][2]


def test_migration_matches_entries_shifted_since_the_last_scan(client, auth, fake_hledger, fake_git, seed_envelopes):
    # Matched as |296, but an insert since then moved it to |297. Its date
    # and description are fully covered by matched ids, so it stays handled.
    seed_envelopes(_v1_store(matched_hledger_txns=["2026-09-24|Parking|296"]))
    fake_hledger.set_txns([make_txn("2026-09-24", "Parking", [("expenses:car:parking", 6.45), ("liabilities:card", -6.45)], tindex=297)])
    resp = client.post("/envelopes/scan", headers=auth)
    assert resp.json()["added"] == 0


def test_migration_leaves_genuinely_new_entries_pending(client, auth, fake_hledger, fake_git, seed_envelopes):
    seed_envelopes(_v1_store(matched_hledger_txns=["2026-01-01|Done|1"]))
    fake_hledger.set_txns([
        make_txn("2026-01-01", "Done", [("expenses:misc", 5), ("assets:chequing", -5)], tindex=1),
        make_txn("2026-01-03", "New", [("expenses:misc", 9), ("assets:chequing", -9)], tindex=2),
    ])
    resp = client.post("/envelopes/scan", headers=auth)
    assert resp.json()["added"] == 1


def test_scan_commits_and_pushes_new_pending(client, auth, fake_hledger, fake_git, seed_envelopes):
    seed_envelopes(base_env_data())
    fake_hledger.set_txns([make_txn("2026-01-05", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)])])
    resp = client.post("/envelopes/scan", headers=auth)
    assert resp.status_code == 200
    subcommands = [c[0] for c in fake_git.calls]
    assert subcommands == ["rev-parse", "add", "commit", "push"]


def test_scan_no_new_txns_makes_no_commit(client, auth, fake_hledger, fake_git, seed_envelopes):
    coffee = make_txn("2026-01-05", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)])
    seed_envelopes(base_env_data(matched_hledger_txns=[_txn_id(coffee)]))
    fake_hledger.set_txns([coffee])
    resp = client.post("/envelopes/scan", headers=auth)
    assert resp.json()["added"] == 0
    assert fake_git.calls == []


def test_scan_failed_push_rolls_back(client, auth, fake_hledger, fake_git, seed_envelopes):
    seed_envelopes(base_env_data())
    fake_hledger.set_txns([make_txn("2026-01-05", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)])])
    fake_git.fail_on = "push"
    resp = client.post("/envelopes/scan", headers=auth)
    assert resp.status_code == 500
    assert ("reset", "--hard", fake_git.head) in fake_git.calls


def test_scan_malformed_hledger_output_500(client, auth, fake_hledger, seed_envelopes):
    seed_envelopes(base_env_data())
    fake_hledger.output = "not valid json"
    resp = client.post("/envelopes/scan", headers=auth)
    assert resp.status_code == 500


def test_assign_expense_drains_balance(client, auth, fake_git, seed_envelopes):
    seed_envelopes(base_env_data(pending=[{
        "txn_id": "t1", "date": "2026-01-05", "description": "Coffee", "amount": 5.0,
        "type": "expense", "suggested_envelope": "chequing", "accounts": [],
    }]))
    resp = client.post("/envelopes/assign", headers=auth, json={"txn_id": "t1", "envelope_id": "chequing"})
    assert resp.status_code == 200
    data = client.get("/envelopes", headers=auth).json()
    assert data["balances"]["chequing"] == -5.0
    assert data["pending"] == []
    assert "t1" in data["matched_hledger_txns"]
    assert len(data["history"]) == 1


def test_assign_income_splits_fill_balances(client, auth, fake_git, seed_envelopes):
    seed_envelopes(base_env_data(
        envelopes=[
            {"id": "chequing", "name": "Chequing", "parent": None, "sort_order": 1},
            {"id": "savings", "name": "Savings", "parent": None, "sort_order": 2},
        ],
        balances={"chequing": 0.0, "savings": 0.0},
        pending=[{"txn_id": "t1", "date": "2026-01-05", "description": "Paycheck", "amount": 100.0, "type": "income", "suggested_envelope": None, "accounts": []}],
    ))
    resp = client.post("/envelopes/assign", headers=auth, json={
        "txn_id": "t1",
        "splits": [{"envelope_id": "chequing", "amount": 60}, {"envelope_id": "savings", "amount": 40}],
    })
    assert resp.status_code == 200
    data = client.get("/envelopes", headers=auth).json()
    assert data["balances"] == {"chequing": 60.0, "savings": 40.0}


def test_assign_expense_splits_drains_multiple_envelopes(client, auth, fake_git, seed_envelopes):
    seed_envelopes(base_env_data(
        envelopes=[
            {"id": "chequing", "name": "Chequing", "parent": None, "sort_order": 1},
            {"id": "food", "name": "Food", "parent": None, "sort_order": 2},
        ],
        balances={"chequing": 0.0, "food": 0.0},
        pending=[{"txn_id": "t1", "date": "2026-01-05", "description": "Groceries", "amount": 50.0, "type": "expense", "suggested_envelope": None, "accounts": []}],
    ))
    resp = client.post("/envelopes/assign", headers=auth, json={
        "txn_id": "t1",
        "splits": [{"envelope_id": "chequing", "amount": 20}, {"envelope_id": "food", "amount": 30}],
    })
    assert resp.status_code == 200
    data = client.get("/envelopes", headers=auth).json()
    assert data["balances"] == {"chequing": -20.0, "food": -30.0}


def test_assign_expense_splits_mismatched_sum_400(client, auth, seed_envelopes):
    seed_envelopes(base_env_data(pending=[{
        "txn_id": "t1", "date": "2026-01-05", "description": "Coffee", "amount": 5.0,
        "type": "expense", "suggested_envelope": None, "accounts": [],
    }]))
    resp = client.post("/envelopes/assign", headers=auth, json={
        "txn_id": "t1",
        "splits": [{"envelope_id": "chequing", "amount": 1}],
    })
    assert resp.status_code == 400
    data = client.get("/envelopes", headers=auth).json()
    assert data["pending"] != []  # nothing was assigned


def test_assign_income_splits_mismatched_sum_400(client, auth, seed_envelopes):
    seed_envelopes(base_env_data(
        pending=[{"txn_id": "t1", "date": "2026-01-05", "description": "Paycheck", "amount": 100.0, "type": "income", "suggested_envelope": None, "accounts": []}],
    ))
    resp = client.post("/envelopes/assign", headers=auth, json={
        "txn_id": "t1",
        "splits": [{"envelope_id": "chequing", "amount": 10}],
    })
    assert resp.status_code == 400
    data = client.get("/envelopes", headers=auth).json()
    assert data["balances"]["chequing"] == 0.0
    assert data["pending"] != []  # nothing was assigned


def test_assign_expense_missing_envelope_id_400(client, auth, seed_envelopes):
    seed_envelopes(base_env_data(pending=[{"txn_id": "t1", "date": "2026-01-05", "description": "Coffee", "amount": 5.0, "type": "expense", "suggested_envelope": None, "accounts": []}]))
    resp = client.post("/envelopes/assign", headers=auth, json={"txn_id": "t1"})
    assert resp.status_code == 400


def test_assign_income_missing_splits_400(client, auth, seed_envelopes):
    seed_envelopes(base_env_data(pending=[{"txn_id": "t1", "date": "2026-01-05", "description": "Pay", "amount": 100.0, "type": "income", "suggested_envelope": None, "accounts": []}]))
    resp = client.post("/envelopes/assign", headers=auth, json={"txn_id": "t1"})
    assert resp.status_code == 400


def test_assign_unknown_txn_404(client, auth, seed_envelopes):
    seed_envelopes(base_env_data())
    resp = client.post("/envelopes/assign", headers=auth, json={"txn_id": "nope", "envelope_id": "chequing"})
    assert resp.status_code == 404


def test_dismiss_missing_txn_id_400(client, auth, seed_envelopes):
    seed_envelopes(base_env_data())
    resp = client.post("/envelopes/dismiss", headers=auth, json={})
    assert resp.status_code == 400


def test_dismiss_marks_matched_without_touching_balance(client, auth, fake_git, seed_envelopes):
    seed_envelopes(base_env_data(pending=[{"txn_id": "t1", "date": "2026-01-05", "description": "Coffee", "amount": 5.0, "type": "expense", "suggested_envelope": None, "accounts": []}]))
    resp = client.post("/envelopes/dismiss", headers=auth, json={"txn_id": "t1"})
    assert resp.status_code == 200
    data = client.get("/envelopes", headers=auth).json()
    assert data["pending"] == []
    assert data["balances"]["chequing"] == 0.0
    assert "t1" in data["matched_hledger_txns"]


def test_transfer_moves_money_between_envelopes(client, auth, fake_git, seed_envelopes):
    seed_envelopes(base_env_data(
        envelopes=[
            {"id": "chequing", "name": "Chequing", "parent": None, "sort_order": 1},
            {"id": "savings", "name": "Savings", "parent": None, "sort_order": 2},
        ],
        balances={"chequing": 100.0, "savings": 0.0},
    ))
    resp = client.post("/envelopes/transfer", headers=auth, json={"from_envelope": "chequing", "to_envelope": "savings", "amount": 30})
    assert resp.json()["balances"] == {"chequing": 70.0, "savings": 30.0}


def test_adjust_manual_correction(client, auth, fake_git, seed_envelopes):
    seed_envelopes(base_env_data())
    resp = client.post("/envelopes/adjust", headers=auth, json={"envelope": "chequing", "amount": 10.5, "note": "found cash"})
    assert resp.json() == {"status": "ok", "balance": 10.5}


def test_create_envelope_unique_id_on_collision(client, auth, fake_git, seed_envelopes):
    seed_envelopes(base_env_data(envelopes=[{"id": "food", "name": "Food", "parent": None, "sort_order": 1}], balances={"food": 0.0}))
    resp = client.post("/envelopes/create", headers=auth, json={"name": "Food"})
    assert resp.json()["envelope"]["id"] == "food_2"


def test_create_envelope_sort_order_increments(client, auth, fake_git, seed_envelopes):
    seed_envelopes(base_env_data(envelopes=[
        {"id": "a", "name": "A", "parent": "food", "sort_order": 1},
        {"id": "b", "name": "B", "parent": "food", "sort_order": 2},
    ]))
    resp = client.post("/envelopes/create", headers=auth, json={"name": "C", "parent": "food"})
    assert resp.json()["envelope"]["sort_order"] == 3


def test_delete_protected_envelope_400(client, auth, seed_envelopes):
    seed_envelopes(base_env_data())
    resp = client.request("DELETE", "/envelopes/chequing", headers=auth)
    assert resp.status_code == 400


def test_delete_nonzero_balance_400(client, auth, seed_envelopes):
    seed_envelopes(base_env_data(envelopes=[{"id": "food", "name": "Food", "parent": None, "sort_order": 1}], balances={"food": 5.0}))
    resp = client.request("DELETE", "/envelopes/food", headers=auth)
    assert resp.status_code == 400


def test_delete_clean_removes_envelope(client, auth, fake_git, seed_envelopes):
    seed_envelopes(base_env_data(envelopes=[{"id": "food", "name": "Food", "parent": None, "sort_order": 1}], balances={"food": 0.0}))
    resp = client.request("DELETE", "/envelopes/food", headers=auth)
    assert resp.status_code == 200
    data = client.get("/envelopes", headers=auth).json()
    assert "food" not in data["balances"]
    assert all(e["id"] != "food" for e in data["envelopes"])
