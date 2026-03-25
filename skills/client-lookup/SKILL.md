---
name: client-lookup
description: >
  Look up a QuickBooks client by name and generate a CSV report with their account balance and full
  transaction history. ALWAYS use this skill when the user types "Client-look-up" followed by any name,
  uses the Slack slash command "/client-lookup [name]", or asks to look up a client/customer in
  QuickBooks, retrieve customer transactions, export client data to CSV, check QuickBooks auth status,
  revoke QuickBooks access, or refresh tokens. Also trigger for phrases like "pull up [name]",
  "get transactions for [name]", "show me [name]'s account", "check QuickBooks connection",
  "disconnect QuickBooks", or "revoke QuickBooks token".
---

# Client Lookup Skill

## Overview
This skill connects to a local QuickBooks Express server (`http://localhost:3000`) to look up customers,
generate CSV reports, and manage the OAuth 2.0 connection lifecycle — including initial auth, auto token
rotation, status checks, and revocation.

---

## Server Info
| Item | Value |
|---|---|
| Local server | `http://localhost:3000` |
| Reports folder | `~/Quickbooks/Reports/` |
| Token file | `~/Quickbooks/.tokens.json` |
| Action log file (JSONL) | `~/Quickbooks/Reports/client-lookup.log` |
| Action log file (readable) | `~/Quickbooks/Reports/client-lookup-readable.log` |
| Start server | `cd ~/Quickbooks && node index.js` |

---

## 1. Initial OAuth (First-Time Setup)

Only needs to be done **once**. Tokens are persisted to disk and survive server restarts.

**Step 1 — Ensure the server is running:**
```bash
cd ~/Quickbooks && node index.js &
```

**Step 2 — Start OAuth in browser:**
```
http://localhost:3000/auth/intuit
```
Or via Cloudflare tunnel (required for Production credentials):
```
https://your-tunnel-url/auth/intuit
```

**Step 3 — Sign in to QuickBooks** in the browser and authorize the app.

**Step 4 — Confirm success.** The callback page will return:
```json
{
  "message": "OAuth success",
  "realmId": "...",
  "expires_in": 3600,
  "x_refresh_token_expires_in": 8726400,
  "auto_refresh": "every 55 minutes"
}
```

Tokens are immediately saved to `.tokens.json`. The server loads them automatically on every restart —
**no re-authentication needed** until the refresh token expires (~5 years).

---

## 2. Token Rotation Cycle

QuickBooks tokens follow a strict lifecycle — understand this to avoid service interruptions:

| Token | Lifetime | Rotation |
|---|---|---|
| Access token | 1 hour (fixed) | Auto-refreshed every 55 min |
| Refresh token | ~5 years (hard cap) | Rotates on every refresh call |

**How auto-refresh works:**
- Every 55 minutes the server silently calls QuickBooks' token endpoint
- A new access token AND a new refresh token are returned
- Both are immediately saved to `.tokens.json`
- The old refresh token is instantly invalidated — if `.tokens.json` is not saved, the next refresh will fail

**⚠️ Important:** Never delete `.tokens.json` while the service is running unless you intend to fully revoke access.

**After ~5 years:** QuickBooks will permanently expire the refresh token. The user must complete the
Initial OAuth flow (Section 1) again once.

---

## 3. Check Auth Status

At any time, check whether the server is authenticated and how long the current token has left:

```
GET http://localhost:3000/auth/status
```

**Example response:**
```json
{
  "authenticated": true,
  "realmId": "<your-realm-id>",
  "token_expires_in_seconds": 3245,
  "token_expiry": "2026-03-22T21:08:51.476Z",
  "auto_refresh_interval": "every 55 minutes"
}
```

**When the user asks about connection status**, fetch this endpoint and report:
- Whether the service is connected
- The realmId (QuickBooks company ID)
- How many minutes until the next auto-refresh
- Whether `.tokens.json` exists on disk

---

## 4. Manual Token Refresh

Trigger a manual refresh outside the 55-minute cycle (e.g. after a server restart with stale tokens):

```
GET http://localhost:3000/auth/intuit/refresh
```

**Example response:**
```json
{
  "message": "Token refreshed",
  "expires_in": 3600,
  "next_expiry": "2026-03-22T22:10:00.000Z"
}
```

---

## 5. Revoke Access

When the user wants to disconnect the service from QuickBooks (e.g. when done using it, switching
accounts, or for security):

