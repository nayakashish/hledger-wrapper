# hledger API

FastAPI backend that runs on the home server, wraps the `hledger` CLI, and
commits journal/data-store changes to git. See the root `docs/` for the full
system architecture; this file covers the backend package layout and how to
run its tests.

## Layout

```
api/
├── main.py              # thin entry point: `from app.main import app`
│                         #   (kept so hledger-api.service doesn't change)
├── app/
│   ├── main.py           # app factory: FastAPI(), CORS, include_router
│   ├── config.py          # Settings dataclass, read from env on every call
│   ├── auth.py             # HTTPBearer + verify_token dependency
│   ├── hledger.py           # run_hledger / run_hledger_file + extract_amount
│   ├── git_ops.py            # run_git + git_transaction() atomic wrapper
│   ├── storage.py             # generic load_json / save_json
│   ├── models.py               # pydantic request models
│   └── routers/
│       ├── health.py            # /health
│       ├── reports.py            # /balance /is /monthly /monthly-detail
│       │                         #   /transactions /search /accounts /daily-totals
│       ├── journal.py             # /add /descriptions /lookup /sync
│       ├── envelopes.py            # /envelopes and /envelopes/*
│       └── inbox.py                 # /inbox and /inbox/*
├── requirements.txt
├── requirements-dev.txt    # pytest, httpx, pytest-cov
└── tests/                    # pytest suite — see below
```

Each router builds an `APIRouter`; `app/main.py` includes them all. Config is
read fresh on every request via `get_settings()` (not cached at import time),
so tests can point the app at temp files just by setting env vars.

## Atomic git writes

Every write endpoint wraps its file mutation in `git_ops.git_transaction()`:
the file write and the `git add` / `commit` / `push` are one all-or-nothing
unit. If the push fails or the process crashes mid-write, the working tree is
reset to the pre-write `HEAD` — see `docs/architecture.md` ("Journal Git
Flow") for the full guarantee and its single-writer assumption.

## Testing

```bash
cd api
pip install -r requirements.txt -r requirements-dev.txt
pytest tests --cov=app --cov-report=term-missing
```

The suite mocks `hledger` and `git` at the subprocess boundary (see
`tests/conftest.py`'s `fake_hledger` / `fake_git` fixtures) and points the
JSON stores at `tmp_path`, so it's deterministic, offline, and runs in well
under a second — no real `hledger` binary or git remote needed. It runs in CI
on every push/PR that touches `api/**` (`.github/workflows/api-tests.yml`).

See `docs/api-testing.md` for how the mocking works, what's covered, and why
the numbers can be trusted.
