require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();

const {
  INTUIT_CLIENT_ID,
  INTUIT_CLIENT_SECRET,
  INTUIT_REDIRECT_URI,
  PORT = 3000,
} = process.env;

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

// demo in-memory store (replace with DB/secure store)
let oauthStore = {
  state: null,
  access_token: null,
  refresh_token: null,
  realmId: null,
};

// Step A: redirect user to Intuit consent screen
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

// Step B: callback from Intuit with code + realmId
app.get("/auth/intuit/callback", async (req, res) => {
  try {
    const { code, state, realmId } = req.query;

    if (!code) return res.status(400).send("Missing code");
    if (state !== oauthStore.state) return res.status(400).send("Invalid state");

    // Exchange authorization code for tokens
    const basic = Buffer.from(
      `${INTUIT_CLIENT_ID}:${INTUIT_CLIENT_SECRET}`
    ).toString("base64");

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

    res.json({
      message: "OAuth success",
      realmId,
      expires_in: tokenResp.data.expires_in,
      x_refresh_token_expires_in: tokenResp.data.x_refresh_token_expires_in,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("OAuth callback failed");
  }
});

// Step C: refresh access token
app.get("/auth/intuit/refresh", async (req, res) => {
  try {
    if (!oauthStore.refresh_token) return res.status(400).send("No refresh token");

    const basic = Buffer.from(
      `${INTUIT_CLIENT_ID}:${INTUIT_CLIENT_SECRET}`
    ).toString("base64");

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
    oauthStore.refresh_token = tokenResp.data.refresh_token; // rotate
    res.json({ message: "Token refreshed" });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Refresh failed");
  }
});

// Helper: make an authenticated QuickBooks API query
async function qboQuery(query) {
  if (!oauthStore.access_token || !oauthStore.realmId) {
    throw new Error("Not authenticated. Visit /auth/intuit first.");
  }
  const baseUrl = `https://sandbox-quickbooks.api.intuit.com/v3/company/${oauthStore.realmId}`;
  const response = await axios.get(`${baseUrl}/query`, {
    params: { query, minorversion: 65 },
    headers: {
      Authorization: `Bearer ${oauthStore.access_token}`,
      Accept: "application/json",
    },
  });
  return response.data.QueryResponse;
}

// GET /customers — retrieve all customers with name and notes
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

// GET /transactions — retrieve all invoices, payments, expenses and bills
app.get("/transactions", async (req, res) => {
  try {
    const [invoiceRes, paymentRes, purchaseRes, billRes] = await Promise.all([
      qboQuery("SELECT * FROM Invoice MAXRESULTS 1000"),
      qboQuery("SELECT * FROM Payment MAXRESULTS 1000"),
      qboQuery("SELECT * FROM Purchase MAXRESULTS 1000"),
      qboQuery("SELECT * FROM Bill MAXRESULTS 1000"),
    ]);

    const invoices = (invoiceRes.Invoice || []).map((i) => ({
      type: "Invoice",
      id: i.Id,
      docNumber: i.DocNumber,
      date: i.TxnDate,
      dueDate: i.DueDate,
      customerName: i.CustomerRef?.name,
      totalAmount: i.TotalAmt,
      balance: i.Balance,
      status: i.EmailStatus,
    }));

    const payments = (paymentRes.Payment || []).map((p) => ({
      type: "Payment",
      id: p.Id,
      date: p.TxnDate,
      customerName: p.CustomerRef?.name,
      totalAmount: p.TotalAmt,
      unappliedAmount: p.UnappliedAmt,
    }));

    const purchases = (purchaseRes.Purchase || []).map((p) => ({
      type: "Purchase/Expense",
      id: p.Id,
      date: p.TxnDate,
      paymentType: p.PaymentType,
      accountName: p.AccountRef?.name,
      totalAmount: p.TotalAmt,
      memo: p.PrivateNote || null,
    }));

    const bills = (billRes.Bill || []).map((b) => ({
      type: "Bill",
      id: b.Id,
      date: b.TxnDate,
      dueDate: b.DueDate,
      vendorName: b.VendorRef?.name,
      totalAmount: b.TotalAmt,
      balance: b.Balance,
    }));

    const all = [...invoices, ...payments, ...purchases, ...bills].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    res.json({
      count: all.length,
      summary: {
        invoices: invoices.length,
        payments: payments.length,
        purchases: purchases.length,
        bills: bills.length,
      },
      transactions: all,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /customers/:id/transactions — all transactions for a specific customer
app.get("/customers/:id/transactions", async (req, res) => {
  try {
    const { id } = req.params;
    const [invoiceRes, paymentRes] = await Promise.all([
      qboQuery(`SELECT * FROM Invoice WHERE CustomerRef = '${id}' MAXRESULTS 1000`),
      qboQuery(`SELECT * FROM Payment WHERE CustomerRef = '${id}' MAXRESULTS 1000`),
    ]);

    const invoices = (invoiceRes.Invoice || []).map((i) => ({
      type: "Invoice",
      id: i.Id,
      docNumber: i.DocNumber,
      date: i.TxnDate,
      dueDate: i.DueDate,
      totalAmount: i.TotalAmt,
      balance: i.Balance,
    }));

    const payments = (paymentRes.Payment || []).map((p) => ({
      type: "Payment",
      id: p.Id,
      date: p.TxnDate,
      totalAmount: p.TotalAmt,
      unappliedAmount: p.UnappliedAmt,
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

// GET /customers/:id/transactions/export — download transactions as CSV
app.get("/customers/:id/transactions/export", async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch customer name
    const custRes = await qboQuery(`SELECT * FROM Customer WHERE Id = '${id}'`);
    const customer = (custRes.Customer || [])[0];
    const customerName = customer ? (customer.DisplayName || customer.FullyQualifiedName) : id;

    const [invoiceRes, paymentRes] = await Promise.all([
      qboQuery(`SELECT * FROM Invoice WHERE CustomerRef = '${id}' MAXRESULTS 1000`),
      qboQuery(`SELECT * FROM Payment WHERE CustomerRef = '${id}' MAXRESULTS 1000`),
    ]);

    const invoices = (invoiceRes.Invoice || []).map((i) => ({
      Type: "Invoice",
      ID: i.Id,
      DocNumber: i.DocNumber || "",
      Date: i.TxnDate,
      DueDate: i.DueDate || "",
      CustomerName: customerName,
      TotalAmount: i.TotalAmt,
      Balance: i.Balance,
      UnappliedAmount: "",
      Status: i.EmailStatus || "",
    }));

    const payments = (paymentRes.Payment || []).map((p) => ({
      Type: "Payment",
      ID: p.Id,
      DocNumber: "",
      Date: p.TxnDate,
      DueDate: "",
      CustomerName: customerName,
      TotalAmount: p.TotalAmt,
      Balance: "",
      UnappliedAmount: p.UnappliedAmt,
      Status: "",
    }));

    const all = [...invoices, ...payments].sort(
      (a, b) => new Date(b.Date) - new Date(a.Date)
    );

    if (all.length === 0) {
      return res.status(404).json({ error: "No transactions found for this customer." });
    }

    // Build CSV
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

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}_transactions.csv"`);
    res.send(csvContent);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () =>
  console.log(`Server running at http://localhost:${PORT}`)
);