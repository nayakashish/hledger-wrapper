"""Tests for /presets — the add-transaction preset resolution."""
import json

from conftest import make_txn


def _by_id(resp) -> dict:
    return {p["id"]: p for p in resp.json()["presets"]}


def test_presets_requires_auth(client):
    assert client.get("/presets").status_code == 403


def test_pay_card_resolves_accounts_and_title_from_history(client, auth, fake_hledger):
    fake_hledger.set_txns([
        make_txn("2026-09-06", "CIBC MC Payment", [
            ("liabilities:creditcard:CIBC", 45.01),
            ("assets:TD:chequing", -45.01),
        ]),
    ])
    card = _by_id(client.get("/presets", headers=auth))["pay-card"]
    assert card["debit"]["account"] == "liabilities:creditcard:CIBC"
    assert card["credit"]["account"] == "assets:TD:chequing"
    # The wording carries "MC", which no account name contains — the only way
    # to get it is to reuse the description.
    assert card["title"] == "CIBC MC Payment"
    assert card["source"] == "shape"


def test_receive_etransfer_hint_beats_a_more_recent_paycheque(client, auth, fake_hledger):
    """Both are "assets up, income down"; only the wording separates them, and
    the paycheque is the more recent of the two."""
    fake_hledger.set_txns([
        make_txn("2026-08-11", "Name e-transfer", [
            ("assets:TD:chequing", 11.25),
            ("income:reimbursements", -11.25),
        ]),
        make_txn("2026-08-30", "Payroll", [
            ("assets:TD:chequing", 2000.00),
            ("income:job", -2000.00),
        ]),
    ])
    recv = _by_id(client.get("/presets", headers=auth))["receive-etransfer"]
    assert recv["credit"]["account"] == "income:reimbursements"
    assert recv["source"] == "description+shape"


def test_etransfer_titles_are_templates_not_history(client, auth, fake_hledger):
    fake_hledger.set_txns([
        make_txn("2026-08-11", "Name e-transfer", [
            ("assets:TD:chequing", 11.25),
            ("income:reimbursements", -11.25),
        ]),
        make_txn("2026-07-21", "Transfer to Name", [
            ("expenses:entertainment:wfriends", 13.39),
            ("assets:TD:chequing", -13.39),
        ]),
    ])
    presets = _by_id(client.get("/presets", headers=auth))
    assert presets["receive-etransfer"]["title"] == "e-transfer from {name}"
    assert presets["send-etransfer"]["title"] == "e-transfer to {name}"
    assert presets["receive-etransfer"]["asks_party"] is True


def test_shape_match_ignores_wrong_sign(client, auth, fake_hledger):
    """A refund to the card is the same two accounts with the signs swapped,
    and must not be mistaken for a payment."""
    fake_hledger.set_txns([
        make_txn("2026-09-06", "Refund", [
            ("assets:TD:chequing", 45.01),
            ("liabilities:creditcard:CIBC", -45.01),
        ]),
    ])
    card = _by_id(client.get("/presets", headers=auth))["pay-card"]
    assert card["debit"]["account"] == ""
    assert card["source"] == "none"


def test_falls_back_to_stored_when_journal_has_no_history(client, auth, fake_hledger, env, monkeypatch):
    stored = env["tmp_path"] / "presets.json"
    stored.write_text(json.dumps({"resolved": {"pay-card": {
        "debit": "liabilities:creditcard:CIBC",
        "credit": "assets:TD:chequing",
        "title": "CIBC MC Payment",
    }}}))
    monkeypatch.setenv("PRESETS_DATA_FILE", str(stored))
    fake_hledger.set_txns([])

    card = _by_id(client.get("/presets", headers=auth))["pay-card"]
    assert card["debit"]["account"] == "liabilities:creditcard:CIBC"
    assert card["title"] == "CIBC MC Payment"
    assert card["source"] == "remembered"


def test_history_wins_over_stored(client, auth, fake_hledger, env, monkeypatch):
    stored = env["tmp_path"] / "presets.json"
    stored.write_text(json.dumps({"resolved": {"pay-card": {
        "debit": "liabilities:old", "credit": "assets:old", "title": "Old",
    }}}))
    monkeypatch.setenv("PRESETS_DATA_FILE", str(stored))
    fake_hledger.set_txns([
        make_txn("2026-09-06", "New Payment", [
            ("liabilities:new", 10.0), ("assets:new", -10.0),
        ]),
    ])
    card = _by_id(client.get("/presets", headers=auth))["pay-card"]
    assert card["debit"]["account"] == "liabilities:new"
    assert card["title"] == "New Payment"


def test_picked_legs_are_flagged_and_filtered(client, auth, fake_hledger):
    fake_hledger.set_txns([])
    presets = _by_id(client.get("/presets", headers=auth))
    expense = presets["expense"]
    assert expense["debit"]["pick"] is True
    assert expense["debit"]["prefixes"] == "expenses:"
    assert expense["credit"]["pick"] is False
    assert expense["primary"] is True
    transfer = presets["transfer"]
    assert transfer["debit"]["label"] == "To"
    assert transfer["credit"]["label"] == "From"


def test_standard_is_free_form_and_last(client, auth, fake_hledger):
    fake_hledger.set_txns([])
    presets = client.get("/presets", headers=auth).json()["presets"]
    assert presets[-1]["id"] == "standard"
    assert presets[-1]["free_form"] is True
    assert "debit" not in presets[-1]
