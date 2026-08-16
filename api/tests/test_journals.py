"""Tests for the /journals list + select endpoints."""
import json

import pytest
from fastapi.testclient import TestClient

TOKEN = "test-token"


@pytest.fixture
def journals_env(tmp_path, monkeypatch):
    """A JOURNAL_DIR with folder-per-journal layout and an app_config path."""
    root = tmp_path / "ledger"
    root.mkdir()
    for name in ("2026", "2027"):
        folder = root / name
        folder.mkdir()
        (folder / f"{name}.journal").write_text("")
    # 2026 already has envelopes/inbox; 2027 is fresh (no sidecars yet).
    (root / "2026" / "envelopes.json").write_text(json.dumps({"envelopes": [{"id": "x"}]}))
    (root / "2026" / "inbox.json").write_text(json.dumps({"items": []}))

    cfg = tmp_path / "app_config.json"
    monkeypatch.setenv("JOURNAL_DIR", str(root))
    monkeypatch.setenv("APP_CONFIG_FILE", str(cfg))
    monkeypatch.setenv("BEARER_TOKEN", TOKEN)
    monkeypatch.delenv("JOURNAL_FILE", raising=False)
    monkeypatch.delenv("ENVELOPE_DATA_FILE", raising=False)
    monkeypatch.delenv("INBOX_DATA_FILE", raising=False)
    return {"root": root, "cfg": cfg}


@pytest.fixture
def client(journals_env):
    from app.main import app
    return TestClient(app)


@pytest.fixture
def auth():
    return {"Authorization": f"Bearer {TOKEN}"}


def test_list_journals_flags_active(client, auth, journals_env):
    journals_env["cfg"].write_text(json.dumps({"active_journal": "2027"}))
    resp = client.get("/journals", headers=auth)
    assert resp.status_code == 200
    assert resp.json()["journals"] == [
        {"name": "2026", "active": False},
        {"name": "2027", "active": True},
    ]


def test_list_journals_requires_auth(client):
    assert client.get("/journals").status_code in (401, 403)


def test_select_journal_persists_and_seeds_fresh_sidecars(client, auth, journals_env):
    resp = client.post("/journals/select", json={"name": "2027"}, headers=auth)
    assert resp.status_code == 200
    assert resp.json()["active_journal"] == "2027"

    # Selection persisted.
    assert json.loads(journals_env["cfg"].read_text())["active_journal"] == "2027"

    # 2027 was fresh -> envelopes/inbox seeded with empty stores.
    root = journals_env["root"]
    env_data = json.loads((root / "2027" / "envelopes.json").read_text())
    inbox_data = json.loads((root / "2027" / "inbox.json").read_text())
    assert env_data["envelopes"] == [] and env_data["pending"] == []
    assert inbox_data["items"] == [] and inbox_data["merchant_rules"] == []


def test_select_journal_does_not_clobber_existing_sidecars(client, auth, journals_env):
    client.post("/journals/select", json={"name": "2026"}, headers=auth)
    # 2026 already had data -> left untouched.
    env_data = json.loads((journals_env["root"] / "2026" / "envelopes.json").read_text())
    assert env_data == {"envelopes": [{"id": "x"}]}


def test_select_unknown_journal_rejected(client, auth, journals_env):
    resp = client.post("/journals/select", json={"name": "1999"}, headers=auth)
    assert resp.status_code == 400
    # Nothing persisted.
    assert not journals_env["cfg"].exists() or "active_journal" not in json.loads(
        journals_env["cfg"].read_text()
    )


def test_select_rejects_path_traversal(client, auth):
    resp = client.post("/journals/select", json={"name": "../secrets"}, headers=auth)
    assert resp.status_code == 400
