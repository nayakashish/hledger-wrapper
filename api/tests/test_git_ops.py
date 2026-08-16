import threading
import time

import pytest
from fastapi import HTTPException

from app.git_ops import git_transaction


def test_happy_path_runs_add_commit_push_in_order(fake_git):
    mutated = []
    with git_transaction(["file.txt"], "test commit"):
        mutated.append("done")

    assert mutated == ["done"]
    subcommands = [c[0] for c in fake_git.calls]
    assert subcommands == ["rev-parse", "add", "commit", "push"]
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
