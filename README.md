# QuickBooks Connectors

A lightweight Node.js + Express server that connects to the QuickBooks Online API via OAuth 2.0 to retrieve customers and transactions — integrated with Slack and OpenClaw for instant lookups, CSV exports, and email delivery.

**Current version: 1.4**

## Architecture

![Slack Client Lookup Flow](Slack%20User%20Client%20Lookup-2026-03-28-233341.png)

## Features

- OAuth 2.0 authentication with QuickBooks Online (auto token rotation every 55 min)
- Retrieve all customers (name, notes, balance)
- Retrieve all transactions (invoices, payments, expenses, bills, credit memos, journal entries)
- Look up a specific customer's transactions
- Export customer transactions as a CSV file
- **Slack slash command `/client-look-up`** — instant lookup from any channel or DM, no agent conversation needed
- **One-click email** — send the CSV report to the default recipient directly from the Slack result card
- **Dedicated bonded agents** — one OpenClaw agent per Slack workspace, each with an isolated session that survives gateway restarts

## Setup

1. Clone the repo and install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file in the root directory:
   ```
   INTUIT_CLIENT_ID=your_client_id
   INTUIT_CLIENT_SECRET=your_client_secret
   INTUIT_REDIRECT_URI=http://localhost:3000/auth/intuit/callback
   INTUIT_ENV=sandbox   # or production
   PORT=3000
   ```

