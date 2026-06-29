#!/usr/bin/env bash
# populate-demo-kv.sh

set -euo pipefail

NAMESPACE_ID="${1:?Usage: $0 <namespace-id>}"

put() {
  local key="$1"
  local value="$2"

  tmpfile=$(mktemp)
  echo "$value" > "$tmpfile"

  echo "Writing key: $key (remote)"
  wrangler kv key put "$key" \
    --namespace-id="$NAMESPACE_ID" \
    --remote \
    --path "$tmpfile"

  rm "$tmpfile"
}

# ── balance ────────────────────────────────────────────────────────────────
put "balance" '[[
  ["assets", null, null, [{"acommodity":"$","aquantity":{"decimalMantissa":824563,"decimalPlaces":2}}]],
  ["assets:TD:chequing", null, null, [{"acommodity":"$","aquantity":{"decimalMantissa":312480,"decimalPlaces":2}}]],
  ["assets:TD:chequing:tithe", null, null, [{"acommodity":"$","aquantity":{"decimalMantissa":54000,"decimalPlaces":2}}]],
  ["assets:TD:savings", null, null, [{"acommodity":"$","aquantity":{"decimalMantissa":512083,"decimalPlaces":2}}]],
  ["assets:external:wealthsimple", null, null, [{"acommodity":"$","aquantity":{"decimalMantissa":1872400,"decimalPlaces":2}}]],
  ["liabilities", null, null, [{"acommodity":"$","aquantity":{"decimalMantissa":-24000,"decimalPlaces":2}}]],
  ["liabilities:creditcard", null, null, [{"acommodity":"$","aquantity":{"decimalMantissa":-24000,"decimalPlaces":2}}]]
], []]'

# ── is ─────────────────────────────────────────────────────────────────────
put "is" '{
  "cbrSubreports": [
    ["Revenues", {
      "prRows": [
        {"prrName": "income:salary", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":-540000,"decimalPlaces":2}}]]},
        {"prrName": "income:government", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":-82000,"decimalPlaces":2}}]]}
      ]
    }],
    ["Expenses", {
      "prRows": [
        {"prrName": "expenses:food:groceries", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":38420,"decimalPlaces":2}}]]},
        {"prrName": "expenses:food:dining", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":9600,"decimalPlaces":2}}]]},
        {"prrName": "expenses:housing:rent", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":135000,"decimalPlaces":2}}]]},
        {"prrName": "expenses:transport:fuel", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":8750,"decimalPlaces":2}}]]},
        {"prrName": "expenses:subscriptions", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":4320,"decimalPlaces":2}}]]},
        {"prrName": "expenses:savings:external", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":108000,"decimalPlaces":2}}]]},
        {"prrName": "expenses:tithe", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":0,"decimalPlaces":2}}]]}
      ]
    }]
  ]
}'

# ── monthly ────────────────────────────────────────────────────────────────
put "monthly" '{
  "prDates": [
    [{"contents":"2026-01-01"},{"contents":"2026-02-01"}],
    [{"contents":"2026-02-01"},{"contents":"2026-03-01"}],
    [{"contents":"2026-03-01"},{"contents":"2026-04-01"}]
  ],
  "prRows": [
    {"prrName":"income:salary","prrAmounts":[
      [{"acommodity":"$","aquantity":{"decimalMantissa":-270000,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":-270000,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":0,"decimalPlaces":2}}]
    ]},
    {"prrName":"expenses:food:groceries","prrAmounts":[
      [{"acommodity":"$","aquantity":{"decimalMantissa":18200,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":20220,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":0,"decimalPlaces":2}}]
    ]},
    {"prrName":"expenses:food:dining","prrAmounts":[
      [{"acommodity":"$","aquantity":{"decimalMantissa":4800,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":4800,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":0,"decimalPlaces":2}}]
    ]},
    {"prrName":"expenses:housing:rent","prrAmounts":[
      [{"acommodity":"$","aquantity":{"decimalMantissa":67500,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":67500,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":0,"decimalPlaces":2}}]
    ]},
    {"prrName":"expenses:transport:fuel","prrAmounts":[
      [{"acommodity":"$","aquantity":{"decimalMantissa":4200,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":4550,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":0,"decimalPlaces":2}}]
    ]},
    {"prrName":"expenses:subscriptions","prrAmounts":[
      [{"acommodity":"$","aquantity":{"decimalMantissa":2160,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":2160,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":0,"decimalPlaces":2}}]
    ]},
    {"prrName":"expenses:savings:external","prrAmounts":[
      [{"acommodity":"$","aquantity":{"decimalMantissa":54000,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":54000,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":0,"decimalPlaces":2}}]
    ]}
  ]
}'

# ── transactions ────────────────────────────────────────────────────────────
put "transactions" '[
  {
    "tdate": "2026-02-28",
    "tdescription": "Paycheck",
    "tpostings": [
      {"paccount": "assets:TD:chequing", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":243000,"decimalPlaces":2}}]},
      {"paccount": "assets:TD:chequing:tithe", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":27000,"decimalPlaces":2}}]},
      {"paccount": "income:salary", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":-270000,"decimalPlaces":2}}]}
    ]
  }
]'

# ── accounts ────────────────────────────────────────────────────────────────
put "accounts" '{"accounts":["assets:TD:chequing","assets:TD:chequing:tithe","assets:TD:savings","assets:external:wealthsimple","expenses:food:groceries","expenses:food:dining","expenses:housing:rent","expenses:transport:fuel","expenses:subscriptions","expenses:savings:external","expenses:tithe","income:salary","income:government","liabilities:creditcard"]}'

# ── descriptions ────────────────────────────────────────────────────────────
put "descriptions" '{"descriptions":["Paycheck","Rent","Wealthsimple transfer","Superstore","Dinner out","Shell","Subscriptions"]}'

echo ""
echo "✅ Done. All demo keys written to KV namespace $NAMESPACE_ID."