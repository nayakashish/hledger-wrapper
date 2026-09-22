"""What code this server is actually running.

Settings shows this so a deploy can be confirmed from the phone: the project
version, the commit behind it, and whether the checkout has local changes.
Nothing is cached — a stale answer would hide exactly the case worth catching,
a `git pull` without a service restart.

The git calls here deliberately do not go through `git_ops.run_git`, which
operates on the journal repo. This is the code repo, which is a different
checkout entirely.
"""

import json
import os
import subprocess

# app/version.py -> app/ -> api/ -> the repo root
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# The project version lives in one place and is bumped there; reading it keeps
# the API from carrying a second copy that drifts.
PACKAGE_JSON = os.path.join(REPO_ROOT, "hledger-worker", "package.json")


def _git(*args: str) -> str:
    """A read-only git call against the code repo. Returns "" for every
    failure — no git, no checkout, a timeout — because a missing answer is
    reported as unknown rather than failing the request."""
    try:
        result = subprocess.run(
            ["git", "-C", REPO_ROOT, *args],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def project_version() -> str:
    try:
        with open(PACKAGE_JSON) as f:
            return str(json.load(f).get("version", "") or "")
    except (OSError, ValueError):
        return ""


def version_info() -> dict:
    """Version, commit, branch, commit date, and whether the working tree is
    clean. Any field the server cannot determine comes back empty."""
    log = _git("log", "-1", "--format=%h%n%H%n%cI")
    short, full, committed_at = (log.split("\n") + ["", "", ""])[:3]
    branch = _git("rev-parse", "--abbrev-ref", "HEAD")
    return {
        "version": project_version(),
        "commit": short,
        "commit_full": full,
        "branch": branch if branch != "HEAD" else "",
        "committed_at": committed_at,
        "dirty": bool(_git("status", "--porcelain")),
    }
