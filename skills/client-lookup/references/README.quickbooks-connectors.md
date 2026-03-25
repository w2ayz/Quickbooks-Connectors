# QuickBooks Client Lookup Skill

A lightweight Node.js + Express server that connects to the QuickBooks Online API via OAuth 2.0 to retrieve customers and transactions, paired with an OpenClaw agent skill that automates lookups, CSV exports, Slack summaries, and email delivery.

**Current version: 1.3** — Slack slash command + dedicated bonded agents per workspace

---

## What's New in v1.3 — Slack Slash Command & Dedicated Agents

### `/client-look-up` Slash Command

Before v1.3, lookups required typing a natural-language message in Slack and waiting for the OpenClaw agent to interpret it, route it, and respond — which could be slow and was vulnerable to the agent being busy or misrouting the request.

**v1.3 introduces a dedicated Python Slack Bolt app** that handles the `/client-look-up` slash command directly:

| | Before (v1.2) | After (v1.3) |
|---|---|---|
| Trigger | Chat message to agent | `/client-look-up Lastname, Firstname` |
| Latency | Agent interpretation + routing | Direct subprocess call — instant ACK |
| Reliability | Depends on agent context/state | Standalone app, always available |
| Email prompt | Conversational yes/no reply | One-click **Send Email** button in Slack |
| Works in any channel | ✅ (if agent is there) | ✅ (slash commands work everywhere) |
| Works in DMs | ✅ | ✅ |

The app:
1. ACKs the command within 3 seconds (Slack requirement)
2. Runs `client-lookup.js` in a background thread
3. Posts a formatted Block Kit card with customer details
4. Shows a **Send Email** button — one click sends the CSV report via Himalaya to the default recipient, no conversation needed

### Dedicated Bonded Agents per Workspace

Before v1.3, a single OpenClaw agent handled multiple Slack workspaces from a shared session. This caused:
- Cross-workspace context bleed
- DM routing failures (wrong agent picking up messages)
- Loss of binding after gateway restarts

**v1.3 establishes one dedicated agent per workspace**, each permanently bound in `openclaw.json`:

| Agent | Workspace | Bound via |
|---|---|---|
| `main` | openclaw-studio (default) | fallback — no binding needed |
| `ea` | ever-alpha | explicit route binding in `openclaw.json` |

The binding is stored in the top-level `bindings` array in `~/.openclaw/openclaw.json` and **survives gateway restarts automatically** — it does not need to be re-applied after a reboot.

---

## Features

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

---

## v1.3 Implementation Guide

### Part A — Slash Command App (`client-lookup-slack-app`)

#### Directory structure

```
client-lookup-slack-app/
  app.py                    # Slack Bolt app — single file, shared by all workspace instances
  .venv/                    # Python virtual environment
  .env.<workspace>          # Per-workspace tokens and email config (never commit)
  logs/
    <workspace>.out.log
    <workspace>.err.log
~/Library/LaunchAgents/
  com.<user>.client-lookup-<workspace>.plist   # macOS LaunchAgent per workspace
```

#### 1. Create the Python virtual environment

```bash
cd /path/to/client-lookup-slack-app
python3 -m venv .venv
.venv/bin/pip install slack-bolt python-dotenv
```

#### 2. Create a Slack app for each workspace

