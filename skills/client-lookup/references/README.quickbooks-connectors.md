# QuickBooks Client Lookup Skill

A lightweight Node.js + Express server that connects to the QuickBooks Online API via OAuth 2.0 to retrieve customers and transactions, paired with an OpenClaw agent skill that automates lookups, CSV exports, Slack summaries, and email delivery.

---

## Features

- OAuth 2.0 authentication with QuickBooks Online (auto token rotation every 55 min)
- Retrieve all customers (name, notes, balance)
- Retrieve all transactions (invoices, payments, expenses, bills)
- Look up a specific customer's transactions
- Export customer transactions as a CSV file
- Post formatted summary to Slack `#quickbooks` after every lookup
- Email CSV attachment to default recipient via Himalaya
- Server health check with auto-restart before every lookup

---

## Setup

### 1. Install dependencies

```bash
cd /path/to/Quickbooks
npm install
```

### 2. Create a `.env` file

```
INTUIT_CLIENT_ID=your_client_id
INTUIT_CLIENT_SECRET=your_client_secret
INTUIT_REDIRECT_URI=https://your-tunnel-url/auth/intuit/callback
INTUIT_ENV=production   # or sandbox
PORT=3000
ADMIN_TOKEN=your_admin_token
```

> ⚠️ Never commit `.env` to version control. All credentials must stay in `.env` only.

### 3. Register Redirect URI

