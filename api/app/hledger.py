import subprocess

from fastapi import HTTPException

from .config import get_settings


def run_hledger(*args: str) -> str:
    """Run an hledger command against the configured journal file and return stdout."""
    settings = get_settings()
    if not settings.journal_file:
        raise HTTPException(status_code=500, detail="Server misconfigured: JOURNAL_FILE not set")
    return run_hledger_file(settings.journal_file, *args)


def run_hledger_file(journal_file: str, *args: str) -> str:
    """Run an hledger command against a specific journal file and return stdout."""
    settings = get_settings()
    cmd = [settings.hledger_bin, "-f", journal_file, *args]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail=f"hledger binary not found at: {settings.hledger_bin}")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="hledger command timed out")

    if result.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"hledger error: {result.stderr.strip()}"
        )
    return result.stdout


def extract_amount(posting: dict) -> float:
    """Extract a posting's primary amount, handling hledger's decimal JSON form."""
    amounts = posting.get("pamount", [])
    if not amounts:
        return 0.0
    a = amounts[0]
    q = a.get("aquantity", {})
    if isinstance(q, dict):
        return float(q.get("decimalMantissa", 0)) / (10 ** q.get("decimalPlaces", 0))
    return float(q or 0)