Go to [https://api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.

For each workspace app, configure:

| Setting | Value |
|---|---|
| **Socket Mode** | Enable |
| **App-Level Token** | Generate with scope `connections:write` → this is your `SLACK_APP_TOKEN` (`xapp-…`) |
| **OAuth Scopes** (Bot Token) | `chat:write`, `files:write`, `commands` |
| **Slash Commands** | Add `/client-look-up` (Request URL can be any placeholder — Socket Mode ignores it) |
| **Interactivity** | Enable (required for slash commands and button actions in Socket Mode) |
| **Install to workspace** | Install and copy the **Bot User OAuth Token** (`xoxb-…`) |

#### 3. Create a `.env.<workspace>` file for each instance

```ini
# Slack tokens — get from api.slack.com/apps → your app
SLACK_BOT_TOKEN=xoxb-REPLACE_ME
SLACK_APP_TOKEN=xapp-REPLACE_ME

# Lookup script
NODE_BIN=/opt/homebrew/opt/node/bin/node
LOOKUP_SCRIPT=/path/to/skills/client-lookup/scripts/client-lookup.js
LOG_FILE=client-lookup-<workspace>.log

# Email delivery (via Himalaya)
DEFAULT_EMAIL_TO=recipient@example.com
EMAIL_FROM=sender@example.com
HIMALAYA_ACCOUNT=your-himalaya-account-name
HIMALAYA_BIN=/opt/homebrew/bin/himalaya
```

> ⚠️ Add `.env.*` to `.gitignore`. Never commit tokens.

#### 4. Create a LaunchAgent plist for each workspace instance

Save to `~/Library/LaunchAgents/com.<user>.client-lookup-<workspace>.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.<user>.client-lookup-<workspace></string>

    <key>ProgramArguments</key>
    <array>
      <string>/path/to/client-lookup-slack-app/.venv/bin/python</string>
      <string>/path/to/client-lookup-slack-app/app.py</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/path/to/client-lookup-slack-app</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PYTHONUNBUFFERED</key>
      <string>1</string>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/usr/local/bin:/usr/bin:/bin</string>
      <key>DOTENV_PATH</key>
      <string>/path/to/client-lookup-slack-app/.env.<workspace></string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/path/to/client-lookup-slack-app/logs/<workspace>.out.log</string>

    <key>StandardErrorPath</key>
    <string>/path/to/client-lookup-slack-app/logs/<workspace>.err.log</string>
  </dict>
</plist>
```

`RunAtLoad: true` starts the app at login. `KeepAlive: true` auto-restarts it if it crashes.

#### 5. Load and verify

```bash
# Create the logs directory first
mkdir -p /path/to/client-lookup-slack-app/logs

# Load the agent
launchctl load ~/Library/LaunchAgents/com.<user>.client-lookup-<workspace>.plist

# Verify it started
tail -f /path/to/client-lookup-slack-app/logs/<workspace>.err.log
# Should show: ⚡️ Bolt app is running!
```

To reload after a config change:
```bash
launchctl unload ~/Library/LaunchAgents/com.<user>.client-lookup-<workspace>.plist
launchctl load  ~/Library/LaunchAgents/com.<user>.client-lookup-<workspace>.plist
```

#### 6. Test it

In any Slack channel or DM in the workspace:
```
/client-look-up Lastname, Firstname
```

Expected flow:
1. Slack shows `🔍 Looking up Lastname, Firstname…` immediately
2. Within a few seconds: a Block Kit card appears with customer details
3. A **Send Email** button appears — click to send the CSV to the configured recipient

---

### Part B — Dedicated Bonded Agent per Workspace

#### Why bond an agent to a workspace?

OpenClaw's default behaviour routes all incoming Slack messages to the `main` agent regardless of which workspace they came from. With multiple workspaces this causes:

- **Context bleed** — the `main` agent's session history includes messages from all workspaces, which can mislead its responses
- **DM failures** — DMs from a secondary workspace may be silently dropped or misrouted
- **Loss of workspace identity** — the agent doesn't know which workspace it's talking to when sending messages

Bonding a dedicated agent to each workspace gives each one an isolated session, correct routing for both channels and DMs, and workspace-aware identity.

#### How it works

OpenClaw stores routing rules in the top-level `bindings` array in `~/.openclaw/openclaw.json`. A binding of type `route` tells the gateway: *"when a message arrives from this channel+account, deliver it to this agent."*

```json
"bindings": [
  {
    "type": "route",
    "agentId": "ea",
    "match": { "channel": "slack", "accountId": "ever-alpha" }
  }
]
```

The `main` agent handles all other workspaces by default (no binding needed).

#### Setting up a bonded agent

**Step 1 — Create the agent:**
```bash
openclaw agents add ea --workspace ~/.openclaw/workspace --bind "slack:ever-alpha"
```

This creates the agent AND writes the binding to `openclaw.json` in one step.

**Step 2 — Verify the binding was saved:**
```bash
grep -A 5 '"bindings"' ~/.openclaw/openclaw.json
```

You should see a `route` binding for the new agent. This persists across restarts — no re-configuration needed after a reboot.

**Step 3 — Configure the workspace account in `openclaw.json`:**

Each Slack workspace must be declared as a named account:

```json
"channels": {
  "slack": {
    "accounts": {
      "ever-alpha": {
        "botToken": "xoxb-REPLACE_ME",
        "appToken": "xapp-REPLACE_ME",
        "groupPolicy": "open",
        "dmPolicy": "allowlist",
        "allowFrom": ["UXXXXXXXXX"]
      },
      "openclaw-studio": {
        "botToken": "xoxb-REPLACE_ME",
        "appToken": "xapp-REPLACE_ME",
        "groupPolicy": "open",
        "dmPolicy": "allowlist",
        "allowFrom": ["UXXXXXXXXX"]
      }
    }
  }
}
```

> ⚠️ Once any named account exists, OpenClaw switches to multi-account mode and ignores any top-level `botToken`/`appToken`. All workspaces must be in the `accounts` block.

#### Surviving a gateway restart

The binding and account config are both read from `openclaw.json` at startup — nothing needs to be re-applied after a restart.

After any gateway restart, verify both agents are connected:
```bash
openclaw agents list
# main  → running, connected to openclaw-studio
# ea    → running, connected to ever-alpha
```

#### Important: `groupPolicy` must be `"open"`

Setting `groupPolicy` to `"allowlist"` silently drops **all** channel messages — even from users in `allowFrom` — before they reach the agent. Use `"open"` for channels and `"allowlist"` for DMs only if you want to restrict direct messages.

| Policy | Channels | DMs |
|---|---|---|
| `"open"` | All messages delivered | All messages delivered |
| `"allowlist"` | ⚠️ All messages silently dropped | Only `allowFrom` users delivered |

Recommended:
```json
"groupPolicy": "open",
"dmPolicy": "allowlist",
"allowFrom": ["UXXXXXXXXX"]
```

#### Important: exec-approvals.json wildcard vs. agent-specific sections

OpenClaw's exec approval logic checks agent-specific sections **before** the `*` wildcard. If an empty agent-specific section exists (e.g. `agents.main: {}`), it overrides the wildcard and **blocks all exec** for that agent.

The Control UI may re-add empty agent sections when policies are changed. After any policy change via the UI, verify `~/.openclaw/exec-approvals.json` does not contain empty agent sections:

```json
{
  "agents": {
    "*": {
      "allowlist": [
        { "pattern": "/opt/homebrew/bin/node" },
        { "pattern": "/opt/homebrew/opt/node/bin/node" },
        { "pattern": "/usr/bin/curl" },
        { "pattern": "/usr/bin/printf" },
        { "pattern": "/opt/homebrew/bin/himalaya" },
        { "pattern": "/opt/homebrew/bin/openclaw" },
        { "pattern": "/bin/cat" },
        { "pattern": "/bin/ls" }
      ]
    }
  }
}
```

If `agents.main` or `agents.ea` keys appear with empty or incomplete allowlists, remove them.

---

## Changelog

| Date | Change |
|---|---|
| 2026-03-25 | **v1.3** — Added `/client-look-up` Slack slash command via dedicated Python Slack Bolt app |
| 2026-03-25 | **v1.3** — One-click **Send Email** button in Slack replaces conversational yes/no prompt |
| 2026-03-25 | **v1.3** — Dedicated bonded agents per workspace (`main` → openclaw-studio, `ea` → ever-alpha) |
| 2026-03-25 | **v1.3** — Bindings persisted in `openclaw.json` — survive gateway restarts automatically |
| 2026-03-25 | **v1.3** — Two LaunchAgent plists auto-start and keep-alive one app instance per workspace |
| 2026-03-25 | **v1.3** — Documented `groupPolicy: "open"` requirement and exec-approvals wildcard gotcha |
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
