require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

const {
  INTUIT_CLIENT_ID,
  INTUIT_CLIENT_SECRET,
  INTUIT_REDIRECT_URI,
  INTUIT_ENV = "sandbox",
  ADMIN_TOKEN,
  PORT = 3000,
} = process.env;

// ── Admin auth middleware — protects sensitive endpoints ────────────────────
function requireAdminToken(req, res, next) {
  // Port 3000 = local only (Openclaw/internal) — no token needed
  // Port 3001 = public via Cloudflare tunnel — token required
  const isPublicPort = req.socket.localPort === 3001;
  if (!isPublicPort) return next();

  if (!ADMIN_TOKEN) {
    return res.status(403).json({ error: "Access denied. Set ADMIN_TOKEN in .env to enable remote access." });
  }
  const queryToken = req.query.token;
  const headerToken = (req.headers["authorization"] || "").replace("Bearer ", "");
  if (queryToken === ADMIN_TOKEN || headerToken === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: "Unauthorized. Valid admin token required." });
}

const IS_PRODUCTION = INTUIT_ENV === "production";
const QB_API_BASE = IS_PRODUCTION
  ? "https://quickbooks.api.intuit.com"
  : "https://sandbox-quickbooks.api.intuit.com";

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

// ── Token persistence ──────────────────────────────────────────────────────
const TOKEN_FILE = path.join(__dirname, ".tokens.json");

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      console.log("✅ Loaded saved tokens from disk");
      return data;
    }
  } catch (e) {
    console.warn("⚠️  Could not load tokens file:", e.message);
  }
  return { state: null, access_token: null, refresh_token: null, realmId: null, token_expiry: null };
}

function saveTokens() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(oauthStore, null, 2), "utf8");
  } catch (e) {
    console.warn("⚠️  Could not save tokens file:", e.message);
  }
}

// ── In-memory store — pre-loaded from disk ─────────────────────────────────
let oauthStore = loadTokens();

console.log(`🔧 Environment: ${IS_PRODUCTION ? "PRODUCTION (real account)" : "SANDBOX"}`);
console.log(`🌐 API Base: ${QB_API_BASE}`);
if (oauthStore.access_token) {
  console.log(`🔑 Existing token found for realmId: ${oauthStore.realmId}`);
}

// ── Core refresh function (used by auto-refresh and manual endpoint) ────────
async function refreshTokens() {
  if (!oauthStore.refresh_token) throw new Error("No refresh token available");

  const basic = Buffer.from(`${INTUIT_CLIENT_ID}:${INTUIT_CLIENT_SECRET}`).toString("base64");
  const tokenResp = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: oauthStore.refresh_token,
    }).toString(),
    {
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
    }
  );

  oauthStore.access_token = tokenResp.data.access_token;
  oauthStore.refresh_token = tokenResp.data.refresh_token; // rotate — must save immediately
  oauthStore.token_expiry = Date.now() + (tokenResp.data.expires_in * 1000); // store expiry ms
  saveTokens();
  console.log(`🔄 Token refreshed at ${new Date().toISOString()} — next expiry: ${new Date(oauthStore.token_expiry).toISOString()}`);
  return tokenResp.data;
}

// ── Auto-refresh every 55 minutes ──────────────────────────────────────────
const REFRESH_INTERVAL_MS = 55 * 60 * 1000; // 55 minutes

function startAutoRefresh() {
  setInterval(async () => {
    if (!oauthStore.refresh_token) {
      console.log("⏭️  Auto-refresh skipped — not authenticated yet");
      return;
    }
    try {
      await refreshTokens();
    } catch (err) {
      console.error("❌ Auto-refresh failed:", err.response?.data || err.message);
    }
  }, REFRESH_INTERVAL_MS);
  console.log("⏰ Auto token refresh scheduled every 55 minutes");
}

startAutoRefresh();

// ── Step A: redirect user to Intuit consent screen ─────────────────────────
app.get("/auth/intuit", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  oauthStore.state = state;

  const scope = encodeURIComponent("com.intuit.quickbooks.accounting");
  const redirectUri = encodeURIComponent(INTUIT_REDIRECT_URI);

  const url =
    `${AUTHORIZE_URL}?client_id=${INTUIT_CLIENT_ID}` +
    `&response_type=code` +
    `&scope=${scope}` +
    `&redirect_uri=${redirectUri}` +
    `&state=${state}`;

  res.redirect(url);
});

