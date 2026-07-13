import subprocess
import threading
from contextlib import contextmanager
from typing import Iterator

from fastapi import HTTPException

from .config import get_settings

# Serializes every mutating git operation across endpoints (add, envelopes,
# inbox), closing the read-modify-write race that used to exist between
# concurrent writers to the same JSON store.
_git_lock = threading.Lock()


def run_git(*args: str) -> str:
    """Run a git command in JOURNAL_DIR and return stdout."""
    settings = get_settings()
    if not settings.journal_dir:
        raise HTTPException(status_code=500, detail="Server misconfigured: JOURNAL_DIR not set")
    cmd = ["git", *args]
    try:
        result = subprocess.run(
            cmd,
            cwd=settings.journal_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="git command timed out")

    if result.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"git error: {result.stderr.strip()}"
        )
    return result.stdout


@contextmanager
def git_transaction(paths: list[str], message: str) -> Iterator[None]:
    """
    Make a file mutation and its git add/commit/push a single all-or-nothing
    unit. The caller mutates `paths` inside the `with` block; if anything
    after that — staging, commit, or push — fails, the working tree (and any
    commit already made) is reset to the pre-transaction HEAD, so a failed
    push can never leave an unpushed local commit and a mid-write crash can
    never leave a half-committed file.

    Assumes single-writer: the journal repo has no other committer than this
    API, so `reset --hard` cannot discard someone else's work.
    """
    with _git_lock:
        head = run_git("rev-parse", "HEAD").strip()
        try:
            yield
            run_git("add", *paths)
            run_git("commit", "-m", f"{message}\n\nSource: hledger-mobile-api")
            run_git("push")
        except Exception:
            run_git("reset", "--hard", head)
            raise
