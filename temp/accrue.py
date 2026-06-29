#!/usr/bin/env python3
"""
Monthly envelope accrual script.
Run by systemd timer on the 1st of each month.
Adds monthly_amount to each sinking_fund and budget envelope.
Commits result to git.
"""

import json
import os
import subprocess
from datetime import date

JOURNAL_DIR = os.getenv("JOURNAL_DIR", "/home/server/git_projects/2026.ledger")
CONFIG_FILE = os.path.join(JOURNAL_DIR, "envelope_config.json")
DATA_FILE   = os.path.join(JOURNAL_DIR, "envelopes.json")


def run_git(*args):
    subprocess.run(["git", *args], cwd=JOURNAL_DIR, check=True)


def main():
    with open(CONFIG_FILE) as f:
        config = json.load(f)
    with open(DATA_FILE) as f:
        data = json.load(f)

    today = date.today().isoformat()
    accrued = []

    for env in config["envelopes"]:
        eid = env["id"]
        etype = env.get("type")
        monthly = env.get("monthly_amount", 0.0)

        if etype in ("sinking_fund", "budget") and monthly > 0:
            before = data["balances"].get(eid, 0.0)
            data["balances"][eid] = round(before + monthly, 2)
            entry = {
                "date": today,
                "type": "accrue",
                "envelope": eid,
                "amount": monthly,
                "note": f"Monthly accrual"
            }
            data["history"].append(entry)
            accrued.append(f"  {eid}: +${monthly:.2f} (now ${data['balances'][eid]:.2f})")

    if not accrued:
        print("No envelopes with monthly_amount > 0. Nothing to accrue.")
        return

    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=2)

    run_git("add", DATA_FILE)
    run_git("commit", "-m", f"envelopes: monthly accrual {today}\n\nSource: hledger-mobile-api\n\n" + "\n".join(accrued))
    run_git("push")

    print(f"Accrued on {today}:")
    for line in accrued:
        print(line)


if __name__ == "__main__":
    main()
