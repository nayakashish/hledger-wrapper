"""Pure-function tests — no mocking, no HTTP, highest value per line."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.hledger import extract_amount
from app.routers.envelopes import _is_income, _main_amount, _suggest_envelope, _txn_id
from app.routers.inbox import (
    _clean_merchant,
    _find_journal_match,
    _history_match,
    _merchant_tokens,
    _suggest_inbox_posting,
)

from conftest import make_txn


# --- extract_amount --------------------------------------------------------

def test_extract_amount_decimal_form():
    posting = {"pamount": [{"aquantity": {"decimalMantissa": 1250, "decimalPlaces": 2}}]}
    assert extract_amount(posting) == 12.50


def test_extract_amount_plain_form():
    posting = {"pamount": [{"aquantity": 7}]}
    assert extract_amount(posting) == 7.0


def test_extract_amount_no_amounts():
    assert extract_amount({"pamount": []}) == 0.0


# --- _clean_merchant ---------------------------------------------------------

def test_clean_merchant_strips_known_prefix():
    assert _clean_merchant("TST-The Samosa Factory") == "The Samosa Factory"


def test_clean_merchant_strips_trailing_store_number():
    assert _clean_merchant("Walmart #1234") == "Walmart"


def test_clean_merchant_no_prefix_no_number():
    assert _clean_merchant("Corner Store") == "Corner Store"


def test_clean_merchant_falls_back_to_original_if_empty_after_strip():
    assert _clean_merchant("SQ *") == "SQ *"


# --- _merchant_tokens --------------------------------------------------------

def test_merchant_tokens_lowercases_and_splits():
    assert _merchant_tokens("The Samosa Factory!!") == {"the", "samosa", "factory"}


def test_merchant_tokens_drops_short_tokens():
    assert _merchant_tokens("A Co") == set()
    assert _merchant_tokens("A Company") == {"company"}


# --- _history_match -----------------------------------------------------------

def test_history_match_exact():
    txns = [make_txn("2026-01-01", "The Samosa Factory", [("expenses:food:diningout", 10), ("assets:chequing", -10)])]
    result = _history_match("The Samosa Factory", txns)
    assert result == ("The Samosa Factory", "expenses:food:diningout", "history:exact")


def test_history_match_token_overlap():
    txns = [make_txn("2026-01-01", "Samosa Factory Downtown", [("expenses:food:diningout", 10), ("assets:chequing", -10)])]
    result = _history_match("The Samosa Factory", txns)
    assert result[1] == "expenses:food:diningout"
    assert result[2] == "history:tokens"


def test_history_match_none():
    txns = [make_txn("2026-01-01", "Completely Unrelated", [("expenses:food:diningout", 10), ("assets:chequing", -10)])]
    assert _history_match("The Samosa Factory", txns) is None


def test_history_match_ignores_non_expense_postings():
    txns = [make_txn("2026-01-01", "The Samosa Factory", [("assets:chequing", -10), ("liabilities:cc", 10)])]
    assert _history_match("The Samosa Factory", txns) is None


# --- _suggest_inbox_posting ----------------------------------------------------

def test_suggest_inbox_posting_rule_match():
    data = {
        "merchant_rules": [{"pattern": "SAMOSA", "account": "expenses:food:diningout", "description": "Samosa Factory"}],
        "card_map": {"1234": "liabilities:creditcard:CIBC"},
    }
    result = _suggest_inbox_posting("TST-The Samosa Factory", 12.50, "1234", data, [])
    assert result["account1"] == "expenses:food:diningout"
    assert result["description"] == "Samosa Factory"
    assert result["confidence"] == "high"
    assert result["matched_on"] == "rule"


def test_suggest_inbox_posting_history_exact():
    data = {"merchant_rules": [], "card_map": {"1234": "liabilities:creditcard:CIBC"}}
    txns = [make_txn("2026-01-01", "The Samosa Factory", [("expenses:food:diningout", 10), ("assets:chequing", -10)])]
    result = _suggest_inbox_posting("The Samosa Factory", 12.50, "1234", data, txns)
    assert result["account1"] == "expenses:food:diningout"
    assert result["confidence"] == "high"
    assert result["matched_on"] == "history:exact"


def test_suggest_inbox_posting_fallback_low_confidence():
    data = {"merchant_rules": [], "card_map": {"1234": "liabilities:creditcard:CIBC"}}
    result = _suggest_inbox_posting("Some New Place", 5.00, "1234", data, [])
    assert result["account1"] == "expenses:uncategorized"
    assert result["confidence"] == "low"
    assert result["matched_on"] == "fallback"


def test_suggest_inbox_posting_unknown_card_forces_low_confidence():
    data = {
        "merchant_rules": [{"pattern": "SAMOSA", "account": "expenses:food:diningout", "description": "Samosa Factory"}],
        "card_map": {},
    }
    result = _suggest_inbox_posting("The Samosa Factory", 12.50, "9999", data, [])
    assert result["confidence"] == "low"
    assert result["account2"] == "liabilities:creditcard:CIBC"  # INBOX_UNKNOWN_CARD_ACCOUNT


def test_suggest_inbox_posting_amounts_and_signs():
    data = {"merchant_rules": [], "card_map": {}}
    result = _suggest_inbox_posting("Some Place", 5.00, "1234", data, [])
    assert result["amount1"] == 5.00
    assert result["amount2"] == -5.00


# --- _find_journal_match -------------------------------------------------------

def test_find_journal_match_within_window():
    txns = [make_txn("2026-01-05", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)])]
    match = _find_journal_match(txns, 5.00, "2026-01-06")
    assert match == {"date": "2026-01-05", "description": "Coffee"}


def test_find_journal_match_outside_window_rejected():
    txns = [make_txn("2026-01-01", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)])]
    assert _find_journal_match(txns, 5.00, "2026-01-10") is None


def test_find_journal_match_zero_amount_never_matches():
    txns = [make_txn("2026-01-05", "Zero", [("expenses:misc", 0), ("assets:chequing", 0)])]
    assert _find_journal_match(txns, 0.0, "2026-01-05") is None


# --- envelope helpers -------------------------------------------------------

def test_is_income_true():
    txn = make_txn("2026-01-01", "Paycheck", [("income:salary", -100), ("assets:chequing", 100)])
    assert _is_income(txn) is True


def test_is_income_false():
    txn = make_txn("2026-01-01", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)])
    assert _is_income(txn) is False


def test_txn_id_stable_for_same_txn():
    txn = make_txn("2026-01-01", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)], tindex=3)
    assert _txn_id(txn) == "2026-01-01|Coffee|3"


def test_main_amount_prefers_expense_posting():
    txn = make_txn("2026-01-01", "Coffee", [("expenses:food:diningout", 5), ("assets:chequing", -5)])
    assert _main_amount(txn) == 5.0


def test_main_amount_fallback_to_first_posting():
    txn = make_txn("2026-01-01", "Transfer", [("assets:savings", 100), ("assets:chequing", -100)])
    assert _main_amount(txn) == 100.0


def test_suggest_envelope_direct_hint():
    txn = make_txn("2026-01-01", "Tithe", [("expenses:generosity:tithe", 50), ("assets:chequing", -50)])
    assert _suggest_envelope(txn, []) == "tithe"


def test_suggest_envelope_name_match():
    envelopes = [{"id": "groceries_env", "name": "Groceries", "parent": "food"}]
    txn = make_txn("2026-01-01", "Store", [("expenses:custom:groceries", 20), ("assets:chequing", -20)])
    assert _suggest_envelope(txn, envelopes) == "groceries_env"


def test_suggest_envelope_default_expense_fallback():
    txn = make_txn("2026-01-01", "Misc", [("expenses:misc:other", 20), ("assets:chequing", -20)])
    assert _suggest_envelope(txn, []) == "chequing"


def test_suggest_envelope_none_for_non_expense():
    txn = make_txn("2026-01-01", "Transfer", [("assets:savings", 100), ("assets:chequing", -100)])
    assert _suggest_envelope(txn, []) is None
