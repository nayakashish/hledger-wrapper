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


def get_settings() -> Settings:
    """Read config from the environment. Not cached, so tests can set env
    vars per-test and have the whole app follow on the next request."""
    return Settings(
        journal_dir=os.getenv("JOURNAL_DIR", ""),
        journal_file=os.getenv("JOURNAL_FILE", ""),
        accounts_file=os.getenv("ACCOUNTS_FILE", ""),
        hledger_bin=os.getenv("HLEDGER_BIN", "hledger"),
        bearer_token=os.getenv("BEARER_TOKEN", ""),
        default_currency=os.getenv("DEFAULT_CURRENCY", "$"),
        envelope_data_file=os.getenv("ENVELOPE_DATA_FILE", ""),
        inbox_data_file=os.getenv("INBOX_DATA_FILE", ""),
    )
