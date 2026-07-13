import json

from conftest import make_txn


def test_balance_passthrough(client, auth, fake_hledger):
    fake_hledger.output = '{"raw": "fixture"}'
    resp = client.get("/balance", headers=auth)
    assert resp.status_code == 200
    assert resp.json() == {"raw": '{"raw": "fixture"}'}
    assert fake_hledger.calls[0][0] == "balance"


def test_income_statement_passthrough(client, auth, fake_hledger):
    resp = client.get("/is", headers=auth)
    assert resp.status_code == 200
    assert fake_hledger.calls[0][0] == "is"


def test_monthly_uses_depth_2(client, auth, fake_hledger):
    client.get("/monthly", headers=auth)
    assert "--depth" in fake_hledger.calls[0]
    assert "2" in fake_hledger.calls[0]


def test_monthly_detail_no_depth_limit(client, auth, fake_hledger):
    client.get("/monthly-detail", headers=auth)
    assert "--depth" not in fake_hledger.calls[0]


def test_transactions_default_month_is_current(client, auth, fake_hledger):
    fake_hledger.set_txns([])
    resp = client.get("/transactions", headers=auth)
    assert resp.status_code == 200


def test_transactions_explicit_month(client, auth, fake_hledger):
    fake_hledger.set_txns([make_txn("2026-03-05", "Rent", [("expenses:housing", 1000), ("assets:chequing", -1000)])])
    resp = client.get("/transactions", params={"month": "2026-03"}, headers=auth)
    assert resp.status_code == 200
    date_filter = fake_hledger.calls[0][fake_hledger.calls[0].index("-p") + 1]
    assert date_filter == "2026-03-01..2026-04-01"


def test_transactions_december_rolls_to_next_year(client, auth, fake_hledger):
    fake_hledger.set_txns([])
    client.get("/transactions", params={"month": "2026-12"}, headers=auth)
    date_filter = fake_hledger.calls[0][fake_hledger.calls[0].index("-p") + 1]
    assert date_filter == "2026-12-01..2027-01-01"


def test_transactions_malformed_month_400(client, auth, fake_hledger):
    resp = client.get("/transactions", params={"month": "not-a-month"}, headers=auth)
    assert resp.status_code == 400


def test_transactions_ordered_most_recent_first(client, auth, fake_hledger):
    fake_hledger.set_txns([
        make_txn("2026-03-01", "First", [("expenses:misc", 1), ("assets:chequing", -1)]),
        make_txn("2026-03-02", "Second", [("expenses:misc", 1), ("assets:chequing", -1)]),
    ])
    resp = client.get("/transactions", params={"month": "2026-03"}, headers=auth)
    txns = json.loads(resp.json()["raw"])
    assert [t["tdescription"] for t in txns] == ["Second", "First"]


def test_search_empty_query_returns_empty(client, auth, fake_hledger):
    resp = client.get("/search", params={"q": "  "}, headers=auth)
    assert json.loads(resp.json()["raw"]) == []


def test_search_no_matches_returns_empty(client, auth, fake_hledger):
    fake_hledger.set_txns([make_txn("2026-01-01", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)])])
    resp = client.get("/search", params={"q": "zzz-nomatch"}, headers=auth)
    assert json.loads(resp.json()["raw"]) == []


def test_search_matches_description_substring(client, auth, fake_hledger):
    fake_hledger.set_txns([
        make_txn("2026-01-01", "Coffee Shop", [("expenses:food:diningout", 5), ("assets:chequing", -5)]),
        make_txn("2026-01-02", "Groceries", [("expenses:food:groceries", 20), ("assets:chequing", -20)]),
    ])
    resp = client.get("/search", params={"q": "coffee"}, headers=auth)
    matches = json.loads(resp.json()["raw"])
    assert len(matches) == 1
    assert matches[0]["tdescription"] == "Coffee Shop"


def test_search_matches_account_name(client, auth, fake_hledger):
    fake_hledger.set_txns([make_txn("2026-01-01", "Something", [("expenses:food:diningout", 5), ("assets:chequing", -5)])])
    resp = client.get("/search", params={"q": "diningout"}, headers=auth)
    assert len(json.loads(resp.json()["raw"])) == 1


def test_accounts_declared_when_accounts_file_set(client, auth, fake_hledger, monkeypatch, env):
    monkeypatch.setenv("ACCOUNTS_FILE", str(env["accounts_file"]))
    fake_hledger.accounts_output = "expenses:food:groceries\n  \nexpenses:food:diningout\n"
    resp = client.get("/accounts", headers=auth)
    assert resp.json() == {"accounts": ["expenses:food:groceries", "expenses:food:diningout"]}
    assert fake_hledger.calls[0] == ("accounts", "--declared")


def test_accounts_fallback_to_journal_accounts(client, auth, fake_hledger):
    fake_hledger.accounts_output = "assets:chequing\n"
    resp = client.get("/accounts", headers=auth)
    assert resp.json() == {"accounts": ["assets:chequing"]}
    assert fake_hledger.calls[0] == ("accounts",)


def test_daily_totals_aggregates_counts_and_totals(client, auth, fake_hledger):
    fake_hledger.set_txns([
        make_txn("2026-01-05", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)]),
        make_txn("2026-01-05", "Snack", [("expenses:food:diningout", 3), ("assets:chequing", -3)]),
    ])
    resp = client.get("/daily-totals", params={"from_date": "2026-01-01"}, headers=auth)
    result = resp.json()
    assert result == [{"date": "2026-01-05", "count": 2, "total": 16.0}]


def test_daily_totals_default_from_date_is_jan_1(client, auth, fake_hledger):
    fake_hledger.set_txns([])
    resp = client.get("/daily-totals", headers=auth)
    assert resp.status_code == 200
    date_filter = fake_hledger.calls[0][fake_hledger.calls[0].index("-p") + 1]
    assert date_filter.startswith(f"{date_filter[:4]}-01-01..")
