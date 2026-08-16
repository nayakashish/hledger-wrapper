def test_no_credentials_returns_403(client):
    resp = client.get("/balance")
    assert resp.status_code == 403


def test_wrong_token_returns_401(client, fake_hledger):
    resp = client.get("/balance", headers={"Authorization": "Bearer wrong-token"})
    assert resp.status_code == 401


def test_bearer_token_unset_returns_500(client, monkeypatch, fake_hledger):
    monkeypatch.setenv("BEARER_TOKEN", "")
    resp = client.get("/balance", headers={"Authorization": "Bearer anything"})
    assert resp.status_code == 500
    assert "misconfigured" in resp.json()["detail"].lower()


def test_correct_token_succeeds(client, auth, fake_hledger):
    resp = client.get("/balance", headers=auth)
    assert resp.status_code == 200


def test_health_requires_no_auth(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
