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
| `GET /customers` | List all customers |
| `GET /transactions` | List all transactions |
| `GET /customers/:id/transactions` | Transactions for a specific customer |
| `GET /customers/:id/transactions/export` | Download as CSV |

## Environment

- **Sandbox:** uses `https://sandbox-quickbooks.api.intuit.com`
- **Production:** uses `https://quickbooks.api.intuit.com`
