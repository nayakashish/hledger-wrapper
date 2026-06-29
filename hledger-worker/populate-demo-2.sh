#!/usr/bin/env bash
# populate-demo-kv-v2.sh

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
  ["assets", null, null, [{"acommodity":"$","aquantity":{"decimalMantissa":1245630,"decimalPlaces":2}}]],
  ["assets:chequing", null, null, [{"acommodity":"$","aquantity":{"decimalMantissa":542300,"decimalPlaces":2}}]],
  ["assets:savings", null, null, [{"acommodity":"$","aquantity":{"decimalMantissa":703330,"decimalPlaces":2}}]],
  ["liabilities", null, null, [{"acommodity":"$","aquantity":{"decimalMantissa":-84200,"decimalPlaces":2}}]],
  ["liabilities:creditcard", null, null, [{"acommodity":"$","aquantity":{"decimalMantissa":-84200,"decimalPlaces":2}}]]
], []]'

# ── income statement ───────────────────────────────────────────────────────
put "is" '{
  "cbrSubreports": [
    ["Revenues", {
      "prRows": [
        {"prrName": "income:salary", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":-620000,"decimalPlaces":2}}]]},
        {"prrName": "income:interest", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":-12000,"decimalPlaces":2}}]]}
      ]
    }],
    ["Expenses", {
      "prRows": [
        {"prrName": "expenses:rent", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":180000,"decimalPlaces":2}}]]},
        {"prrName": "expenses:groceries", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":62000,"decimalPlaces":2}}]]},
        {"prrName": "expenses:dining", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":28000,"decimalPlaces":2}}]]},
        {"prrName": "expenses:transport", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":19000,"decimalPlaces":2}}]]},
        {"prrName": "expenses:subscriptions", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":9600,"decimalPlaces":2}}]]},
        {"prrName": "expenses:shopping", "prrAmounts": [[{"acommodity":"$","aquantity":{"decimalMantissa":21000,"decimalPlaces":2}}]]}
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
      [{"acommodity":"$","aquantity":{"decimalMantissa":-310000,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":-310000,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":0,"decimalPlaces":2}}]
    ]},
    {"prrName":"expenses:groceries","prrAmounts":[
      [{"acommodity":"$","aquantity":{"decimalMantissa":28000,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":34000,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":0,"decimalPlaces":2}}]
    ]},
    {"prrName":"expenses:dining","prrAmounts":[
      [{"acommodity":"$","aquantity":{"decimalMantissa":12000,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":16000,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":0,"decimalPlaces":2}}]
    ]},
    {"prrName":"expenses:rent","prrAmounts":[
      [{"acommodity":"$","aquantity":{"decimalMantissa":90000,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":90000,"decimalPlaces":2}}],
      [{"acommodity":"$","aquantity":{"decimalMantissa":0,"decimalPlaces":2}}]
    ]}
  ]
}'

# ── transactions ───────────────────────────────────────────────────────────
put "transactions" '[
  {
    "tdate": "2026-02-01",
    "tdescription": "Paycheck",
    "tpostings": [
      {"paccount": "assets:chequing", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":310000,"decimalPlaces":2}}]},
      {"paccount": "income:salary", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":-310000,"decimalPlaces":2}}]}
    ]
  },
  {
    "tdate": "2026-02-02",
    "tdescription": "Rent",
    "tpostings": [
      {"paccount": "expenses:rent", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":90000,"decimalPlaces":2}}]},
      {"paccount": "assets:chequing", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":-90000,"decimalPlaces":2}}]}
    ]
  },
  {
    "tdate": "2026-02-05",
    "tdescription": "Groceries",
    "tpostings": [
      {"paccount": "expenses:groceries", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":8200,"decimalPlaces":2}}]},
      {"paccount": "assets:chequing", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":-8200,"decimalPlaces":2}}]}
    ]
  },
  {
    "tdate": "2026-02-06",
    "tdescription": "Coffee shop",
    "tpostings": [
      {"paccount": "expenses:dining", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":950,"decimalPlaces":2}}]},
      {"paccount": "assets:chequing", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":-950,"decimalPlaces":2}}]}
    ]
  },
  {
    "tdate": "2026-02-10",
    "tdescription": "Gas",
    "tpostings": [
      {"paccount": "expenses:transport", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":5200,"decimalPlaces":2}}]},
      {"paccount": "assets:chequing", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":-5200,"decimalPlaces":2}}]}
    ]
  },
  {
    "tdate": "2026-02-12",
    "tdescription": "Streaming subscription",
    "tpostings": [
      {"paccount": "expenses:subscriptions", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":1599,"decimalPlaces":2}}]},
      {"paccount": "assets:chequing", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":-1599,"decimalPlaces":2}}]}
    ]
  },
  {
    "tdate": "2026-02-15",
    "tdescription": "Dining out",
    "tpostings": [
      {"paccount": "expenses:dining", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":4200,"decimalPlaces":2}}]},
      {"paccount": "liabilities:creditcard", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":-4200,"decimalPlaces":2}}]}
    ]
  },
  {
    "tdate": "2026-02-20",
    "tdescription": "Online shopping",
    "tpostings": [
      {"paccount": "expenses:shopping", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":12500,"decimalPlaces":2}}]},
      {"paccount": "liabilities:creditcard", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":-12500,"decimalPlaces":2}}]}
    ]
  },
  {
    "tdate": "2026-02-25",
    "tdescription": "Credit card payment",
    "tpostings": [
      {"paccount": "liabilities:creditcard", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":16600,"decimalPlaces":2}}]},
      {"paccount": "assets:chequing", "pamount": [{"acommodity":"$","aquantity":{"decimalMantissa":-16600,"decimalPlaces":2}}]}
    ]
  }
]'

echo ""
echo "✅ Done. Demo KV data (v2) written to namespace $NAMESPACE_ID."