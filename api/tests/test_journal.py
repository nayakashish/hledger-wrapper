from conftest import make_txn


def test_add_structured_entry_auto_negates_amount2(client, auth, fake_hledger, fake_git, env):
    resp = client.post(
        "/add",
        headers=auth,
        json={
            "date": "2026-01-05",
            "description": "Coffee",
            "account1": "expenses:food:diningout",
            "amount1": 5.00,
            "account2": "assets:chequing",
        },
    )
    assert resp.status_code == 200
    assert "$5.00" in resp.json()["entry"]
    assert "$-5.00" in resp.json()["entry"]
    assert env["journal_file"].read_text().strip().endswith("$-5.00")


def test_add_raw_entry_passthrough(client, auth, fake_hledger, fake_git, env):
    raw = "2026-01-05 Coffee\n    expenses:food:diningout    $5.00\n    assets:chequing    $-5.00"
    resp = client.post("/add", headers=auth, json={"raw_entry": raw})
    assert resp.status_code == 200
    assert env["journal_file"].read_text().strip() == raw


def test_add_commits_and_pushes_in_order(client, auth, fake_hledger, fake_git, env):
    client.post(
        "/add",
        headers=auth,
        json={"date": "2026-01-05", "description": "Coffee", "account1": "a", "amount1": 5, "account2": "b"},
    )
    subcommands = [c[0] for c in fake_git.calls]
    assert subcommands == ["rev-parse", "add", "commit", "push"]


def test_add_rolls_back_on_push_failure(client, auth, fake_hledger, fake_git, env):
    fake_git.fail_on = "push"
    resp = client.post(
        "/add",
        headers=auth,
        json={"date": "2026-01-05", "description": "Coffee", "account1": "a", "amount1": 5, "account2": "b"},
    )
    assert resp.status_code == 500
    subcommands = [c[0] for c in fake_git.calls]
    assert subcommands == ["rev-parse", "add", "commit", "push", "reset"]
    assert fake_git.calls[-1] == ("reset", "--hard", fake_git.head)


def test_add_oserror_on_write_returns_500(client, auth, fake_hledger, fake_git, env, monkeypatch):
    env["journal_file"].chmod(0o444)
    try:
        resp = client.post(
            "/add",
            headers=auth,
            json={"date": "2026-01-05", "description": "Coffee", "account1": "a", "amount1": 5, "account2": "b"},
        )
        assert resp.status_code == 500
    finally:
        env["journal_file"].chmod(0o644)


def test_descriptions_unique_most_recent_first(client, auth, fake_hledger):
    fake_hledger.set_txns([
        make_txn("2026-01-01", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)]),
        make_txn("2026-01-02", "Groceries", [("expenses:food:groceries", 20), ("assets:chequing", -20)]),
        make_txn("2026-01-03", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)]),
    ])
    resp = client.get("/descriptions", headers=auth)
    assert resp.json() == {"descriptions": ["Coffee", "Groceries"]}


def test_lookup_exact_match_returns_postings(client, auth, fake_hledger):
    fake_hledger.set_txns([make_txn("2026-01-01", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)])])
    resp = client.get("/lookup", params={"description": "coffee"}, headers=auth)
    assert resp.json() == {
        "match": {
            "account1": "expenses:food:diningout",
            "amount1": 5.0,
            "account2": "assets:chequing",
            "amount2": -5.0,
        }
    }


def test_lookup_no_match_returns_null(client, auth, fake_hledger):
    fake_hledger.set_txns([])
    resp = client.get("/lookup", params={"description": "nothing"}, headers=auth)
    assert resp.json() == {"match": None}


def test_sync_returns_git_pull_output(client, auth, fake_git):
    resp = client.post("/sync", headers=auth)
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "detail": "Already up to date."}
    assert fake_git.calls == [("pull",)]