// ── Step B: callback from Intuit with code + realmId ───────────────────────
app.get("/auth/intuit/callback", async (req, res) => {
  try {
    const { code, state, realmId } = req.query;

    if (!code) return res.status(400).send("Missing code");
    if (state !== oauthStore.state) return res.status(400).send("Invalid state");

    const basic = Buffer.from(`${INTUIT_CLIENT_ID}:${INTUIT_CLIENT_SECRET}`).toString("base64");

    const tokenResp = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: INTUIT_REDIRECT_URI,
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
      }
    );

    oauthStore.access_token = tokenResp.data.access_token;
    oauthStore.refresh_token = tokenResp.data.refresh_token;
    oauthStore.realmId = realmId;
    oauthStore.token_expiry = Date.now() + (tokenResp.data.expires_in * 1000);
    saveTokens(); // persist immediately after first auth
    console.log(`✅ OAuth complete — tokens saved for realmId: ${realmId}`);

    res.json({
      message: "OAuth success",
      realmId,
      expires_in: tokenResp.data.expires_in,
      x_refresh_token_expires_in: tokenResp.data.x_refresh_token_expires_in,
      auto_refresh: "every 55 minutes",
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("OAuth callback failed");
  }
});

// ── Step C: revoke tokens ──────────────────────────────────────────────────
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

app.post("/auth/intuit/revoke", requireAdminToken, async (req, res) => {
  try {
    if (!oauthStore.refresh_token) {
      return res.status(400).json({ error: "No active session to revoke." });
    }

    const basic = Buffer.from(`${INTUIT_CLIENT_ID}:${INTUIT_CLIENT_SECRET}`).toString("base64");

    // Revoke the refresh token with Intuit (this also invalidates the access token)
    await axios.post(
      REVOKE_URL,
      new URLSearchParams({ token: oauthStore.refresh_token }).toString(),
      {
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
      }
    );

    // Clear in-memory store
    oauthStore.access_token = null;
    oauthStore.refresh_token = null;
    oauthStore.realmId = null;
    oauthStore.token_expiry = null;
    oauthStore.state = null;

    // Delete persisted token file
    if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE);
      console.log("🗑️  Token file deleted");
    }

    console.log("🔒 Tokens revoked and session cleared");
    res.json({
      message: "Tokens revoked successfully. Service disconnected from QuickBooks.",
      reconnect: "/auth/intuit",
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Revocation failed: " + err.message });
  }
});

