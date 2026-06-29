# Envelope System - Integration Guide

## Files produced

| File                        | Where it goes                                                        |
|-----------------------------|----------------------------------------------------------------------|
| envelope_config.json        | /home/server/repos/2026.ledger/envelope_config.json                  |
| envelopes.json              | /home/server/repos/2026.ledger/envelopes.json                        |
| envelope_api_additions.py   | Append contents to api/main.py                                       |
| accrue.py                   | api/accrue.py                                                        |
| envelopes_ui_snippets.html  | Integrate into worker/public/index.html (see steps below)            |


## Step 1 — Copy data files to journal repo

  cp envelope_config.json /home/server/repos/2026.ledger/
  cp envelopes.json       /home/server/repos/2026.ledger/
  cd /home/server/repos/2026.ledger/
  git add envelope_config.json envelopes.json
  git commit -m "add: envelope system files"
  git push


## Step 2 — Copy accrue.py

  cp accrue.py /home/server/git_projects/hledger-wrapper/api/accrue.py


## Step 3 — Add env vars to api/.env

  ENVELOPE_CONFIG_FILE=/home/server/repos/2026.ledger/envelope_config.json
  ENVELOPE_DATA_FILE=/home/server/repos/2026.ledger/envelopes.json


## Step 4 — Append envelope endpoints to main.py

  Open envelope_api_additions.py and append everything AFTER the comment block
  at the top (the imports note) into api/main.py.

  Also add this import near the top of main.py if not already present:
    import json

  Then add these two env var reads near the other os.getenv() lines:
    ENVELOPE_CONFIG_FILE = os.getenv("ENVELOPE_CONFIG_FILE", "")
    ENVELOPE_DATA_FILE   = os.getenv("ENVELOPE_DATA_FILE", "")

  Restart the service:
    sudo systemctl restart hledger-api


## Step 5 — Update index.html

  A) In <nav>, replace the Income button:
     OLD: <button onclick="showView('is', this)">Income</button>
     NEW: <button onclick="showView('is', this)">Income</button>
          <button onclick="showView('envelopes', this)">Envelopes</button>

     (or replace Income entirely if you prefer)

  B) After the view-is div, add:
     <div id="view-envelopes" class="view">
       <div class="state-msg">Tap sync to load data.</div>
     </div>

  C) Add the Allocate Income sheet div (from envelopes_ui_snippets.html,
     the bottom HTML SNIPPETS section) alongside the existing add-sheet div.

  D) Copy the full <style id="envelope-styles"> block into the existing <style> tag.

  E) Copy the full <script id="envelope-js"> block into the existing <script> tag.

  F) In loadAll(), add loadEnvelopes() to the Promise.all array:
     await Promise.all([
       loadEndpoint('balance'), loadEndpoint('is'), loadEndpoint('monthly'),
       loadEndpoint('transactions', { month: currentMonth() }),
       loadEnvelopes(),   // <-- add this
     ]);

  G) In renderView(), add:
     if (name === 'envelopes') renderEnvelopes(el, data);

  H) In showView(), cache lookup already works via cache['envelopes'].
     No changes needed there.


## Step 6 — Worker: proxy new endpoints

  In worker/src/index.ts, the /api/* proxy rule already forwards everything.
  No changes needed unless you have explicit allowlists.


## Step 7 — Set up monthly accrual timer

  See envelope-timer-instructions.txt for the systemd timer setup.
  Quick version:
    sudo nano /etc/systemd/system/envelope-accrue.service   # paste service unit
    sudo nano /etc/systemd/system/envelope-accrue.timer     # paste timer unit
    sudo systemctl daemon-reload
    sudo systemctl enable --now envelope-accrue.timer


## Step 8 — Configure your envelopes

  Edit /home/server/repos/2026.ledger/envelope_config.json:
  - Set monthly_amount on car_insurance, phone_plan, etc.
  - Adjust income_split_default percentages
  - Add/remove envelopes as needed
  - Commit and push after changes

  The app reads this config live so changes take effect on next sync.


## How it works day to day

  Paycheque lands:
    1. Open app -> Envelopes tab
    2. Tap "+ Allocate Income"
    3. Enter gross amount (e.g. 2400.00)
    4. Splits pre-fill: savings $960, chequing $960, tithe $240
    5. Adjust if needed, confirm -> done

  Monthly auto-accrual:
    Runs on the 1st via systemd timer. Car insurance, phone plan, etc.
    get their monthly_amount added automatically. No action needed.

  After making a real transfer (tithe, car insurance, etc.):
    Option A (auto): Tap "Match Txns" -- app scans hledger for new
    transactions matching configured account prefixes and drains envelopes.

    Option B (manual): Tap the envelope -> "Mark Paid" -> enter amount.

  Moving money between envelopes:
    Tap envelope -> "Transfer" -> pick destination -> enter amount.