### Option A — Browser confirmation page (recommended for users):
```
GET http://localhost:3000/auth/intuit/revoke
```
Opens a page with a **"Yes, Revoke Access"** button and a Cancel option. Safe — requires explicit confirmation.

### Option B — Direct API call (for automation):
```
POST http://localhost:3000/auth/intuit/revoke
```

**What revocation does:**
1. Calls Intuit's revocation API to invalidate tokens server-side
2. Deletes `.tokens.json` from disk
3. Clears all in-memory tokens
4. Returns reconnect instructions

**After revoking**, to reconnect:
```
http://localhost:3000/auth/intuit
```

---

## 6. Client Lookup — CSV Report

### Trigger
User types `Client-look-up <Customer Name>` **or** uses the Slack slash command `/client-lookup <Customer Name>`.

When a slash command arrives, the message will look like:
`/client-lookup Wang, Xi` — treat the text after `/client-lookup` as the customer name and proceed with the lookup steps below.

**Examples:**
- `Client-look-up Smith, Jane`
- `Client-look-up JONES, Robert`
- `Client-look-up Acme Services`
- `/client-look-up Smith, Jane`
- `/client-look-up JONES, Robert`

### Steps

**Step 0 — Check server status and ensure it is running:**
```bash
curl -s --max-time 3 http://localhost:3000/auth/status
```

- If the curl **succeeds** and returns `"authenticated": true` → proceed to Step 1.
- If the curl **succeeds** but `"authenticated": false` → token may be expired; run a manual refresh:
  ```bash
  curl -s http://localhost:3000/auth/intuit/refresh
  ```
  If refresh fails, tell user: `⚠️ QuickBooks token expired. Please re-authenticate at http://localhost:3000/auth/intuit` and stop.
- If the curl **fails** (exit code 7, timeout, or connection refused) → server is not running. Start it:
  ```bash
  cd ~/Quickbooks && node index.js &
  sleep 3
  curl -s http://localhost:3000/auth/intuit/refresh
  ```
  Then re-check status. If server still doesn't respond after starting, tell user:
  `⚠️ QuickBooks server failed to start. Please check ~/Quickbooks/index.js manually.` and stop.

> **Never silently fail.** Always report the server/auth state to the user before attempting the lookup.

**Step 1 — Run the lookup script** (handles customer search, transaction fetch, and CSV generation in one command):
```bash
node /path/to/skills/client-lookup/scripts/client-lookup.js "<CUSTOMER_NAME>"
```

The script outputs a single JSON line on success:
```json
{
  "customer": "Smith, Jane",
  "customer_id": "100",
  "notes": "",
  "balance": 0,
  "balance_flag": "ZERO",
  "transaction_count": 8,
  "unpaid_invoices": 0,
  "last_activity": "2026-01-15",
  "report_path": "~/Quickbooks/Reports/Smith__Jane_report.csv",
  "multiple_matches": null
}
```

Exit codes:
- `0` = success, JSON printed to stdout
- `2` = not authenticated → run manual refresh (Step 0), then retry once; if still failing direct user to `http://localhost:3000/auth/intuit`
- `4` = no exact match found → respond: "No exact match found for **'<query>'**. Please use the standard format: **Lastname, Givenname** (e.g. `Smith, Jane`). Would you like to search again?" Do not offer to list all customers.
- `99` = unexpected error → show the raw error output to the user, do not silently swallow it

