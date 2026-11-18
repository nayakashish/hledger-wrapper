# Deployment Guide

How to set up hledger Mobile from nothing. Do the steps in order. Each one ends
with a check, so you find a mistake before it hides behind the next step. Step
6 is optional (bank-alert emails).

## Prerequisites

- A Linux machine that runs continuously (home server, VPS, or similar)
- [hledger](https://hledger.org/install.html) installed on that machine
- A git repository for your journals, with a remote the service user can pull
  from and push to without a prompt: an SSH key without a passphrase, or an
  HTTPS access token in the git credential store. The API cannot answer a
  password prompt, and a failed push rolls the write back. Test it first:
  run `git pull && git push` in the repo as the service user.
- Python 3.10 or later on the server
- A Cloudflare account (the free tier is sufficient)
- A domain on Cloudflare DNS
- Node.js 18 or later on your development machine
- `wrangler` logged in: `npx wrangler login`

---

## 1. Home server — FastAPI

### Clone and install

```bash
git clone <your-repo-url> ~/hledger-wrapper
cd ~/hledger-wrapper/api
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Lay out the journal repo

Each journal is a folder under `JOURNAL_DIR`. The folder name is the journal
name.

```
journal-repo/
  2026/
    2026.journal        # required; must match the folder name
    accounts.journal    # optional chart of accounts
    envelopes.json      # created on first select
    inbox.json          # created on first select
```

The app lists every folder that holds a matching `<name>.journal`.

### Configure

```bash
cp env.example .env
```

Edit `.env`. These are the required values:

```ini
JOURNAL_DIR=/path/to/journal-repo
APP_CONFIG_FILE=/path/to/journal-repo/app_config.json
BEARER_TOKEN=<strong-random-string>      # openssl rand -hex 32
```

`APP_CONFIG_FILE` stores the journal choices you make in Settings. The server
creates it on first selection. Without it, the app cannot switch journals.

All other variables are optional. See [configuration.md](configuration.md) for
the full list, defaults, and the single-journal fallback for setups that do not
use folders.

### Check it locally

```bash
source venv/bin/activate
uvicorn main:app --host 127.0.0.1 --port 8000 --env-file .env
```

```bash
# Health check (no auth required)
curl http://localhost:8000/health
# → {"status":"ok"}

# Journals (auth required) - lists the folders found
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8000/journals
```

Open the app, go to Settings, and select a journal. Then call `/balance`. An
empty `/journals` list means `JOURNAL_DIR` is wrong or a folder name does not
match its `.journal` file.

### Install it as a systemd service

```bash
sudo cp ~/hledger-wrapper/api/hledger-api.service /etc/systemd/system/
# Edit the service file: set User and the three /path/to/ values
sudo systemctl daemon-reload
sudo systemctl enable hledger-api
sudo systemctl start hledger-api
sudo systemctl status hledger-api
```

To read the logs:

```bash
journalctl -u hledger-api -f
```

---

## 2. Cloudflare Tunnel

The tunnel publishes FastAPI to the internet. The server keeps all inbound
ports closed, because the tunnel connects outward.

```bash
# Install cloudflared on the server
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Authenticate
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create hledger

# Route a subdomain to the tunnel
cloudflared tunnel route dns hledger api.yourdomain.com

# Install as a systemd service
cloudflared service install
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <your-tunnel-id>
credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: api.yourdomain.com
    service: http://localhost:8000
  - service: http_status:404
```

```bash
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

Check it: `curl https://api.yourdomain.com/health` must return
`{"status":"ok"}`.

---

## 3. Cloudflare Access

Access stands in front of the tunnel. It stops unauthenticated requests before
they reach the server.

In the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/):

1. **Applications → Add an application → Self-hosted**
   - Application name: hledger API
   - Domain: `api.yourdomain.com`
   - Session duration: 24 hours or longer

2. **Add a policy** that allows your email address, through a one-time PIN or
   your identity provider.