In your [Intuit Developer app](https://developer.intuit.com), register your Redirect URI (e.g. your Cloudflare tunnel URL for production).

### 4. Start the server

```bash
node index.js
```

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /auth/intuit` | Start OAuth flow |
| `GET /auth/intuit/callback` | OAuth callback (handled automatically) |
| `GET /auth/status` | Check auth status and token expiry |
| `GET /auth/intuit/refresh` | Manually refresh access token |
| `GET /auth/intuit/revoke` | Revoke access (browser confirmation page) |
| `POST /auth/intuit/revoke` | Revoke access (direct API) |
| `GET /customers` | List all customers |
| `GET /transactions` | List all transactions |
| `GET /customers/:id/transactions` | Transactions for a specific customer |
| `GET /customers/:id/transactions/export` | Download as CSV |

---

## Environment

- **Sandbox:** uses `https://sandbox-quickbooks.api.intuit.com`
- **Production:** uses `https://quickbooks.api.intuit.com`

---

## OpenClaw Agent Skill

### Trigger

Say `Client-look-up <Customer Name>` in any connected channel (e.g. Slack `#quickbooks`).

### Full Workflow (per lookup)

```
Step 0 → Check QB server is running & authenticated (auto-start if down)
Step 1 → Run client-lookup.js script → generates CSV report
Step 2 → Post summary to Slack #quickbooks
Step 3 → Reply to user with report details
Step 4 → Ask: "Do you want me to send this to <default-email>?" (yes/no)
Step 5 → Log action to client-lookup.log and client-lookup-readable.log
```

### Email Delivery

- Uses **Himalaya CLI** with `himalaya template send` (MML `<#part>` syntax for attachments)
- ⚠️ `himalaya message send` does NOT support attachments — always use `template send`
- Sender and recipient are configured in `SKILL.md` (no hardcoded values in scripts)

### Slack Summary Format

```
✅ *Client Lookup Complete — <Customer Name>*

• *Balance:* $<amount>  [⚠️ (credit/overpayment) if negative]
• *Notes:* <notes>      [omitted if blank]
• *Transactions:* <n> total
• *Unpaid Invoices:* <n>  [⚠️ prefix if > 0]
• *Last Activity:* <date>
• *Report:* `/path/to/report.csv`
```

---

## OpenClaw Configuration Requirements

### Agent Model — Tool Call Compatibility

> ⚠️ **Critical:** The agent model **must support full tool calling** (exec, read, write, message).

| Model | Tool Call Support | Compatible |
|---|---|---|
| `anthropic/claude-sonnet-4-6` | Full tool suite | ✅ Recommended |
| `openai/gpt-5.3-codex` | Restricted — only `session_status` via openai-codex provider | ❌ Do not use |

The `openai/gpt-5.3-codex` model routes through the OpenAI Codex provider which applies a minimal tool profile, leaving the agent with no exec, read, or message tools. It will acknowledge requests in chat but never execute them.

**To verify or change the agent model:**
```bash
openclaw config get agents.list
openclaw config set 'agents.list[0].model' '"anthropic/claude-sonnet-4-6"' --strict-json
openclaw daemon restart
```

### Exec Tool Configuration

The exec tool must be set to `host=gateway` (not the default `sandbox`). Sandboxing is off on this machine — if host remains `sandbox`, all exec calls **silently fail** with no error.

```bash
openclaw config set tools.exec.host '"gateway"' --strict-json
openclaw config set tools.exec.security '"allowlist"' --strict-json
openclaw config set tools.exec.ask '"on-miss"' --strict-json
openclaw daemon restart
```

### Exec Approvals Allowlist

The following binaries must be in `~/.openclaw/exec-approvals.json` (full resolved paths required):

| Binary | Path |
|---|---|
| Node.js | `/opt/homebrew/bin/node` |
| curl | `/usr/bin/curl` |
| Himalaya | `/opt/homebrew/bin/himalaya` |
| OpenClaw | `/opt/homebrew/bin/openclaw` |

> ⚠️ Basename-only entries (e.g. `"node"`) are **not matched** by the allowlist enforcer — always use full resolved paths.
>
> ⚠️ Commands not in the allowlist are **silently blocked** with no error message. If the agent says "sending now" but nothing arrives, check the allowlist first.

---

## Token Lifecycle

| Token | Lifetime | Rotation |
|---|---|---|
| Access token | 1 hour | Auto-refreshed every 55 min |
| Refresh token | ~5 years | Rotates on every refresh call |

- Never delete `.tokens.json` while the server is running
- After ~5 years, re-run the Initial OAuth flow once

---

## Scripts

| Script | Purpose |
|---|---|
| `scripts/client-lookup.js "<Name>"` | Full lookup: auth check → customer search → CSV export |
| `scripts/log-action.js [--flags]` | Append entry to JSONL and readable action logs |

Exit codes for `client-lookup.js`:

| Code | Meaning |
|---|---|
| `0` | Success — JSON printed to stdout |
| `2` | Not authenticated — direct user to OAuth flow |
| `4` | No exact match — reply with standard format: **Lastname, Givenname** |
| `99` | Unexpected error — raw error shown to user |

---

## Changelog

| Date | Change |
|---|---|
| 2026-03-24 | Fixed `himalaya message send` → `himalaya template send` for attachment support |
| 2026-03-24 | Added `himalaya` and `openclaw` to exec-approvals allowlist (were silently blocked) |
| 2026-03-24 | Set `tools.exec.host=gateway` — default `sandbox` silently failed (sandboxing is off) |
| 2026-03-24 | Switched agent model from `gpt-5.3-codex` to `anthropic/claude-sonnet-4-6` for full tool support |
| 2026-03-24 | Added Step 0 — server status check with auto-start before every lookup |
| 2026-03-24 | Added Step 2 — automatic Slack summary to `#quickbooks` after every lookup |
| 2026-03-24 | Simplified email prompt: ask yes/no with default address pre-filled, no address input required |
| 2026-03-24 | Removed hardcoded realmId from SKILL.md example response |
| 2026-03-24 | No-match response now instructs standard name format **Lastname, Givenname** instead of listing all customers |
| 2026-03-24 | Email prompt simplified: asks yes/no with default address pre-filled, no address input required |
| 2026-03-24 | Added CreditMemo to `/customers/:id/transactions` and `/customers/:id/transactions/export` endpoints |
| 2026-03-24 | Added JournalEntry to `/customers/:id/transactions` and export — filtered client-side by EntityRef in line items |
| 2026-03-24 | CSV report now includes `PostingType` and `Memo` columns for JournalEntry rows |
