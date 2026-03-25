import json
import logging
import os
import subprocess
import threading
from logging.handlers import RotatingFileHandler
from pathlib import Path

from dotenv import load_dotenv
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

# Support DOTENV_PATH so two instances (openclaw-studio / ever-alpha)
# can share the same app.py with different .env files
load_dotenv(os.environ.get("DOTENV_PATH", ".env"))

# ── Config ─────────────────────────────────────────────────────────────────────
SLACK_BOT_TOKEN  = os.environ["SLACK_BOT_TOKEN"]
SLACK_APP_TOKEN  = os.environ["SLACK_APP_TOKEN"]
NODE_BIN         = os.environ.get("NODE_BIN",  "/opt/homebrew/opt/node/bin/node")
LOOKUP_SCRIPT    = os.environ.get("LOOKUP_SCRIPT", "")
LOG_DIR          = Path(os.environ.get("LOG_DIR", str(Path(__file__).parent / "logs")))
LOG_FILE         = LOG_DIR / os.environ.get("LOG_FILE", "client-lookup.log")
LOG_MAX_BYTES    = int(os.environ.get("LOG_MAX_BYTES", str(5 * 1024 * 1024)))
LOG_BACKUP_COUNT = int(os.environ.get("LOG_BACKUP_COUNT", "5"))

DEFAULT_EMAIL_TO  = os.environ.get("DEFAULT_EMAIL_TO", "")
EMAIL_FROM        = os.environ.get("EMAIL_FROM", "")
HIMALAYA_ACCOUNT  = os.environ.get("HIMALAYA_ACCOUNT", "")
HIMALAYA_BIN      = os.environ.get("HIMALAYA_BIN", "/opt/homebrew/bin/himalaya")

LOG_DIR.mkdir(parents=True, exist_ok=True)

# ── Logging ────────────────────────────────────────────────────────────────────
LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
root_logger = logging.getLogger()
root_logger.setLevel(logging.INFO)
for h in [
    logging.StreamHandler(),
    RotatingFileHandler(LOG_FILE, maxBytes=LOG_MAX_BYTES,
                        backupCount=LOG_BACKUP_COUNT, encoding="utf-8"),
]:
    h.setFormatter(logging.Formatter(LOG_FORMAT))
    root_logger.addHandler(h)

logger = logging.getLogger("client-lookup")

# ── Slack App ──────────────────────────────────────────────────────────────────
app = App(token=SLACK_BOT_TOKEN)


# ── Helpers ────────────────────────────────────────────────────────────────────
def run_lookup(name: str) -> dict:
    """Run the Node lookup script; return parsed result dict."""
    result = subprocess.run(
        [NODE_BIN, LOOKUP_SCRIPT, name],
        capture_output=True, text=True, timeout=60
    )
    return {
        "returncode": result.returncode,
        "stdout":     result.stdout.strip(),
        "stderr":     result.stderr.strip(),
    }


def send_email(customer: str, report_path: str) -> str:
    """Send the CSV report via himalaya. Returns status message."""
    if not DEFAULT_EMAIL_TO or not HIMALAYA_ACCOUNT:
        return "❌ Email not configured (missing DEFAULT_EMAIL_TO or HIMALAYA_ACCOUNT)."

    template = (
        f"From: {EMAIL_FROM}\n"
        f"To: {DEFAULT_EMAIL_TO}\n"
        f"Subject: QuickBooks Report: {customer}\n\n"
        f"Please find the QuickBooks report for {customer} attached.\n\n"
        f'<#part filename="{report_path}" type="text/csv">\n'
        f"<#/part>\n"
    )
    try:
        result = subprocess.run(
            [HIMALAYA_BIN, "template", "send", "-a", HIMALAYA_ACCOUNT],
            input=template, capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0:
            logger.info("Email sent for '%s' to %s", customer, DEFAULT_EMAIL_TO)
            return f"✅ Report sent to {DEFAULT_EMAIL_TO}."
        else:
            logger.error("Email failed: %s", result.stderr[:300])
            return f"❌ Email failed:\n```{result.stderr[:300]}```"
    except Exception as e:
        logger.exception("Email send exception")
        return f"❌ Email error: {e}"


def format_balance(balance, flag: str) -> str:
    try:
        val = float(balance)
    except (TypeError, ValueError):
        return str(balance)
    formatted = f"${val:,.2f}"
    if flag == "CREDIT":
        return f"{formatted} ⚠️ credit/overpayment"
    if flag == "BALANCE_DUE":
        return f"{formatted} 🔴 balance due"
    return f"{formatted} ✅"


def build_slack_blocks(data: dict, include_email_prompt: bool = False) -> list:
    """Turn the JSON result from client-lookup.js into Slack Block Kit blocks."""
    balance_str = format_balance(data.get("balance"), data.get("balance_flag", ""))
    multi = data.get("multiple_matches")

    lines = [
        f"*Customer:* {data['customer']}",
        f"*Balance:* {balance_str}",
        f"*Transactions:* {data['transaction_count']} total",
        f"*Unpaid invoices:* {data['unpaid_invoices']}",
        f"*Last activity:* {data.get('last_activity', 'N/A')}",
    ]
    if data.get("notes"):
        lines.append(f"*Notes:* {data['notes']}")
    if multi:
        lines.append(f"*Other matches:* {', '.join(multi[1:5])}"
                     + (" …" if len(multi) > 5 else ""))

    lines.append(f"\n`{data['report_path']}`")

    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": f"Client Lookup — {data['customer']}", "emoji": True}},
        {"type": "section", "text": {"type": "mrkdwn", "text": "\n".join(lines)}},
        {"type": "divider"},
    ]

    if include_email_prompt and DEFAULT_EMAIL_TO:
        # Encode customer + report_path into the button value (pipe-separated)
        action_value = json.dumps({
            "customer": data["customer"],
            "report_path": data.get("report_path", ""),
        })
        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"📧 Send report to *{DEFAULT_EMAIL_TO}*?",
            },
            "accessory": {
                "type": "button",
                "text": {"type": "plain_text", "text": "Send Email", "emoji": True},
                "style": "primary",
                "action_id": "send_email_yes",
                "value": action_value,
            },
        })

    return blocks


