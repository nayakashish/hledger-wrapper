from conftest import make_txn


def base_env_data(**overrides):
    data = {
        "envelopes": [{"id": "chequing", "name": "Chequing", "parent": None, "sort_order": 1}],
        "balances": {"chequing": 0.0},
        "pending": [],
        "matched_hledger_txns": [],
        "history": [],
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


def test_scan_adds_new_pending_and_skips_matched(client, auth, fake_hledger, seed_envelopes):
    seed_envelopes(base_env_data(matched_hledger_txns=["2026-01-01|Old|1"]))
    fake_hledger.set_txns([
        make_txn("2026-01-01", "Old", [("expenses:misc", 5), ("assets:chequing", -5)], tindex=1),
        make_txn("2026-01-05", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)], tindex=2),
    ])
    resp = client.post("/envelopes/scan", headers=auth)
    assert resp.json() == {"status": "ok", "added": 1, "pending_total": 1}


def test_scan_skips_already_pending(client, auth, fake_hledger, seed_envelopes):
    seed_envelopes(base_env_data(pending=[{"txn_id": "2026-01-05|Coffee|2", "date": "2026-01-05", "description": "Coffee", "amount": 5.0, "type": "expense", "suggested_envelope": None, "accounts": []}]))
    fake_hledger.set_txns([make_txn("2026-01-05", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)], tindex=2)])
    resp = client.post("/envelopes/scan", headers=auth)
    assert resp.json()["added"] == 0


def test_scan_types_income_vs_expense(client, auth, fake_hledger, seed_envelopes):
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
