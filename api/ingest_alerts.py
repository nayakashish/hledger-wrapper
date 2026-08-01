#!/usr/bin/env python3
"""
ingest_alerts.py — paste bank alert emails straight into the transaction inbox.

Runs on the home server, next to the FastAPI app. It talks to the LOCAL API
(http://127.0.0.1:8000 by default), so it bypasses Gmail + Cloudflare entirely
and reuses every bit of server-side logic in POST /inbox/ingest: message-id /
pending / journal dedup, the suggestion engine, and the git commit. Nothing
here reimplements inbox.json — the API owns that.

Use it instead of re-forwarding alerts when the email pipeline was down, or to
backfill old alerts in bulk.

Quick start (on the server):

    python3 ingest_alerts.py

Paste one or many alerts, separate multiple with a line that is just `---`,
then press Ctrl-D to finish. You get a preview table and a confirm prompt
before anything is sent.

Dates:
    Bank purchase alerts don't put the date in the body text (it lived in the
    email's Date: header, which a copy/paste loses), so supply it one of three
    ways, highest precedence first:
      1. --date 2026-07-15         one date for the whole batch
      2. a leading date line       tag each alert with its own date, e.g.
                                       2026-07-15
                                       CIBC ... for $22.94 at Cafe.
      3. a per-alert prompt        anything still undated is asked for
                                   interactively (blank = today; --today skips)
    A date found anywhere in the body (e.g. a forwarded "Date:" line) is also
    picked up automatically.

Common flags:

    --file alerts.txt   read alerts from a file instead of pasting
    --dry-run           parse + preview only, send nothing
    --yes               skip the confirm prompt (for scripting)
    --date 2026-07-15   force the transaction date for every alert
    --today             use today for any undated alert (don't prompt)
    --unparsed          for chunks that don't auto-parse, stage them as
                        low-confidence unparsed items instead of prompting
    --sep '==='         use a different separator between alerts
    --url http://...    point at a different API base (default 127.0.0.1:8000)
    --token XXXX        bearer token (default: read BEARER_TOKEN from .env)

The token is read from api/.env automatically; you normally never pass --token.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import date as _date, datetime

DEFAULT_URL = "http://127.0.0.1:8000"
DEFAULT_SEP = "---"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------
# Interactive input — prompts are read from the controlling terminal
# (/dev/tty), not stdin, so they still work after a paste has consumed all of
# stdin via Ctrl-D. Falls back to input() when there is no tty (piped input).
# ---------------------------------------------------------------------------

_tty = None  # None = unopened, False = unavailable, else an open file object


def _get_tty():
    global _tty
    if _tty is None:
        try:
            _tty = open("/dev/tty")
        except OSError:
            _tty = False
    return _tty


def interactive() -> bool:
    """True when we can prompt the user (a controlling terminal exists)."""
    return _get_tty() is not False or sys.stdin.isatty()


def ask(prompt: str) -> str:
    """Prompt and read one line from the tty, falling back to stdin."""
    tty = _get_tty()
    if tty:
        sys.stdout.write(prompt)
        sys.stdout.flush()
        line = tty.readline()
        if not line:
            raise EOFError
        return line.rstrip("\n")
    return input(prompt)


# ---------------------------------------------------------------------------
# Parsed alert model
# ---------------------------------------------------------------------------

@dataclass
class Alert:
    amount: float = 0.0
    merchant: str = ""
    card_last4: str = ""
    bank: str = ""
    txn_date: str = ""          # "" => let the server default to today
    raw_subject: str = ""
    parsed: bool = True
    warnings: list[str] = field(default_factory=list)

    def payload(self) -> dict:
        """Shape expected by InboxIngest on the server."""
        return {
            "amount": round(self.amount, 2),
            "merchant": self.merchant.strip()[:200],
            "card_last4": self.card_last4.strip()[:4],
            "bank": self.bank.strip()[:40],
            "txn_date": self.txn_date,
            "raw_subject": self.raw_subject.strip()[:300],
            # A stable id makes re-running the script idempotent: the second run
            # of the same alert comes back {"status":"duplicate","reason":
            # "message_id"} instead of creating a twin pending item.
            "email_message_id": self._stable_id(),
            "parsed": self.parsed,
        }

    def _stable_id(self) -> str:
        if not self.parsed:
            return ""  # unparsed items have no reliable identity; skip dedup id
        key = f"{self.txn_date}|{round(self.amount, 2)}|{self.card_last4}|{self.merchant.strip().lower()}"
        return "manual-" + hashlib.sha1(key.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Bank parsers — mirror BANK_PARSERS in the Worker (src/index.ts). Add a new
# entry here and in the Worker together when a new bank/template shows up.
# ---------------------------------------------------------------------------

# "...your CIBC Costco Mastercard ending in 1234 for $22.94 at TST-The Samosa
#  Factory." — non-greedy merchant stops at the first period, same as the Worker.
CIBC_RE = re.compile(r"ending in (\d{4}) for \$([\d,]+\.\d{2}) at (.+?)\.", re.IGNORECASE)


def parse_cibc(text: str) -> Alert | None:
    flat = re.sub(r"\s+", " ", text)
    m = CIBC_RE.search(flat)
    if not m:
        return None
    return Alert(
        amount=float(m.group(2).replace(",", "")),
        merchant=m.group(3).strip(),
        card_last4=m.group(1),
        bank="cibc",
    )


BANK_PARSERS = [
    ("cibc", parse_cibc),
]


# ---------------------------------------------------------------------------
# Date extraction — best effort, so backfilled alerts keep their real date.
# A blank date makes the server default to today.
# ---------------------------------------------------------------------------

_ISO_RE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
_SLASH_RE = re.compile(r"\b(\d{1,2}/\d{1,2}/\d{4})\b")
_WORDY_RE = re.compile(r"\b([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\b")


def normalize_date(token: str) -> str:
    """Parse one date string into ISO YYYY-MM-DD, or '' if unrecognized."""
    tok = token.strip().replace(".", "").replace(",", "")
    try:
        return _date.fromisoformat(tok).isoformat()
    except ValueError:
        pass
    for fmt in ("%m/%d/%Y", "%b %d %Y", "%B %d %Y"):
        try:
            return datetime.strptime(tok, fmt).date().isoformat()
        except ValueError:
            continue
    return ""


def extract_date(text: str) -> str:
    """Find a date anywhere in the alert body (e.g. a forwarded Date: line)."""
    for rx in (_ISO_RE, _SLASH_RE, _WORDY_RE):
        m = rx.search(text)
        if m:
            iso = normalize_date(m.group(1))
            if iso:
                return iso
    return ""


def pop_leading_date(text: str) -> tuple[str, str]:
    """If the first non-blank line is just a date, consume it as the date.

    Lets you tag each pasted alert with its own date::

        2026-07-15
        CIBC ... ending in 1234 for $22.94 at Cafe.

    Returns (iso_date_or_empty, text_without_that_line).
    """
    lines = text.splitlines()
    for idx, line in enumerate(lines):
        if not line.strip():
            continue
        iso = normalize_date(line.strip())
        if iso:
            del lines[idx]
            return iso, "\n".join(lines)
        return "", text  # first real line isn't a date; leave text untouched
    return "", text


# ---------------------------------------------------------------------------
# Chunk -> Alert
# ---------------------------------------------------------------------------

def first_nonblank_line(text: str) -> str:
    for line in text.splitlines():
        s = line.strip()
        if s:
            return s
    return ""


def parse_chunk(text: str, force_date: str, unparsed_ok: bool) -> Alert | None:
    """Turn one pasted alert into an Alert, or None to skip it.

    Date precedence: --date override > leading date line > date found in the
    body. If none hit, txn_date is left empty and filled later (prompt/today).
    """
    leading, body = pop_leading_date(text)
    chosen_date = force_date or leading or extract_date(body)

    for bank, fn in BANK_PARSERS:
        alert = fn(body)
        if alert:
            alert.txn_date = chosen_date
            alert.raw_subject = first_nonblank_line(body)[:300]
            return alert

    # No parser matched.
    if unparsed_ok:
        subject = first_nonblank_line(body) or "Unparsed alert"
        bank = "cibc" if re.search(r"\bcibc\b", body, re.IGNORECASE) else ""
        return Alert(
            amount=0.0,
            merchant=subject,
            bank=bank,
            txn_date=chosen_date,
            raw_subject=subject[:300],
            parsed=False,
            warnings=["auto-parse failed — staged as unparsed, edit it in the app"],
        )

    return prompt_manual(body, chosen_date)


def prompt_manual(text: str, default_date: str) -> Alert | None:
    """Interactive fallback for a chunk no parser understood."""
    preview = first_nonblank_line(text)
    date_hint = default_date or "today"
    print(f"\n  Could not auto-parse this alert:\n    {preview[:80]}")
    print("  Enter details manually (blank amount = skip this one).")
    try:
        raw_amount = ask("    Amount $: ").strip().replace(",", "").lstrip("$")
        if not raw_amount:
            print("    -> skipped")
            return None
        amount = float(raw_amount)
        merchant = ask("    Merchant: ").strip()
        while not merchant:
            merchant = ask("    Merchant (required): ").strip()
        last4 = ask("    Card last4 [optional]: ").strip()
        d = ask(f"    Date YYYY-MM-DD [blank = {date_hint}]: ").strip()
    except (EOFError, KeyboardInterrupt):
        print("\n    -> skipped")
        return None
    except ValueError:
        print("    -> invalid amount, skipped")
        return None

    txn_date = normalize_date(d) if d else default_date
    if d and not txn_date:
        print(f"    warning: '{d}' is not a date, using {date_hint}")
        txn_date = default_date
    bank = "cibc" if re.search(r"\bcibc\b", text, re.IGNORECASE) else ""
    return Alert(
        amount=amount, merchant=merchant, card_last4=last4,
        bank=bank, txn_date=txn_date, raw_subject=preview[:300], parsed=True,
    )


def prompt_date(alert: Alert) -> str:
    """Ask for a missing date; blank keeps the server default (today)."""
    label = f"{alert.merchant[:28]} (${alert.amount:,.2f})"
    while True:
        try:
            d = ask(f"    Date for {label} [YYYY-MM-DD, blank = today]: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return ""
        if not d:
            return ""
        iso = normalize_date(d)
        if iso:
            return iso
        print("    not a valid date, try again")


# ---------------------------------------------------------------------------
# Config: token + URL
# ---------------------------------------------------------------------------

def read_env_token(env_file: str) -> str:
    """Pull BEARER_TOKEN out of a .env file (simple KEY=VALUE parser)."""
    if not os.path.exists(env_file):
        return ""
    try:
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                if key.strip() == "BEARER_TOKEN":
                    return val.strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def resolve_token(args) -> str:
    if args.token:
        return args.token
    if os.environ.get("BEARER_TOKEN"):
        return os.environ["BEARER_TOKEN"]
    return read_env_token(args.env_file)


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------

def post_ingest(base_url: str, token: str, payload: dict) -> dict:
    req = urllib.request.Request(
        base_url.rstrip("/") + "/inbox/ingest",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            detail = json.loads(body).get("detail", body)
        except (ValueError, AttributeError):
            detail = body
        return {"status": "error", "reason": f"HTTP {e.code}: {detail}"}
    except urllib.error.URLError as e:
        return {"status": "error", "reason": f"cannot reach {base_url}: {e.reason}"}


# ---------------------------------------------------------------------------
# Presentation
# ---------------------------------------------------------------------------

def read_input(args) -> str:
    if args.file:
        with open(args.file) as f:
            return f.read()
    if sys.stdin.isatty():
        print("Paste alert(s). Separate multiple with a line that is just "
              f"'{args.sep}'.")
        print("Press Ctrl-D when done (Ctrl-Z then Enter on Windows).\n")
    return sys.stdin.read()


def split_chunks(text: str, sep: str) -> list[str]:
    pattern = re.compile(r"^\s*" + re.escape(sep) + r"\s*$", re.MULTILINE)
    return [c.strip() for c in pattern.split(text) if c.strip()]


def print_preview(alerts: list[Alert]) -> None:
    print(f"\nParsed {len(alerts)} alert(s):\n")
    print(f"  {'#':>2}  {'Date':<12} {'Amount':>10}  {'Card':<5} {'Bank':<6} Merchant")
    print(f"  {'-'*2}  {'-'*12} {'-'*10}  {'-'*5} {'-'*6} {'-'*30}")
    for i, a in enumerate(alerts, 1):
        date_str = a.txn_date or "(today)"
        amt = f"${a.amount:,.2f}"
        card = a.card_last4 or "----"
        tag = "" if a.parsed else "[unparsed] "
        print(f"  {i:>2}  {date_str:<12} {amt:>10}  {card:<5} {a.bank or '?':<6} {tag}{a.merchant[:40]}")
        for w in a.warnings:
            print(f"       ! {w}")
    print()


def confirm(prompt: str) -> bool:
    try:
        return ask(prompt).strip().lower() in ("y", "yes")
    except (EOFError, KeyboardInterrupt):
        print()
        return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser(
        description="Paste bank alerts straight into the transaction inbox.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--file", help="read alerts from this file instead of stdin")
    p.add_argument("--sep", default=DEFAULT_SEP, help=f"separator line between alerts (default: {DEFAULT_SEP})")
    p.add_argument("--url", default=DEFAULT_URL, help=f"API base URL (default: {DEFAULT_URL})")
    p.add_argument("--token", help="bearer token (default: BEARER_TOKEN env, then .env)")
    p.add_argument("--env-file", default=os.path.join(SCRIPT_DIR, ".env"),
                   help="path to .env for BEARER_TOKEN (default: alongside this script)")
    p.add_argument("--date", help="force this txn date (YYYY-MM-DD) for every alert")
    p.add_argument("--today", action="store_true",
                   help="use today for any undated alert (don't prompt)")
    p.add_argument("--unparsed", action="store_true",
                   help="stage un-parseable chunks as low-confidence items instead of prompting")
    p.add_argument("--dry-run", action="store_true", help="parse + preview only; send nothing")
    p.add_argument("--yes", "-y", action="store_true", help="skip the confirm prompt")
    args = p.parse_args()

    if args.date:
        try:
            _date.fromisoformat(args.date)
        except ValueError:
            print(f"error: --date '{args.date}' is not YYYY-MM-DD", file=sys.stderr)
            return 2

    raw = read_input(args)
    chunks = split_chunks(raw, args.sep)
    if not chunks:
        print("No alerts found in input.", file=sys.stderr)
        return 1

    alerts: list[Alert] = []
    for chunk in chunks:
        alert = parse_chunk(chunk, args.date or "", args.unparsed)
        if alert:
            alerts.append(alert)

    if not alerts:
        print("Nothing to send.")
        return 0

    # Fill in any missing dates before previewing.
    missing = [a for a in alerts if not a.txn_date]
    if missing and not args.today and interactive():
        print(f"\n{len(missing)} alert(s) have no date. Enter one for each "
              f"(blank = today):")
        for a in missing:
            a.txn_date = prompt_date(a)

    print_preview(alerts)

    if args.dry_run:
        print("Dry run — nothing sent.")
        return 0

    token = resolve_token(args)
    if not token:
        print(f"error: no bearer token. Set BEARER_TOKEN in {args.env_file}, "
              f"export it, or pass --token.", file=sys.stderr)
        return 2

    if not args.yes and not confirm(f"Send {len(alerts)} item(s) to {args.url}? [y/N] "):
        print("Aborted.")
        return 0

    staged = duplicate = errors = 0
    print()
    for i, alert in enumerate(alerts, 1):
        result = post_ingest(args.url, token, alert.payload())
        status = result.get("status")
        if status == "ok":
            staged += 1
            print(f"  {i:>2}  ok         {result.get('id', '')}")
        elif status == "duplicate":
            duplicate += 1
            print(f"  {i:>2}  duplicate  ({result.get('reason', '')})")
        else:
            errors += 1
            print(f"  {i:>2}  ERROR      {result.get('reason', result)}")

    print(f"\nDone: {staged} staged, {duplicate} duplicate, {errors} error(s).")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
