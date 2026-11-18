# Configuration

Every setting, where it lives, and what happens when it is missing.

## Server environment

Set in `api/.env`. The server reads them on every request, so a restart is
needed only after you edit the file (`sudo systemctl restart hledger-api`).

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `JOURNAL_DIR` | Yes | none | Git repo that holds one folder per journal |
| `BEARER_TOKEN` | Yes | none | API secret. Unset returns `500` on every authenticated call |
| `APP_CONFIG_FILE` | Yes, to switch journals | none | Server-local JSON holding the journal choices |
| `DEFAULT_CURRENCY` | No | `$` | Currency symbol for new entries |
| `HLEDGER_BIN` | No | `hledger` | Path to the binary, if not on `PATH` |
| `JOURNAL_FILE` | Fallback | none | Single journal file, used until a journal is selected |
| `ACCOUNTS_FILE` | Fallback | none | Chart-of-accounts file for the fallback journal |
| `ENVELOPE_DATA_FILE` | Fallback | none | Envelope store for the fallback journal |
| `INBOX_DATA_FILE` | Fallback | none | Inbox store for the fallback journal |

Once a journal is selected, the four fallback variables are ignored.

## Selected journals

`APP_CONFIG_FILE` holds two independent pointers:

```json
{"active_journal": "2026", "inbox_journal": "2026"}
```

| Key | Set in | Controls |
|-----|--------|----------|
| `active_journal` | Settings → Journal | What every screen shows |
| `inbox_journal` | Settings → Inbox / email journal | Where bank-alert emails land |

The two never follow each other. Switching the view cannot redirect alerts. If
`inbox_journal` is unset or invalid, ingest returns `503` and the alert stays in
Gmail. The `demo` journal can be viewed but never chosen for inbox.

## Journal folder

| File | Required | Created |
|------|----------|---------|
| `<name>/<name>.journal` | Yes | By you |
| `<name>/accounts.journal` | No | By you. Without it, `/accounts` lists accounts used in the journal |
| `<name>/envelopes.json` | No | On first select |
| `<name>/inbox.json` | No | On first select |

## Worker

| Name | Kind | Set with | Purpose |
|------|------|----------|---------|
| `API_BASE_URL` | Secret | `wrangler secret put` | Public API hostname |
| `BEARER_TOKEN` | Secret | `wrangler secret put` | Must equal the server value |
| `CF_ACCESS_CLIENT_ID` | Secret | `wrangler secret put` | Access service token ID |
| `CF_ACCESS_CLIENT_SECRET` | Secret | `wrangler secret put` | Access service token secret |
| `FORWARD_VERIFICATION_EMAIL` | Var | `wrangler.jsonc` | Your address. Receives Gmail's forwarding confirmation and is trusted for manual forwards |

Local development reads the same names from `hledger-worker/.dev.vars`.

## Browser storage

The app keeps these keys in `localStorage`. Each is tagged with the journal it
belongs to and is cleared when another device switches journals.

| Key | Holds |
|-----|-------|
| `hledger_cache` | Reports and transactions |
| `hledger_envelopes_v3` | Envelope data |
| `hledger_accounts`, `hledger_descriptions` | Autocomplete lists |
| `hledger_active_journal` | Journal the cache belongs to |
| `hledger_last_sync` | Last sync time |

To reset a device, clear the site data for the app.
