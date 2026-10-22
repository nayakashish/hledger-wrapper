#!/usr/bin/env bash
# Pull the latest main and restart the API. Run on the server, from anywhere:
#
#   ./api/update-server.sh
#
# Stops before changing anything if the checkout isn't a clean `main`, or if
# main can't fast-forward. Reinstalls requirements only when they changed, and
# restarts only when something under api/ changed. Ends with a health check.
# Touches only this code checkout, never the journal repo.

set -euo pipefail

SERVICE="${SERVICE:-hledger-api}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/api"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

cd "$REPO"

# ── Guard ────────────────────────────────────────────────────────────────────
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || fail "On branch '$branch', not main. Check out main first."
[ -z "$(git status --porcelain --untracked-files=no)" ] \
	|| fail "Local changes in the checkout. Commit, stash or discard them first."

# ── Pull ─────────────────────────────────────────────────────────────────────
prev="$(git rev-parse HEAD)"
say "Fetching..."
git fetch --quiet origin main
if [ "$(git rev-parse origin/main)" = "$prev" ]; then
	say "Already up to date at $(git rev-parse --short HEAD). Nothing to do."
	[ "${1:-}" = "--force-restart" ] || exit 0
else
	git merge --ff-only --quiet origin/main \
		|| fail "main can't fast-forward (history diverged). Sort it out by hand."
	say "Updated $(git rev-parse --short "$prev") → $(git rev-parse --short HEAD):"
	git --no-pager log --oneline "$prev..HEAD" | sed 's/^/  /'
fi

changed() { ! git diff --quiet "$prev" HEAD -- "$@"; }

# ── Dependencies ─────────────────────────────────────────────────────────────
if changed api/requirements.txt; then
	say "requirements.txt changed, installing..."
	"$API/venv/bin/pip" install --quiet -r "$API/requirements.txt"
fi

# ── Restart ──────────────────────────────────────────────────────────────────
if changed api/ || [ "${1:-}" = "--force-restart" ]; then
	say "Restarting ${SERVICE}..."
	sudo systemctl restart "${SERVICE}"
else
	say "No API changes, so no restart needed."
	exit 0
fi

# ── Health check ─────────────────────────────────────────────────────────────
# Port comes from the unit's ExecStart (--port N), falling back to 8000.
port="$(systemctl cat "${SERVICE}" 2>/dev/null | grep -o -- '--port[= ][0-9]*' | grep -o '[0-9]*$' | head -1)"
port="${port:-8000}"

for _ in $(seq 1 30); do
	if curl -fsS -o /dev/null "http://127.0.0.1:$port/health"; then
		say "Healthy on :$port, running $(git rev-parse --short HEAD)."
		exit 0
	fi
	sleep 1
done

printf '\033[31m%s\033[0m\n' "${SERVICE} didn't answer /health on :$port within 30s. Last log lines:" >&2
journalctl -u "${SERVICE}" -n 20 --no-pager >&2 || true
cat >&2 <<MSG

To go back to the previous version:
  git -C "$REPO" checkout $prev && sudo systemctl restart ${SERVICE}
(then 'git -C "$REPO" checkout main' once the fix is merged)
MSG
exit 1
