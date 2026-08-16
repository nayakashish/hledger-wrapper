import json
import os
from dataclasses import dataclass


@dataclass
class Settings:
    journal_dir: str
    journal_file: str
    accounts_file: str  # chart-of-accounts journal (account directives)
    hledger_bin: str
    bearer_token: str
    default_currency: str
    envelope_data_file: str
    inbox_data_file: str
    active_journal: str  # selected journal folder name, "" when none is selected


def _app_config_file() -> str:
    return os.getenv("APP_CONFIG_FILE", "")


def load_app_config() -> dict:
    """Read the UI-editable app config (currently just the active journal).
    Returns {} when unset, missing, or unreadable, so the app falls back to the
    JOURNAL_FILE/... env vars."""
    path = _app_config_file()
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def save_app_config(data: dict) -> None:
    """Persist the app config. Raises if APP_CONFIG_FILE is unset."""
    path = _app_config_file()
    if not path:
        raise RuntimeError("APP_CONFIG_FILE not configured")
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def active_journal_name() -> str:
    """Name of the currently selected journal folder, or "" if none."""
    return str(load_app_config().get("active_journal", "") or "")


def inbox_journal_name() -> str:
    """Name of the journal inbound bank-alert emails are routed to,
    independent of active_journal, or "" if none is set. See
    docs/transaction-inbox.md for why this is a separate pointer."""
    return str(load_app_config().get("inbox_journal", "") or "")


DEMO_JOURNAL_NAME = "demo"


def is_demo_journal(name: str) -> bool:
    """The demo journal (see temp/resources/demo-journal) is a real,
    selectable journal for browsing, identified by its fixed folder name, but
    must never be a valid email-ingest target."""
    return name == DEMO_JOURNAL_NAME


def journal_paths(journal_dir: str, name: str) -> dict:
    """Resolve the files that make up one journal.

    A journal is a self-contained folder ``<journal_dir>/<name>/`` holding
    ``<name>.journal`` plus its sidecars. ``accounts_file`` is "" when the
    folder has no accounts.journal, so /accounts falls back to
    journal-derived accounts."""
    base = os.path.join(journal_dir, name)
    accounts = os.path.join(base, "accounts.journal")
    return {
        "dir": base,
        "journal_file": os.path.join(base, f"{name}.journal"),
        "accounts_file": accounts if os.path.exists(accounts) else "",
        "envelope_data_file": os.path.join(base, "envelopes.json"),
        "inbox_data_file": os.path.join(base, "inbox.json"),
    }


def list_journals(journal_dir: str) -> list[str]:
    """Selectable journals: immediate subfolders of ``journal_dir`` that
    contain a matching ``<name>.journal`` file, sorted by name."""
    if not journal_dir or not os.path.isdir(journal_dir):
        return []
    names = []
    for entry in sorted(os.listdir(journal_dir)):
        folder = os.path.join(journal_dir, entry)
        if os.path.isdir(folder) and os.path.exists(os.path.join(folder, f"{entry}.journal")):
            names.append(entry)
    return names


def get_settings() -> Settings:
    """Read config from the environment. Not cached, so tests can set env
    vars per-test and have the whole app follow on the next request.

    When a journal is selected in the app (``app_config.json``'s
    ``active_journal``), the journal/accounts/envelopes/inbox paths resolve
    from that journal's folder instead of the ``JOURNAL_FILE``/... env vars.
    The env vars remain the fallback when nothing is selected, so a setup that
    has never used the switcher keeps working unchanged."""
    journal_dir = os.getenv("JOURNAL_DIR", "")
    journal_file = os.getenv("JOURNAL_FILE", "")
    accounts_file = os.getenv("ACCOUNTS_FILE", "")
    envelope_data_file = os.getenv("ENVELOPE_DATA_FILE", "")
    inbox_data_file = os.getenv("INBOX_DATA_FILE", "")

    active = active_journal_name()
    if active and journal_dir:
        paths = journal_paths(journal_dir, active)
        journal_file = paths["journal_file"]
        accounts_file = paths["accounts_file"]
        envelope_data_file = paths["envelope_data_file"]
        inbox_data_file = paths["inbox_data_file"]

    return Settings(
        journal_dir=journal_dir,
        journal_file=journal_file,
        accounts_file=accounts_file,
        hledger_bin=os.getenv("HLEDGER_BIN", "hledger"),
        bearer_token=os.getenv("BEARER_TOKEN", ""),
        default_currency=os.getenv("DEFAULT_CURRENCY", "$"),
        envelope_data_file=envelope_data_file,
        inbox_data_file=inbox_data_file,
        active_journal=active,
    )
