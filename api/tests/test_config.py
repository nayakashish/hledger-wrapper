"""Tests for journal-folder resolution in config.get_settings().

A journal is a self-contained folder under JOURNAL_DIR. Selecting one
(app_config.json's active_journal) repoints journal/accounts/envelopes/inbox
at that folder; with nothing selected, the JOURNAL_FILE/... env vars win.
"""
import json
import os

import pytest

from app.config import (
    get_settings,
    journal_paths,
    list_journals,
    load_app_config,
    save_app_config,
)


def _make_journal(journal_dir, name, *, accounts=False):
    """Create a journal folder <journal_dir>/<name>/<name>.journal (+ optional
    accounts.journal) and return the folder path."""
    folder = journal_dir / name
    folder.mkdir()
    (folder / f"{name}.journal").write_text("")
    if accounts:
        (folder / "accounts.journal").write_text("")
    return folder


@pytest.fixture
def journal_root(tmp_path, monkeypatch):
    """A JOURNAL_DIR with two journal folders and an app_config.json path,
    with the folder-overriding env vars cleared so only selection drives paths."""
    root = tmp_path / "ledger"
    root.mkdir()
    _make_journal(root, "2026", accounts=True)
    _make_journal(root, "2027")

    cfg = tmp_path / "app_config.json"
    monkeypatch.setenv("JOURNAL_DIR", str(root))
    monkeypatch.setenv("APP_CONFIG_FILE", str(cfg))
    # Clear the env fallbacks so a test asserting env-fallback can set them itself.
    monkeypatch.delenv("JOURNAL_FILE", raising=False)
    monkeypatch.delenv("ACCOUNTS_FILE", raising=False)
    monkeypatch.delenv("ENVELOPE_DATA_FILE", raising=False)
    monkeypatch.delenv("INBOX_DATA_FILE", raising=False)
    return {"root": root, "cfg": cfg}


def test_list_journals_finds_folders_with_matching_journal(journal_root):
    root = journal_root["root"]
    # A stray folder without a matching <name>.journal is ignored.
    (root / "notes").mkdir()
    (root / "notes" / "random.journal").write_text("")
    assert list_journals(str(root)) == ["2026", "2027"]


def test_list_journals_empty_when_dir_missing():
    assert list_journals("/nonexistent/path") == []
    assert list_journals("") == []


def test_journal_paths_resolves_folder_contents(journal_root):
    root = journal_root["root"]
    paths = journal_paths(str(root), "2026")
    assert paths["journal_file"] == str(root / "2026" / "2026.journal")
    assert paths["accounts_file"] == str(root / "2026" / "accounts.journal")
    assert paths["envelope_data_file"] == str(root / "2026" / "envelopes.json")
    assert paths["inbox_data_file"] == str(root / "2026" / "inbox.json")


def test_journal_paths_accounts_blank_when_absent(journal_root):
    root = journal_root["root"]
    # 2027 has no accounts.journal -> accounts_file resolves to "" (falls back).
    assert journal_paths(str(root), "2027")["accounts_file"] == ""


def test_get_settings_uses_selected_journal(journal_root):
    root = journal_root["root"]
    save_app_config({"active_journal": "2027"})

    s = get_settings()
    assert s.active_journal == "2027"
    assert s.journal_file == str(root / "2027" / "2027.journal")
    assert s.envelope_data_file == str(root / "2027" / "envelopes.json")
    assert s.inbox_data_file == str(root / "2027" / "inbox.json")
    assert s.accounts_file == ""  # 2027 has no accounts.journal


def test_get_settings_falls_back_to_env_when_nothing_selected(journal_root, monkeypatch):
    # No app_config written -> selection is empty -> env vars win.
    monkeypatch.setenv("JOURNAL_FILE", "/data/legacy/2026.journal")
    monkeypatch.setenv("ENVELOPE_DATA_FILE", "/data/legacy/envelopes.json")

    s = get_settings()
    assert s.active_journal == ""
    assert s.journal_file == "/data/legacy/2026.journal"
    assert s.envelope_data_file == "/data/legacy/envelopes.json"


def test_load_app_config_tolerates_missing_and_corrupt(journal_root):
    cfg = journal_root["cfg"]
    assert load_app_config() == {}  # not written yet

    cfg.write_text("{ not valid json")
    assert load_app_config() == {}  # corrupt -> {} rather than raising


def test_save_then_load_app_config_roundtrips(journal_root):
    save_app_config({"active_journal": "2026"})
    assert load_app_config() == {"active_journal": "2026"}
    assert json.loads(journal_root["cfg"].read_text()) == {"active_journal": "2026"}


def test_save_app_config_requires_configured_path(monkeypatch):
    monkeypatch.delenv("APP_CONFIG_FILE", raising=False)
    with pytest.raises(RuntimeError):
        save_app_config({"active_journal": "2026"})