3. **Service Tokens → Create service token**
   - Name: hledger-worker
   - Copy the **Client ID** and the **Client Secret** now. Cloudflare shows the
     secret only once.

4. **Add a second policy** on the same application:
   - Action: Service Auth
   - Rule: Service Token → hledger-worker

The second policy lets the Worker call the API with the service token, so the
Worker does not go through the browser login.

---

## 4. Cloudflare Worker — secrets

```bash
cd hledger-worker
npm install

wrangler secret put API_BASE_URL
# → https://api.yourdomain.com

wrangler secret put BEARER_TOKEN
# → same value as BEARER_TOKEN in your .env

wrangler secret put CF_ACCESS_CLIENT_ID
# → Client ID from step 3

wrangler secret put CF_ACCESS_CLIENT_SECRET
# → Client Secret from step 3
```

Set `FORWARD_VERIFICATION_EMAIL` in the `vars` block of `wrangler.jsonc` to
your own address. Replace the value already in the file. It is needed only for
step 6.

---

## 5. Deploy

```bash
cd hledger-worker
npm run deploy
# runs: vite build && wrangler deploy
```

By default the Worker is deployed to
`<worker-name>.<your-subdomain>.workers.dev`. For a custom domain, add a Worker
Route in the Cloudflare dashboard.

Put Cloudflare Access in front of the Worker URL too, with a policy that allows
only you. Step 3 protects the API hostname only; without this, anyone can open
the app shell.

Check it: `curl https://<worker-url>/api/health` returns `{"status":"ok"}`.

---

## 6. Bank-alert emails (optional)

Skip this step if you do not use the [Transaction Inbox](transaction-inbox.md).
The Worker only handles the alert email. The server must already be reachable
(step 5).

1. In the Cloudflare dashboard, enable **Email Routing** on your domain.
2. Add a **custom address** (for example `alerts@yourdomain.com`) with the
   action **Send to a Worker**, and choose `hledger-worker`.
3. Add your own address as a verified destination, and confirm the link
   Cloudflare sends.
4. In Gmail, add the alert address as a forwarding address. Gmail sends a
   confirmation email, and the Worker forwards it to
   `FORWARD_VERIFICATION_EMAIL`. Open the link in it.
5. Create a Gmail filter on your bank's alert sender: **Forward it to** the
   alert address.
6. In the app, open Settings and pick the **Inbox / email journal**. Without
   it, the server rejects every alert.

Check it: forward one old alert to the alert address. A pending item appears
in the Inbox within a minute.

Bank parsers are in `hledger-worker/src/index.ts` (`BANK_PARSERS`). Only one
bank is included. Add a parser for your own bank.

---

## 7. Check the whole path

1. Open the Worker URL in a browser.
2. Confirm that the React app loads.
3. Tap **Sync**. The button spins, then shows a timestamp.
4. Open the Reports tab and tap **Balance**. Your account tree appears.
   If the list is empty, select a journal in Settings first.
5. Install the app with "Add to Home Screen" on iOS or Android.

---

## Local development

```bash
cd hledger-worker
npm run dev
# Vite dev server on http://localhost:5173
# Worker runs via @cloudflare/vite-plugin
```

The Worker calls your deployed API. To use a local API instead, set
`API_BASE_URL=http://127.0.0.1:8000` in `.dev.vars`. Put the secrets in
`hledger-worker/.dev.vars` (gitignored; never commit it):

```ini
API_BASE_URL=https://api.yourdomain.com
BEARER_TOKEN=your-token
CF_ACCESS_CLIENT_ID=your-client-id
CF_ACCESS_CLIENT_SECRET=your-client-secret
```

After you change the bindings in `wrangler.jsonc`:

```bash
npm run cf-typegen   # regenerates worker-configuration.d.ts
```

---

## Reference

The endpoint list is in [api-reference.md](api-reference.md). Every setting is in
[configuration.md](configuration.md).

For the other reference documents, see the [documentation index](README.md).
