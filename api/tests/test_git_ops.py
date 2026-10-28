import threading
import time

import pytest
from fastapi import HTTPException

from app.git_ops import API_TRAILER, git_revert_head, git_transaction


def test_happy_path_runs_add_commit_push_in_order(fake_git):
    mutated = []
    with git_transaction(["file.txt"], "test commit"):
        mutated.append("done")

    assert mutated == ["done"]
    subcommands = [c[0] for c in fake_git.calls]
    assert subcommands == ["rev-parse", "add", "commit", "push", "rev-parse"]
    assert fake_git.calls[1] == ("add", "file.txt")
    assert "test commit" in fake_git.calls[2][2]


def test_push_failure_resets_hard_and_propagates(fake_git):
    fake_git.fail_on = "push"
    with pytest.raises(HTTPException):
        with git_transaction(["file.txt"], "test commit"):
            pass

    subcommands = [c[0] for c in fake_git.calls]
    assert subcommands == ["rev-parse", "add", "commit", "push", "reset"]
    assert fake_git.calls[-1] == ("reset", "--hard", fake_git.head)


def test_caller_mutation_raises_before_commit_resets_no_commit(fake_git):
    with pytest.raises(ValueError):
        with git_transaction(["file.txt"], "test commit"):
            raise ValueError("boom")

    subcommands = [c[0] for c in fake_git.calls]
    assert subcommands == ["rev-parse", "reset"]
    assert "commit" not in subcommands


def test_lock_serializes_concurrent_callers(fake_git):
    order = []
    barrier_entered = threading.Event()

    def worker(name, delay):
        with git_transaction([f"{name}.txt"], f"commit {name}"):
            order.append(f"{name}-start")
            if name == "first":
                barrier_entered.set()
                time.sleep(delay)
            order.append(f"{name}-end")

    t1 = threading.Thread(target=worker, args=("first", 0.05))
    t1.start()
    barrier_entered.wait(timeout=1)
    t2 = threading.Thread(target=worker, args=("second", 0))
    t2.start()
    t1.join(timeout=2)
    t2.join(timeout=2)

    # first's critical section must fully complete before second's begins,
    # because git_transaction holds a process-wide lock across the whole
    # mutate-then-push sequence.
    assert order == ["first-start", "first-end", "second-start", "second-end"]


def test_transaction_yields_the_pushed_commit(fake_git):
    with git_transaction(["file.txt"], "test commit") as commit:
        assert commit.sha == ""
    assert commit.sha == fake_git.head


def _api_commit(fake_git, subject):
    fake_git.messages[fake_git.head] = f"{subject}\n\n{API_TRAILER}\n"
    return fake_git.head


def test_revert_head_reverts_commits_and_pushes(fake_git):
    sha = _api_commit(fake_git, "add: Coffee 2026-01-05")
    assert git_revert_head(sha) == "add: Coffee 2026-01-05"
    subcommands = [c[0] for c in fake_git.calls]
    assert subcommands == ["rev-parse", "log", "revert", "commit", "push"]
    assert fake_git.calls[2] == ("revert", "--no-commit", sha)
    assert fake_git.calls[3][2].startswith("undo: add: Coffee 2026-01-05\n")


def test_revert_head_refuses_when_head_moved(fake_git):
    _api_commit(fake_git, "add: Coffee 2026-01-05")
    with pytest.raises(HTTPException) as e:
        git_revert_head("0" * 40)
    assert e.value.status_code == 409
    assert "revert" not in [c[0] for c in fake_git.calls]


def test_revert_head_refuses_commit_without_api_trailer(fake_git):
    fake_git.messages[fake_git.head] = "add: Coffee 2026-01-05\n"
    with pytest.raises(HTTPException) as e:
        git_revert_head(fake_git.head)
    assert e.value.status_code == 409


def test_revert_head_refuses_non_add_commit(fake_git):
    sha = _api_commit(fake_git, "envelopes: transfer $5.00 a->b")
    with pytest.raises(HTTPException) as e:
        git_revert_head(sha)
    assert e.value.status_code == 409


def test_revert_head_push_failure_resets(fake_git):
    sha = _api_commit(fake_git, "add: Coffee 2026-01-05")
    fake_git.fail_on = "push"
    with pytest.raises(HTTPException):
        git_revert_head(sha)
    assert fake_git.calls[-1] == ("reset", "--hard", sha)
