# QuickBooks Connectors

A lightweight Node.js + Express server that connects to the QuickBooks Online API via OAuth 2.0 to retrieve customers and transactions.

## Features

- OAuth 2.0 authentication with QuickBooks Online
- Retrieve all customers (name, notes, balance)
- Retrieve all transactions (invoices, payments, expenses, bills)
- Look up a specific customer's transactions
- Export customer transactions as a CSV file

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

`openclaw doctor` resets the Slack channel's `groupPolicy` to `"allowlist"` with no channels listed. This causes Solo to silently ignore all Slack channel messages — the bot stays connected and shows `OK` in status, but never responds.

Symptom: Messages in Slack show no response from Solo, or "Slack couldn't send this message".

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

Symptom: Solo says "I'm on it / Running it now" but never delivers results or asks about emailing.

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

**e) WhatsApp channel — stays disabled**

`openclaw doctor` may re-enable channels. Confirm WhatsApp remains off in `~/.openclaw/openclaw.json`:
```json
"channels": {
  "whatsapp": { "enabled": false }
}
```
If the runtime is not installed and the channel is enabled, every agent response will fail with:
`WhatsApp plugin runtime is unavailable: missing light-runtime-api for plugin 'whatsapp'`

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
