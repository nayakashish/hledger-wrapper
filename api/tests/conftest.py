import json
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

TOKEN = "test-token"


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Point every config-driven file path at tmp_path and set a known
    bearer token. Config is read fresh on every request (get_settings() is
    not cached), so setting env vars per-test is enough for the whole app
    to follow."""
    journal_file = tmp_path / "2026.journal"
    journal_file.write_text("")
    accounts_file = tmp_path / "2026accounts.journal"
    accounts_file.write_text("")
    envelope_file = tmp_path / "envelope.json"
    inbox_file = tmp_path / "inbox.json"

    monkeypatch.setenv("JOURNAL_DIR", str(tmp_path))
    monkeypatch.setenv("JOURNAL_FILE", str(journal_file))
    monkeypatch.setenv("ACCOUNTS_FILE", "")
    monkeypatch.setenv("HLEDGER_BIN", "hledger")
    monkeypatch.setenv("BEARER_TOKEN", TOKEN)
    monkeypatch.setenv("DEFAULT_CURRENCY", "$")
    monkeypatch.setenv("ENVELOPE_DATA_FILE", str(envelope_file))
    monkeypatch.setenv("INBOX_DATA_FILE", str(inbox_file))

    return {
        "tmp_path": tmp_path,
        "journal_file": journal_file,
        "accounts_file": accounts_file,
        "envelope_file": envelope_file,
        "inbox_file": inbox_file,
    }


@pytest.fixture
def client(env):
    from app.main import app
    return TestClient(app)


@pytest.fixture
def auth():
    return {"Authorization": f"Bearer {TOKEN}"}


class FakeHledger:
    """Records every call and returns canned output. `output` backs
    `print`/`balance`/`is` calls; `accounts_output` backs `accounts` calls
    (both the journal-accounts and --declared forms)."""

    def __init__(self):
        self.calls: list[tuple] = []
        self.output = "[]"
        self.accounts_output = ""

    def __call__(self, *args):
        self.calls.append(args)
        if args and args[0] == "accounts":
            return self.accounts_output
        return self.output

    def set_txns(self, txns: list[dict]) -> None:
        self.output = json.dumps(txns)


@pytest.fixture
def fake_hledger(env, monkeypatch):
    """Patch every router-local `run_hledger` / `run_hledger_file` binding.
    Each router did `from ..hledger import run_hledger`, which binds a local
    name at import time, so patching app.hledger.run_hledger alone would not
    reach the routers — every import site has to be patched individually."""
    fake = FakeHledger()

    def fake_file(_journal_file, *args):
        return fake(*args)

    monkeypatch.setattr("app.hledger.run_hledger", fake)
    monkeypatch.setattr("app.hledger.run_hledger_file", fake_file)
    monkeypatch.setattr("app.routers.reports.run_hledger", fake)
    monkeypatch.setattr("app.routers.reports.run_hledger_file", fake_file)
    monkeypatch.setattr("app.routers.journal.run_hledger", fake)
    monkeypatch.setattr("app.routers.envelopes.run_hledger", fake)
    monkeypatch.setattr("app.routers.inbox.run_hledger", fake)
    return fake


class FakeGit:
    """Records every git call in order. Set `fail_on` to a subcommand name
    (e.g. "push") to make that call raise, exercising git_transaction's
    rollback path."""

    def __init__(self):
        self.calls: list[tuple] = []
        self.fail_on: str | None = None
        self.head = "deadbeefcafe"

    def __call__(self, *args):
        self.calls.append(args)
        if self.fail_on and args and args[0] == self.fail_on:
            raise HTTPException(status_code=500, detail=f"git error: simulated {args[0]} failure")
        if args[:2] == ("rev-parse", "HEAD"):
            return self.head + "\n"
        if args and args[0] == "pull":
            return "Already up to date.\n"
        return ""


@pytest.fixture
def fake_git(env, monkeypatch):
    fake = FakeGit()
    monkeypatch.setattr("app.git_ops.run_git", fake)
    monkeypatch.setattr("app.routers.journal.run_git", fake)
    return fake


@pytest.fixture
def seed_envelopes(env):
    def _seed(data: dict) -> None:
        env["envelope_file"].write_text(json.dumps(data))
    return _seed


@pytest.fixture
def seed_inbox(env):
    def _seed(data: dict) -> None:
        env["inbox_file"].write_text(json.dumps(data))
    return _seed


def make_txn(date: str, description: str, postings: list[tuple[str, float]], tindex: int = 1) -> dict:
    """Build a minimal hledger `print --output-format json` transaction dict.
    postings: list of (account, amount) with amount already signed."""
    return {
        "tdate": date,
        "tdescription": description,
        "tpayee": description,
        "tnote": "",
        "tcomment": "",
        "tindex": tindex,
        "tpostings": [
            {
                "paccount": acct,
                "pamount": [{"acommodity": "$", "aquantity": {"decimalMantissa": round(amt * 100), "decimalPlaces": 2}}],
                "pcomment": "",
            }
            for acct, amt in postings
        ],
    }
