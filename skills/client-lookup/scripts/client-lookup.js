#!/usr/bin/env node
// client-lookup.js — QuickBooks client lookup + CSV report generator
// Usage: node client-lookup.js "Customer Name"

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const QB_BASE = 'http://localhost:3000';
const REPORTS_DIR = process.env.QB_REPORTS_DIR || path.join(os.homedir(), 'Quickbooks', 'Reports');
const LOG_SCRIPT = path.join(__dirname, 'log-action.js');

const searchName = process.argv[2];
if (!searchName) {
  console.error('Usage: node client-lookup.js "Customer Name"');
  process.exit(1);
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON: ' + data.slice(0, 100))); }
      });
    }).on('error', reject);
  });
}

function safeFilename(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '_');
}

function escapeCSV(val) {
  if (val === null || val === undefined) return '""';
  return '"' + String(val).replace(/"/g, '""') + '"';
}

async function run() {
  // 1. Check auth
  const status = await get(`${QB_BASE}/auth/status`);
  if (!status.authenticated) {
    console.error('NOT_AUTHENTICATED: Visit http://localhost:3000/auth/intuit to connect QuickBooks.');
    process.exit(2);
  }

  // 2. Search customers
  const custData = await get(`${QB_BASE}/customers`);
  if (custData.error) {
    console.error('ERROR fetching customers:', custData.error);
    process.exit(3);
  }

  const matches = custData.customers.filter(c =>
    (c.name || '').toLowerCase().includes(searchName.toLowerCase()) ||
    (c.companyName || '').toLowerCase().includes(searchName.toLowerCase())
  );

  if (matches.length === 0) {
    console.log('NO_MATCH: No customer found matching: ' + searchName);
    process.exit(4);
  }

  // Use best match (exact preferred)
  const match = matches.find(c =>
    (c.name || '').toLowerCase() === searchName.toLowerCase()
  ) || matches[0];

  // 3. Fetch transactions
  const txData = await get(`${QB_BASE}/customers/${match.id}/transactions`);
  const transactions = txData.transactions || [];

  // 4. Write CSV
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const safeName = safeFilename(match.name || match.id);
  const reportPath = path.join(REPORTS_DIR, `${safeName}_report.csv`);

  const lines = [
    `Customer Name,${escapeCSV(match.name)}`,
    `Account Balance,${escapeCSV(match.balance)}`,
    `Notes,${escapeCSV(match.notes || '')}`,
    '',
    '"Date","Type","No.","Amount","Balance","Status","PostingType","DueDate","UnappliedAmount"',
    ...transactions.map(tx =>
      [tx.date, tx.type, tx.docNumber || '',
       tx.totalAmount, tx.balance || '', tx.status || '',
       tx.postingType || '', tx.dueDate || '', tx.unappliedAmount || '']
      .map(escapeCSV).join(',')
    )
  ];

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  // 5. Output summary as JSON for the agent to use
  const unpaidInvoices = transactions.filter(t => t.type === 'Invoice' && t.balance > 0);
  const lastDate = transactions.map(t => t.date).filter(Boolean).sort().reverse()[0] || 'N/A';
  const balanceNum = parseFloat(match.balance) || 0;

  const result = {
    customer: match.name,
    customer_id: match.id,
    notes: match.notes || '',
    balance: match.balance,
    balance_flag: balanceNum < 0 ? 'CREDIT' : balanceNum > 0 ? 'BALANCE_DUE' : 'ZERO',
    transaction_count: transactions.length,
    unpaid_invoices: unpaidInvoices.length,
    last_activity: lastDate,
    report_path: reportPath,
    multiple_matches: matches.length > 1 ? matches.map(m => m.name) : null
  };

  console.log(JSON.stringify(result));
  process.exit(0);
}

run().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(99);
});
