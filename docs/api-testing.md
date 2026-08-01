# API Testing Suite

The backend (`api/`) is a FastAPI service that wraps the `hledger` CLI and
commits every write to a git-backed journal. For a long time it was a single
1176-line `main.py` with roughly 30 endpoints and zero automated tests — the
only safety net was clicking through the app by hand after a change. This
document describes the package structure that replaced it, the test suite
that now guards it, and the atomic git-write guarantee both were built to
support.

## Package layout

`api/main.py` is now a thin entry point (`from app.main import app`) so the
process manager invoking it doesn't need to change. The actual application
lives in `api/app/`, split by responsibility:

```
api/app/
├── main.py          # app factory: FastAPI(), CORS, include_router
├── config.py         # Settings dataclass, read from the environment on every call
├── auth.py            # HTTPBearer + verify_token dependency
├── hledger.py           # run_hledger / run_hledger_file + decimal-amount extraction
├── git_ops.py             # run_git + the git_transaction() atomic wrapper
├── storage.py              # generic load_json / save_json for the JSON stores
├── models.py                # pydantic request models
└── routers/
    ├── health.py             # liveness check
    ├── reports.py             # read-only balance / transaction endpoints
    ├── journal.py              # journal writes + autocomplete + sync
    ├── envelopes.py             # the envelope-budgeting subsystem
    └── inbox.py                  # the transaction-inbox subsystem
```

Two design choices make the rest of this document possible:

- **Config is a function call, not a module-level constant.** Every endpoint
  reads `get_settings()` per request instead of closing over a value captured
  at import time. That means a test can point `JOURNAL_FILE`,
  `ENVELOPE_DATA_FILE`, and friends at a temp directory just by setting
  environment variables — no import-order tricks required.
- **Auth is a FastAPI dependency**, so it can be exercised directly (send a
  real or wrong bearer token) or left alone when a test isn't about auth.

## What the suite covers

Every route gets at least one happy-path test and one documented error-path
test: missing/wrong auth, 400 validation failures, 404s for unknown
resources, and 503s for missing configuration. On top of the endpoint tests,
the pure helper functions — decimal amount extraction, merchant-name
cleaning, history matching, suggestion scoring, envelope suggestion — are
tested directly with no mocking at all, since they're the easiest thing to
break silently during a refactor.

| Area | File | What it exercises |
|------|------|--------------------|
| Auth | `test_auth.py` | Missing/wrong/valid bearer token, unset server secret |
| Reports | `test_reports.py` | Balance/income/monthly passthrough, month filtering, search, chart-of-accounts source selection, daily-totals aggregation |
| Journal | `test_journal.py` | Structured vs. raw-entry adds, commit/push ordering, rollback on push failure, descriptions/lookup autocomplete, sync |
| Envelopes | `test_envelopes.py` | Scan/dedup, expense drain, income splits, transfers, adjustments, create/delete, protected-envelope and non-zero-balance guards |
| Inbox | `test_inbox.py` | Ingest + three dedup paths (message id, pending, journal match), suggestion attachment, post/dismiss, merchant rules |
| Pure helpers | `test_helpers.py` | Amount extraction, merchant cleaning/tokenizing, history/suggestion matching, envelope suggestion |
| Atomic writes | `test_git_ops.py` | Commit/push ordering, rollback on failure, rollback on a raising caller, lock serialization |

As of this writing that's **106 tests running in under a second**, with
**92% line coverage** on `app/`. The only meaningfully uncovered lines are
inside the thin subprocess wrappers themselves (`run_hledger_file`,
`run_git`) — every test that hits an endpoint exercises them indirectly, but
coverage tooling only credits the call site that's actually mocked out.

## Why the suite can be trusted

A test suite is only as good as what it's actually checking. Three things
back up the numbers above:

1. **Behaviour-preserving refactor, verified structurally.** Before any test
   was written, the new package's route table (path + HTTP methods for all
   ~30 endpoints) was diffed against the original monolith's and found
   identical. The refactor moved code, it didn't change what it does.