// Convenience GET for browser-based revoke with confirmation page
app.get("/auth/intuit/revoke", requireAdminToken, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Revoke QuickBooks Access</title>
      <style>
        body { font-family: sans-serif; max-width: 480px; margin: 80px auto; text-align: center; }
        h2 { color: #d9534f; }
        p { color: #555; margin: 16px 0; }
        .btn-revoke {
          background: #d9534f; color: white; border: none;
          padding: 12px 32px; font-size: 16px; border-radius: 6px;
          cursor: pointer; margin: 8px;
        }
        .btn-cancel {
          background: #6c757d; color: white; border: none;
          padding: 12px 32px; font-size: 16px; border-radius: 6px;
          cursor: pointer; margin: 8px;
        }
        .status { margin-top: 24px; font-weight: bold; }
      </style>
    </head>
    <body>
      <h2>⚠️ Revoke QuickBooks Access</h2>
      <p>This will disconnect this service from your QuickBooks account.<br>
      All saved tokens will be deleted. You will need to re-authenticate to use the service again.</p>
      <button class="btn-revoke" onclick="revoke()">Yes, Revoke Access</button>
      <button class="btn-cancel" onclick="window.location='/'">Cancel</button>
      <div class="status" id="status"></div>
      <script>
        async function revoke() {
          document.getElementById('status').textContent = 'Revoking...';
          const res = await fetch('/auth/intuit/revoke', { method: 'POST' });
          const data = await res.json();
          document.getElementById('status').textContent = data.message || data.error;
        }
      </script>
    </body>
    </html>
  `);
});

// ── Step D: manual refresh endpoint ────────────────────────────────────────
app.get("/auth/intuit/refresh", requireAdminToken, async (req, res) => {
  try {
    const data = await refreshTokens();
    res.json({
      message: "Token refreshed",
      expires_in: data.expires_in,
      next_expiry: new Date(oauthStore.token_expiry).toISOString(),
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Refresh failed");
  }
});

// ── Step D: token status endpoint ──────────────────────────────────────────
app.get("/auth/status", requireAdminToken, (req, res) => {
  const authenticated = !!(oauthStore.access_token && oauthStore.realmId);
  const expiresIn = oauthStore.token_expiry
    ? Math.round((oauthStore.token_expiry - Date.now()) / 1000)
    : null;
  res.json({
    authenticated,
    realmId: oauthStore.realmId || null,
    token_expires_in_seconds: expiresIn,
    token_expiry: oauthStore.token_expiry ? new Date(oauthStore.token_expiry).toISOString() : null,
    auto_refresh_interval: "every 55 minutes",
  });
});

// ── Helper: make an authenticated QuickBooks API query ─────────────────────
async function qboQuery(query) {
  if (!oauthStore.access_token || !oauthStore.realmId) {
    throw new Error("Not authenticated. Visit /auth/intuit first.");
  }
  const baseUrl = `${QB_API_BASE}/v3/company/${oauthStore.realmId}`;
  const response = await axios.get(`${baseUrl}/query`, {
    params: { query, minorversion: 65 },
    headers: {
      Authorization: `Bearer ${oauthStore.access_token}`,
      Accept: "application/json",
    },
  });
  return response.data.QueryResponse;
}

// ── GET /customers ──────────────────────────────────────────────────────────
app.get("/customers", async (req, res) => {
  try {
    const query = "SELECT * FROM Customer MAXRESULTS 1000";
    const result = await qboQuery(query);
    const customers = (result.Customer || []).map((c) => ({
      id: c.Id,
      name: c.DisplayName || c.FullyQualifiedName,
      companyName: c.CompanyName || null,
      email: c.PrimaryEmailAddr?.Address || null,
      phone: c.PrimaryPhone?.FreeFormNumber || null,
      notes: c.Notes || null,
      active: c.Active,
      balance: c.Balance,
    }));
    res.json({ count: customers.length, customers });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /transactions ───────────────────────────────────────────────────────
app.get("/transactions", async (req, res) => {
  try {
    const [invoiceRes, paymentRes, purchaseRes, billRes] = await Promise.all([
      qboQuery("SELECT * FROM Invoice MAXRESULTS 1000"),
      qboQuery("SELECT * FROM Payment MAXRESULTS 1000"),
      qboQuery("SELECT * FROM Purchase MAXRESULTS 1000"),
      qboQuery("SELECT * FROM Bill MAXRESULTS 1000"),
    ]);

    const invoices = (invoiceRes.Invoice || []).map((i) => ({
      type: "Invoice", id: i.Id, docNumber: i.DocNumber, date: i.TxnDate,
      dueDate: i.DueDate, customerName: i.CustomerRef?.name,
      totalAmount: i.TotalAmt, balance: i.Balance, status: i.EmailStatus,
    }));
    const payments = (paymentRes.Payment || []).map((p) => ({
      type: "Payment", id: p.Id, date: p.TxnDate,
      customerName: p.CustomerRef?.name, totalAmount: p.TotalAmt, unappliedAmount: p.UnappliedAmt,
    }));
    const purchases = (purchaseRes.Purchase || []).map((p) => ({
      type: "Purchase/Expense", id: p.Id, date: p.TxnDate,
      paymentType: p.PaymentType, accountName: p.AccountRef?.name,
      totalAmount: p.TotalAmt, memo: p.PrivateNote || null,
    }));
    const bills = (billRes.Bill || []).map((b) => ({
      type: "Bill", id: b.Id, date: b.TxnDate, dueDate: b.DueDate,
      vendorName: b.VendorRef?.name, totalAmount: b.TotalAmt, balance: b.Balance,
    }));

    const all = [...invoices, ...payments, ...purchases, ...bills].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    res.json({
      count: all.length,
      summary: { invoices: invoices.length, payments: payments.length, purchases: purchases.length, bills: bills.length },
      transactions: all,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /customers/:id/transactions ────────────────────────────────────────
app.get("/customers/:id/transactions", async (req, res) => {
  try {
    const { id } = req.params;
    const [invoiceRes, paymentRes] = await Promise.all([
      qboQuery(`SELECT * FROM Invoice WHERE CustomerRef = '${id}' MAXRESULTS 1000`),
      qboQuery(`SELECT * FROM Payment WHERE CustomerRef = '${id}' MAXRESULTS 1000`),
    ]);

    const invoices = (invoiceRes.Invoice || []).map((i) => ({
      type: "Invoice", id: i.Id, docNumber: i.DocNumber, date: i.TxnDate,
      dueDate: i.DueDate, totalAmount: i.TotalAmt, balance: i.Balance,
    }));
    const payments = (paymentRes.Payment || []).map((p) => ({
      type: "Payment", id: p.Id, date: p.TxnDate,
      totalAmount: p.TotalAmt, unappliedAmount: p.UnappliedAmt,
    }));

    const all = [...invoices, ...payments].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    res.json({ customerId: id, count: all.length, transactions: all });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /customers/:id/transactions/export ─────────────────────────────────
app.get("/customers/:id/transactions/export", async (req, res) => {
  try {
    const { id } = req.params;
    const custRes = await qboQuery(`SELECT * FROM Customer WHERE Id = '${id}'`);
    const customer = (custRes.Customer || [])[0];
    const customerName = customer ? (customer.DisplayName || customer.FullyQualifiedName) : id;

    const [invoiceRes, paymentRes] = await Promise.all([
      qboQuery(`SELECT * FROM Invoice WHERE CustomerRef = '${id}' MAXRESULTS 1000`),
      qboQuery(`SELECT * FROM Payment WHERE CustomerRef = '${id}' MAXRESULTS 1000`),
    ]);

    const invoices = (invoiceRes.Invoice || []).map((i) => ({
      Type: "Invoice", ID: i.Id, DocNumber: i.DocNumber || "", Date: i.TxnDate,
      DueDate: i.DueDate || "", CustomerName: customerName,
      TotalAmount: i.TotalAmt, Balance: i.Balance, UnappliedAmount: "", Status: i.EmailStatus || "",
    }));
    const payments = (paymentRes.Payment || []).map((p) => ({
      Type: "Payment", ID: p.Id, DocNumber: "", Date: p.TxnDate,
      DueDate: "", CustomerName: customerName,
      TotalAmount: p.TotalAmt, Balance: "", UnappliedAmount: p.UnappliedAmt, Status: "",
    }));

    const all = [...invoices, ...payments].sort((a, b) => new Date(b.Date) - new Date(a.Date));
    if (all.length === 0) return res.status(404).json({ error: "No transactions found." });

    const headers = ["Type","ID","DocNumber","Date","DueDate","CustomerName","TotalAmount","Balance","UnappliedAmount","Status"];
    const csvRows = [
      headers.join(","),
      ...all.map((row) =>
        headers.map((h) => {
          const val = row[h] === null || row[h] === undefined ? "" : String(row[h]);
          return `"${val.replace(/"/g, '""')}"`;
        }).join(",")
      ),
    ];

    const csvContent = csvRows.join("\n");
    const safeFileName = customerName.replace(/[^a-z0-9]/gi, "_");
    const reportsDir = path.join(__dirname, "Reports");
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    const filePath = path.join(reportsDir, `${safeFileName}_transactions.csv`);
    fs.writeFileSync(filePath, csvContent);
    console.log(`📄 Report saved: ${filePath}`);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}_transactions.csv"`);
    res.send(csvContent);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Port 3000: localhost only — Openclaw & local tools, no auth needed ───────
app.listen(PORT, "127.0.0.1", () => {
  console.log(`🔒 Local server  → http://localhost:${PORT} (localhost only)`);
});

// ── Port 3001: public via Cloudflare tunnel — token required on sensitive routes
const PUBLIC_PORT = 3001;
app.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(`🌐 Public server → http://0.0.0.0:${PUBLIC_PORT} (via Cloudflare tunnel)`);
  console.log(`🔗 Tunnel URL    → ${INTUIT_REDIRECT_URI?.replace("/auth/intuit/callback", "")}`);
});
