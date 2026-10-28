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


API_TRAILER = "Source: hledger-mobile-api"

# Subjects of the commits POST /undo may revert: the journal appends.
UNDOABLE_PREFIXES = ("add:",)


class GitCommit:
    """Filled in by git_transaction once the commit is pushed."""

    sha: str = ""


@contextmanager
def git_transaction(paths: list[str], message: str) -> Iterator[GitCommit]:
    """
    Make a file mutation and its git add/commit/push a single all-or-nothing
    unit. The caller mutates `paths` inside the `with` block; if anything
    after that — staging, commit, or push — fails, the working tree (and any
    commit already made) is reset to the pre-transaction HEAD, so a failed
    push can never leave an unpushed local commit and a mid-write crash can
    never leave a half-committed file.

    Yields a GitCommit whose `sha` is set after the push, so a caller can
    hand it to POST /undo.

    Assumes single-writer: the journal repo has no other committer than this
    API, so `reset --hard` cannot discard someone else's work.
    """
    commit = GitCommit()
    with _git_lock:
        head = run_git("rev-parse", "HEAD").strip()
        try:
            yield commit
            run_git("add", *paths)
            run_git("commit", "-m", f"{message}\n\n{API_TRAILER}")
            run_git("push")
            commit.sha = run_git("rev-parse", "HEAD").strip()
        except Exception:
            run_git("reset", "--hard", head)
            raise


def git_revert_head(sha: str) -> str:
    """
    Revert `sha` and push, all-or-nothing like git_transaction. Only the
    latest commit can be reverted, and only an API commit whose subject is
    in UNDOABLE_PREFIXES: anything written since (another add, an envelope
    change, a synced desktop push) closes the undo window with a 409.
    Reverting HEAD itself can't conflict and can't orphan later work.

    Returns the subject of the reverted commit.
    """
    with _git_lock:
        head = run_git("rev-parse", "HEAD").strip()
        if head != sha:
            raise HTTPException(status_code=409, detail="The journal changed since this save")
        body = run_git("log", "-1", "--format=%B", sha)
        subject = body.strip().split("\n", 1)[0]
        if API_TRAILER not in body or not subject.startswith(UNDOABLE_PREFIXES):
            raise HTTPException(status_code=409, detail="This commit can't be undone")
        try:
            run_git("revert", "--no-commit", sha)
            run_git("commit", "-m", f"undo: {subject}\n\n{API_TRAILER}")
            run_git("push")
        except Exception:
            run_git("reset", "--hard", head)
            raise
        return subject