3. Register `http://localhost:3000/auth/intuit/callback` as a Redirect URI in your [Intuit Developer app](https://developer.intuit.com).

## Usage

```bash
node index.js
```

Then visit:

| Endpoint | Description |
|---|---|
| `GET /auth/intuit` | Start OAuth flow |
| `GET /auth/intuit/callback` | OAuth callback (handled automatically) |
| `GET /auth/status` | Check authentication status & token expiry |
| `GET /auth/intuit/refresh` | Manually refresh access token |
| `GET /auth/intuit/revoke` | Revoke access (browser confirmation page) |
| `POST /auth/intuit/revoke` | Revoke access (API call) |
| `GET /customers` | List all customers |
| `GET /transactions` | List all transactions |
| `GET /customers/:id/transactions` | Transactions for a specific customer |
| `GET /customers/:id/transactions/export` | Download as CSV |

## Environment

- **Sandbox:** uses `https://sandbox-quickbooks.api.intuit.com`
- **Production:** uses `https://quickbooks.api.intuit.com`

---

## v1.3 — Slack Slash Command & Dedicated Agents

### `/client-look-up` Slash Command

v1.3 introduces a standalone Python Slack Bolt app (`client-lookup-slack-app/app.py`) that handles the `/client-look-up` slash command independently of the OpenClaw agent conversation loop.

| | Before (v1.2) | After (v1.3) |
|---|---|---|
| Trigger | Chat message to agent | `/client-look-up Lastname, Firstname` |
| Response time | Agent interpretation + routing | Direct subprocess call — instant ACK |
| Reliability | Depends on agent context/state | Standalone app, always available |
| Email prompt | Conversational yes/no reply | One-click **Send Email** button in Slack |
| Works in any channel/DM | ✅ | ✅ |

**How it works:**
1. User types `/client-look-up Smith, Jane` in any Slack channel or DM
2. App ACKs within 3 seconds (Slack requirement)
3. Runs `scripts/client-lookup.js` in a background thread
4. Posts a formatted result card with customer name, balance, transaction count, and report path
5. Shows a **Send Email** button — one click sends the CSV via Himalaya CLI to the configured recipient

**Setup overview:**
1. Create a Slack app with Socket Mode ON, Interactivity ON, scope `chat:write` + `files:write` + `commands`, and a `/client-look-up` slash command
2. Copy `client-lookup-slack-app/.env.example` to `.env.<workspace>` and fill in tokens + email config
3. Create a macOS LaunchAgent plist pointing to `app.py` with `DOTENV_PATH` set — see `skills/client-lookup/references/README.quickbooks-connectors.md` for a full template
4. Load: `launchctl load ~/Library/LaunchAgents/com.<user>.client-lookup-<workspace>.plist`

A single `app.py` supports multiple Slack workspaces simultaneously — each instance loads a different `.env.<workspace>` file via the `DOTENV_PATH` environment variable.

---

### Dedicated Bonded Agents per Workspace

v1.3 assigns one OpenClaw agent per Slack workspace, permanently bound in `~/.openclaw/openclaw.json`:

| Agent | Workspace | Binding |
|---|---|---|
| `main` | Primary workspace | Default fallback — no binding needed |
| `ea` | Secondary workspace | Explicit route binding in `openclaw.json` |

Bindings are stored in the top-level `bindings` array and **survive gateway restarts automatically**:

```json
"bindings": [
  {
    "type": "route",
    "agentId": "ea",
    "match": { "channel": "slack", "accountId": "your-workspace-id" }
  }
]
```

To create a bonded agent:
```bash
openclaw agents add ea --workspace ~/.openclaw/workspace --bind "slack:your-workspace-id"
```

> ⚠️ Set `groupPolicy: "open"` for each workspace account — `"allowlist"` silently drops all channel messages even when the sender is in `allowFrom`.

---

## Openclaw Implementation

This server is designed to be used as a background service by [Openclaw](https://openclaw.ai). The `client-lookup` skill bundled with this repo works out of the box in Claude Code, but requires the following modifications to run inside Openclaw.

### What Openclaw Needs to Modify

#### 1. Email Delivery — Use Openclaw's Native Email Skill

The original `client-lookup` skill generates a CSV report and asks the user if they want to email it. In Claude Code this uses `nodemailer` with a Google Workspace SMTP connection.

**In Openclaw**, replace the nodemailer step with Openclaw's built-in email skill:

```
# Instead of calling nodemailer directly, invoke:
@email send --to <recipient> --subject "QuickBooks Report: <CustomerName>" --attachment <report_path>
```

- Openclaw's email skill handles authentication, SMTP config, and delivery natively
- No SMTP credentials need to be embedded in the skill or committed to Git
- Sender address is configured once in Openclaw's email skill settings — not in this repo

#### 2. Email Addresses — Never Hardcode, Use Openclaw Config

Email addresses (sender and default recipient) **must not be hardcoded** in the skill or committed to the repository. Instead:

- Store them in Openclaw's workspace config or environment variables
- Reference them as `{{EMAIL_SENDER}}` and `{{EMAIL_DEFAULT_RECIPIENT}}` in the skill
- Example Openclaw config entry (keep this file out of Git):
  ```
  EMAIL_SENDER=your-sender@yourdomain.com
  EMAIL_DEFAULT_RECIPIENT=your-recipient@yourdomain.com
  ```

#### 3. Log File Path — Adjust to Openclaw Workspace

The skill writes action logs to a local Reports folder. In Openclaw, update the log path in
`scripts/log-action.js` to use the Openclaw workspace path, or pass it via argument:

```bash
node scripts/log-action.js \
  --logPath /Users/<you>/.openclaw/workspace/logs/client-lookup.log \
  --query "..." ...
```

#### 4. OAuth Tunnel — Use a Persistent HTTPS URL

For production OAuth, a public HTTPS URL is required (Intuit does not accept `http://localhost`
in production). Use a Cloudflare named tunnel with a permanent subdomain:

- Create tunnel: `cloudflared tunnel create quickbooks-connector`
- Route subdomain: `cloudflared tunnel route dns quickbooks-connector qb.yourdomain.com`
- **Recommended:** Use a permanent subdomain (e.g. `qb.yourdomain.com`) — never a temporary URL
- Update `INTUIT_REDIRECT_URI` in your local `.env` (not committed to Git)
- Register the stable URL in the Intuit Developer portal under **Production → Redirect URIs**

#### 5. After Running `openclaw doctor` — Restore Stripped Settings

`openclaw doctor` rewrites `~/.openclaw/openclaw.json` to a minimal safe state. This removes several settings required for the QuickBooks connector and `client-lookup` skill to function. After every `openclaw doctor` run, verify and restore **all** of the following:

**a) Gateway mode must be set to `local`**

`openclaw doctor` removes `gateway.mode`, which blocks the gateway from starting.

Check the error log:
```bash
cat ~/.openclaw/logs/gateway.err.log | tail -5
# If you see: "Gateway start blocked: set gateway.mode=local (current: unset)"
```

Fix — add `"mode": "local"` inside the `gateway` block in `~/.openclaw/openclaw.json`:
```json
"gateway": {
  "mode": "local",
  "auth": {
    "mode": "token",
    "token": "<your-token>"
  }
}
```

Then restart the gateway:
```bash
launchctl bootout gui/$(id -u)/ai.openclaw.gateway
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

Verify recovery:
```bash
openclaw gateway status | grep "RPC probe"
# Expected: RPC probe: ok
```

**b) Exec approvals must be re-granted for `node` and `curl`**

`openclaw doctor` clears exec approvals. Without them, the `client-lookup` skill stalls silently after the agent says "I'm on it..." — it cannot execute Node.js scripts or make curl requests.

Re-add the approvals:
```bash
openclaw approvals allowlist add "/opt/homebrew/opt/node/bin/node"
openclaw approvals allowlist add "node"
openclaw approvals allowlist add "/usr/bin/curl"
openclaw approvals allowlist add "curl"
```

Verify:
```bash
openclaw approvals get
# Should show 4 entries under Allowlist
```

**c) Slack `groupPolicy` must be restored to `open`**

`openclaw doctor` resets the Slack channel's `groupPolicy` to `"allowlist"` with no channels listed. This causes the agent to silently ignore all Slack channel messages — the bot stays connected and shows `OK` in status, but never responds.

Symptom: Messages in Slack show no response from the agent, or "Slack couldn't send this message".

Fix — update the `channels.slack` block in `~/.openclaw/openclaw.json`:
```json
"channels": {
  "slack": {
    "groupPolicy": "open",
    "dmPolicy": "open",
    "allowFrom": ["*"],
    ...
  }
}
```

Then restart the gateway (same command as above). Verify:
```bash
openclaw status | grep Slack
# Expected: Slack │ ON │ OK
```

**d) `nativeSkills` must be set to `true`**

`openclaw doctor` resets `commands.nativeSkills` to `"auto"`. With `"auto"`, the agent must call the `read` tool to load the skill file before executing — but `gpt-5.3-codex` skips this step and only sends an acknowledgment, never actually running the skill.

Symptom: The agent says "I'm on it / Running it now" but never delivers results or asks about emailing.

Fix — in `~/.openclaw/openclaw.json`:
```json
"commands": {
  "native": "auto",
  "nativeSkills": true,
  ...
}
```

With `nativeSkills: true`, the full skill content is injected directly into the agent's system prompt — no `read` tool call needed, and the agent runs the exec command immediately.

After changing, also delete the stale channel session so it starts fresh:
```bash
# Find and remove the quickbooks channel session file
ls ~/.openclaw/agents/main/sessions/*.jsonl
rm ~/.openclaw/agents/main/sessions/<channel-session-id>.jsonl
```

Then restart the gateway.

**e) Verify only required channels are enabled**

`openclaw doctor` may re-enable channels that were previously disabled. After running doctor, check `~/.openclaw/openclaw.json` and confirm only the channels you actively use are set to `"enabled": true`. Disabled channel plugins that are re-enabled without their runtime installed will cause every agent response to fail.

---

#### 6. Server Startup — Register as Openclaw Background Service

Instead of manually running `node index.js`, register the server as an Openclaw background service
so it starts automatically:

```yaml
# openclaw-service.yaml  ← keep this file out of Git
name: quickbooks-connector
command: node /path/to/Quickbooks/index.js
restart: always
env_file: /path/to/Quickbooks/.env
```

---

### What Does NOT Need to Change

| Component | Status |
|---|---|
| OAuth flow (`/auth/intuit`) | ✅ Works as-is |
| Token auto-refresh (every 55 min) | ✅ Works as-is |
| Token persistence (`.tokens.json`) | ✅ Works as-is |
| Customer & transaction endpoints | ✅ Works as-is |
| CSV generation & Reports folder | ✅ Works as-is |
| `log-action.js` script | ✅ Works as-is (path configurable) |
| Revoke endpoint | ✅ Works as-is |

---

### Sensitive Files — Never Commit to Git

The following are already in `.gitignore` and must **never** be committed:

| File | Contains |
|---|---|
| `.env` | Client ID, Client Secret, Redirect URI |
| `.tokens.json` | Live OAuth access & refresh tokens |
| `*.csv` | Customer financial data |
| `.email-config` | Sender/recipient email addresses |
| `openclaw-service.yaml` | Service paths and config |

To verify nothing sensitive is staged before every commit:
```bash
git diff --cached --name-only
git status
```

---

## Changelog

| Version | Date | Changes |
|---|---|---|
| **v1.4** | 2026-03-29 | All slash command responses now visible to the full channel (`response_type: in_channel`) — previously only the result card was public. Caller identity (`@username`) now prepended to every message and shown as a context block on the result card. **Send Email** button replaced with a recipient picker modal — click the button to choose from a pre-approved address list (`APPROVED_EMAILS` env var, comma-separated) rather than sending to a hardcoded default. |
| **v1.3** | 2026-03-25 | Standalone Python Slack Bolt app (`client-lookup-slack-app/`) handling `/client-look-up` slash command directly — no agent conversation required. One-click **Send Email** button replaces conversational yes/no prompt. Dedicated bonded OpenClaw agent per Slack workspace with bindings persisted in `openclaw.json` — survive gateway restarts. macOS LaunchAgent plists auto-start and keep-alive one app instance per workspace. Hardcoded absolute paths replaced with env-var-driven `QB_REPORTS_DIR` in scripts. All example data in docs replaced with generic placeholders. Added `.gitignore` covering Node, Python, secrets, and runtime state. |
| **v1.2** | 2026-03-24 | Remove agent-name and platform-specific references from docs; replace with generic language. Add JournalEntry and CreditMemo to `/customers/:id/transactions` and export endpoint. CSV report updated with `Date`, `Type`, `No.`, `Amount`, `Status` columns matching QB web UI. No-match response now instructs standard name format `Lastname, Givenname`. Email prompt simplified to yes/no with default address pre-filled. Added log rotation to `log-action.js` (1 MB limit, 5 archives). Added `.claude/` to `.gitignore`. |
| **v1.1** | 2026-03-24 | Dual-port security: port 3000 localhost-only (no token), port 3001 public via Cloudflare tunnel (requires `ADMIN_TOKEN`). Added `requireAdminToken` middleware. |
| **v1.0** | 2026-03-24 | Initial stable release. OAuth 2.0 with auto token rotation, customer and transaction endpoints, CSV export, Openclaw integration guide, security hardening. |