def post_result(respond, channel: str, name: str):
    """Run lookup and post result; called in a background thread."""
    logger.info("Running lookup for '%s' in channel=%s", name, channel)

    proc = run_lookup(name)
    rc   = proc["returncode"]

    # ── Success ──────────────────────────────────────────────────────────────
    if rc == 0:
        try:
            data = json.loads(proc["stdout"])
        except json.JSONDecodeError:
            respond(f"⚠️ Lookup completed but output couldn't be parsed.\n```{proc['stdout'][:500]}```")
            return

        blocks = build_slack_blocks(data, include_email_prompt=bool(DEFAULT_EMAIL_TO))
        respond(
            text=f"Client lookup: {data['customer']}",
            blocks=blocks,
            response_type="in_channel",
        )
        return

    # ── Error cases ──────────────────────────────────────────────────────────
    if rc == 2:
        respond("❌ QuickBooks is not authenticated. Visit http://localhost:3000/auth/intuit to reconnect.")
    elif rc == 3:
        respond(f"❌ Error fetching customers from QuickBooks.\n```{proc['stderr'][:300]}```")
    elif rc == 4:
        respond(f"🔍 No client found matching *{name}*.\nUse format: `Lastname, Firstname`")
    else:
        err = proc["stderr"] or proc["stdout"] or "Unknown error"
        respond(f"❌ Lookup failed (exit {rc}):\n```{err[:300]}```")

    logger.warning("Lookup for '%s' failed rc=%s stderr=%s", name, rc, proc["stderr"][:200])


# ── Button action: Send Email ──────────────────────────────────────────────────
@app.action("send_email_yes")
def handle_send_email(ack, body, respond):
    ack()

    try:
        payload   = json.loads(body["actions"][0]["value"])
        customer  = payload["customer"]
        report    = payload["report_path"]
    except (KeyError, json.JSONDecodeError) as e:
        respond(f"❌ Could not parse email request: {e}")
        return

    logger.info("Email requested for '%s' → %s", customer, DEFAULT_EMAIL_TO)

    if not report or not Path(report).exists():
        respond(f"❌ Report file not found: `{report}`")
        return

    status = send_email(customer, report)
    respond(status)


# ── Slash command handler ──────────────────────────────────────────────────────
@app.command("/client-look-up")
def handle_client_lookup(ack, respond, command):
    ack()   # must ACK within 3 s — do it first, before any processing

    name    = (command.get("text") or "").strip()
    channel = command.get("channel_id", "")
    user    = command.get("user_id", "")

    logger.info("/client-look-up invoked user=%s channel=%s name='%s'", user, channel, name)

    if not name:
        respond("Usage: `/client-look-up Lastname, Firstname`\nExample: `/client-look-up Smith, Jane`")
        return

    # Acknowledge visibly, then process in background
    respond(f"🔍 Looking up *{name}*…")
    threading.Thread(target=post_result, args=(respond, channel, name), daemon=True).start()


# ── Entry point ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    logger.info(
        "Starting client-lookup Slack app | script=%s | log=%s",
        LOOKUP_SCRIPT, LOG_FILE,
    )
    SocketModeHandler(app, SLACK_APP_TOKEN).start()
