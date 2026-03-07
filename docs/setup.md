# API Setup & Local Testing

## 1. Clone the repo onto the Linux machine

```bash
cd /home/server
git clone <your-repo-url> hledger_wrapper
cd hledger_wrapper/api
```

## 2. Create a virtual environment and install dependencies

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## 3. Create your .env file

```bash
cp .env.example .env
nano .env
```

Fill in:
- `JOURNAL_DIR` — the absolute path to your journal directory (the one git remote -v pointed to)
- `BEARER_TOKEN` — generate a strong one with: `openssl rand -hex 32`
- `DEFAULT_CURRENCY` — `$`

## 4. Run the API locally

```bash
source venv/bin/activate
uvicorn main:app --host 127.0.0.1 --port 8000 --env-file .env
```

You should see:
```
INFO:     Started server process
INFO:     Uvicorn running on http://127.0.0.1:8000
```

---

## 5. Curl tests

Replace `YOUR_TOKEN` with the value you put in `BEARER_TOKEN`.

**Health check (no auth)**
```bash
curl http://localhost:8000/health
```
Expected: `{"status":"ok"}`

**Accounts**
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8000/accounts
```
Expected: `{"accounts":["expenses:food","assets:checking", ...]}`

**Balance**
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8000/balance
```

**Income statement**
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8000/is
```

**Monthly**
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8000/monthly
```

**Recent transactions (last 10)**
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" "http://localhost:8000/transactions?limit=10"
```

**Sync (git pull)**
```bash
curl -X POST -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8000/sync
```

**Add a transaction (v2 — skip this for now if testing v1 only)**
```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "date": "2026-03-07",
    "description": "Test transaction",
    "account1": "expenses:food",
    "amount1": 12.50,
    "account2": "assets:checking"
  }' \
  http://localhost:8000/add
```

---

## 6. Install as a systemd service (after local testing passes)

```bash
sudo cp hledger-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable hledger-api
sudo systemctl start hledger-api
sudo systemctl status hledger-api
```

To view logs:
```bash
journalctl -u hledger-api -f
```