2. **A real end-to-end smoke test, before the mocked suite existed.** The
   refactored app was booted against a real scratch git repository (with a
   local bare remote standing in for `origin`) and a real `hledger` binary.
   Every write path — adding a transaction, scanning and assigning an
   envelope transaction, ingesting and posting an inbox item — was driven
   over HTTP and its effect verified in the actual journal file and git log.
   The remote was then pointed at a nonexistent path to force a push
   failure, confirming the working tree really does reset to the pre-write
   commit rather than just returning an error.
3. **The mocked suite exists to catch regressions from here on.** Real
   subprocesses are useful for one-time verification but too slow and
   environment-dependent for a suite that should run on every push. The
   fixtures described below replace `hledger` and `git` with fakes that
   record every call, so the suite stays deterministic and fast while still
   asserting on the exact sequence of operations a real run would perform.

## How the mocking works

Every router imports its dependencies by name — `from ..hledger import
run_hledger`, for example — which binds a local reference at import time.
That means patching `app.hledger.run_hledger` alone would not reach a router
that already imported it under its own name; each import site has to be
patched individually. `tests/conftest.py` handles this with two fixtures:

- **`fake_hledger`** patches every router-local `run_hledger` /
  `run_hledger_file` reference with a callable that records its arguments and
  returns canned output (`fake_hledger.set_txns([...])` for a list of
  transaction dicts, or `fake_hledger.output` / `fake_hledger.accounts_output`
  directly).
- **`fake_git`** patches `run_git` the same way, wherever it's imported. It
  can be told to fail on a specific subcommand (`fake_git.fail_on = "push"`)
  to exercise `git_transaction`'s rollback path without touching a real
  repository.

Supporting fixtures:

- **`env`** points every file-based setting (`JOURNAL_FILE`,
  `ENVELOPE_DATA_FILE`, `INBOX_DATA_FILE`, …) at a pytest `tmp_path` and sets
  a known bearer token, so each test gets an isolated filesystem.
- **`client`** is a `TestClient` built against the app once `env` is active.
- **`seed_envelopes`** / **`seed_inbox`** write a known JSON document to the
  respective data file before a test runs.
- **`make_txn(date, description, postings)`** (in `conftest.py`, not a
  fixture) builds a minimal `hledger print --output-format json` transaction
  dict for use with `fake_hledger.set_txns(...)`.

## The atomic git-write guarantee

Every endpoint that mutates a file — appending to the journal, saving the
envelope or inbox JSON store — does so through `git_ops.git_transaction()`:

```python
with git_transaction([path_to_file], "commit message"):
    # mutate the file(s) here
    ...
```

The context manager records `HEAD` before the block runs, then stages,
commits, and pushes after it. If the mutation itself raises, or the add,
commit, or push fails for any reason, the working tree — including any
commit already created — is reset with `git reset --hard <head>` and the
original exception propagates. A failed push can never leave an unpushed
local commit, and a crash mid-write can never leave a half-committed file.
The whole sequence is guarded by a process-wide lock, so concurrent writers
are serialized rather than interleaved.

This is deliberately built on a single-writer assumption: the journal
repository has no other committer than this API, so a hard reset can't
discard someone else's work. `test_git_ops.py` verifies the call ordering,
the rollback-on-failure path, the rollback-on-raising-mutation path, and that
the lock actually serializes two concurrent callers rather than letting them
interleave.

## Running the suite

```bash
cd api
pip install -r requirements.txt -r requirements-dev.txt
pytest tests --cov=app --cov-report=term-missing
```

No real `hledger` binary and no real git remote are required — everything
the tests touch is mocked or written to a temp directory, so this also works
offline.

## Continuous integration

`.github/workflows/api-tests.yml` runs the same command on every push and
pull request that touches `api/**`. Because the suite is fully hermetic it
needs nothing beyond a Python setup step — no service containers, no
secrets, no network access — so it stays fast and can be made a required
check before merging to the main branch.

## What's out of scope

- **Frontend tests** for the React SPA (`src/frontend/`) — a separate effort.
- **Worker tests** for the email-parsing handler (`src/index.ts`).
- **End-to-end tests against a live server.** Everything here is mocked at
  the subprocess boundary; the one-time real-git/real-`hledger` smoke test
  described above was a manual verification step, not part of the automated
  suite.