**Step 2 — Post a summary to Slack (#quickbooks):**

After a successful lookup, immediately post a summary to the `#quickbooks` channel using:
```bash
openclaw message send --channel slack --target "#quickbooks" --message "<SUMMARY>"
```

Format the summary message exactly like this (use actual values from the JSON output):
```
✅ *Client Lookup Complete — <customer>*

• *Balance:* $<balance><CREDIT_FLAG>
• *Transactions:* <transaction_count> total
• *Unpaid Invoices:* <unpaid_invoices>
• *Last Activity:* <last_activity>
• *Report:* `<report_path>`
<NOTES_LINE>
```

Rules for optional fields:
- `<CREDIT_FLAG>`: if `balance_flag` is `CREDIT`, append ` ⚠️ (credit/overpayment)` after the balance
- `<NOTES_LINE>`: if `notes` is non-empty, add `• *Notes:* <notes>` as a final line; omit entirely if blank
- If `unpaid_invoices` > 0, prefix that line with ⚠️
- If `multiple_matches` is not null, add a line: `• *Note:* Multiple matches found — used closest match`

**Step 3 — Report to user** using the JSON output from the script (reply in-thread or in the same channel where the request came from):
```
✅ Report saved: <report_path>

| Field         | Details                   |
|---------------|---------------------------|
| Customer      | <customer>                |
| Notes         | <notes if any>            |
| Balance       | $<balance>                |
| Transactions  | <transaction_count> total |
| Last Activity | <last_activity>           |
```
- If `balance_flag` is `CREDIT` → flag as credit/overpayment
- If `unpaid_invoices` > 0 → flag with ⚠️ unpaid invoices
- If `multiple_matches` is not null → note which match was used

**Step 4 — Ask whether to email the CSV file:**

Ask exactly once:

`Do you want me to send this to ${DEFAULT_EMAIL_TO}?`

- If user says **yes** (or equivalent) → send to `${DEFAULT_EMAIL_TO}`. Do not ask for an address.
- If user says **no** → skip, log `email_skipped`.
- If user explicitly provides a different address → use that instead.
- Use sender address `${EMAIL_FROM}` and himalaya account `${HIMALAYA_ACCOUNT}` for all outbound emails.

> **Config (set once in your environment or update these placeholders):**
> - `DEFAULT_EMAIL_TO` = recipient's default email address
> - `EMAIL_FROM` = sender email address tied to the himalaya account
> - `HIMALAYA_ACCOUNT` = himalaya account name (e.g. `everalpha`)

**Email send command** — use `himalaya template send` (NOT `message send`) with MML syntax to attach the CSV file:
```bash
printf 'From: ${EMAIL_FROM}\nTo: ${DEFAULT_EMAIL_TO}\nSubject: QuickBooks Report: <CUSTOMER_NAME>\n\nPlease find the QuickBooks report for <CUSTOMER_NAME> attached.\n\n<#part filename="<REPORT_PATH>" type="text/csv">\n<#/part>\n' | himalaya template send -a ${HIMALAYA_ACCOUNT}
```

> **Important:** `message send` does NOT support attachments. Always use `template send` with MML `<#part>` syntax for file attachments. CRLF line endings are not needed with `template send`.

**Step 5 — Append an action log entry with timestamp:**
For every `Client-look-up` request, append one JSONL line to:
`~/Quickbooks/Reports/client-lookup.log`

Also append a human-readable entry to:
`~/Quickbooks/Reports/client-lookup-readable.log`

Use helper script:
```bash
node /path/to/skills/client-lookup/scripts/log-action.js \
  --query "<CUSTOMER_NAME>" \
  --customer_id "<ID>" \
  --customer_name "<MATCHED_NAME>" \
  --report_path "~/Quickbooks/Reports/<SafeName>_report.csv" \
  --status success \
  --email_prompted true \
  --email_decision pending \
  --email_to "" \
  --notes "Report generated; waiting for email instructions."
```

Minimum fields:
- `timestamp` (ISO 8601)
- `action` (e.g. `client_lookup`)
- `query` (requested customer name)
- `customer_id`
- `customer_name`
- `originator` (request source, e.g. Slack username)
- `report_path`
- `status` (`success` or `error`)
- `email_prompted` (`true`/`false`)
- `email_decision` (`pending|skipped|requested|sent`)
- `email_to` (empty string if not provided)
- `notes` (short human-readable summary)

Example:
```json
{"timestamp":"2026-01-15T10:00:00.000Z","action":"client_lookup","query":"Smith, Jane","customer_id":"100","customer_name":"Smith, Jane","report_path":"~/Quickbooks/Reports/Smith__Jane_report.csv","status":"success","email_prompted":true,"email_decision":"pending","email_to":"","notes":"Report generated; waiting for email instructions."}
```

---

## 7. Error Handling

| Error | Cause | Fix |
|---|---|---|
| `Not authenticated` | No tokens / server restarted without token file | Re-run Initial OAuth (Section 1) |
| `NO_MATCH` | Customer name not found | Reply: "No exact match found. Standard format: **Lastname, Givenname**" |
| `invalid_grant` | Refresh token expired or token file was deleted | Re-run Initial OAuth |
| Server not responding | `node index.js` not running | `cd ~/Quickbooks && node index.js &` |
| Multiple matches | Search is ambiguous | Show all matches; ask user to confirm |
