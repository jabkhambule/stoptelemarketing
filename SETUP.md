# StopTelemarketing.co.za - Setup Guide

## What Was Built

1. **`netlify/functions/payfast-notify.js`** — Updated to:
   - Verify PayFast payment signature ✅
   - Update Google Sheets with PAID status
   - Email you instantly when payment received
   - Trigger NCC automation

2. **`netlify/functions/ncc-submit.js`** — Headless browser automation that:
   - Fetches order data from Google Sheets
   - Opens eservice.thencc.org.za
   - Accepts terms, enters ID number, fills all details, uploads ID doc
   - Submits the form
   - Emails you success/failure status

3. **`google-apps-script/Code.gs`** — Full Google Apps Script update:
   - Saves orders to Sheets with all columns
   - Saves ID documents to Google Drive folder
   - Handles email verification codes
   - Notifies you of new paid orders
   - Tracks NCC submission status

---

## Step 1: Update Google Apps Script

1. Go to [script.google.com](https://script.google.com)
2. Open your existing project (or create new one linked to your Sheets)
3. **Replace ALL the code** with contents of `google-apps-script/Code.gs`
4. Save (Ctrl+S)
5. Click **Deploy → New Deployment**
   - Type: Web App
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Click Deploy → Copy the **Web App URL** (you'll need this)

---

## Step 2: Set Netlify Environment Variables

In your Netlify dashboard → Site settings → Environment variables, add:

| Variable | Value |
|----------|-------|
| `PAYFAST_MERCHANT_ID` | `31907641` |
| `PAYFAST_MERCHANT_KEY` | `omutyofcmqnez` |
| `PAYFAST_PASSPHRASE` | `2025WinnerJabu` |
| `GOOGLE_SCRIPT_URL` | *(paste the Web App URL from Step 1)* |
| `NOTIFY_EMAIL` | `stoptelemarketing@gmail.com` |
| `NCC_TRIGGER_URL` | `https://stoptelemarketing.co.za/.netlify/functions/ncc-submit` |

---

## Step 3: Remove Credentials from index.html

In `index.html`, find the hidden PayFast form and remove the passphrase line:
```html
<!-- DELETE this line: -->
<input type="hidden" name="passphrase" id="passphrase" value="2025WinnerJabu">
```
The passphrase is only needed server-side for signature verification — it should never be in your HTML.

---

## Step 4: Fix Email Typo

In both `success.html` and `cancel.html`, change:
```
stoptelemaketing@gmail.com  →  stoptelemarketing@gmail.com
```

---

## Step 5: Fix Sitemap

Remove the `#hash` URLs from `sitemap.xml` — keep only:
- `https://stoptelemarketing.co.za`
- `https://stoptelemarketing.co.za/success.html`
- `https://stoptelemarketing.co.za/cancel.html`

---

## Step 6: Deploy

Push everything to GitHub → Netlify auto-deploys.

Or drag the folder into Netlify's manual deploy.

---

## How It Works End-to-End

```
Customer pays
    ↓
PayFast sends POST to /.netlify/functions/payfast-notify
    ↓
Function verifies signature → updates Sheets → emails you → triggers ncc-submit
    ↓
ncc-submit opens headless Chrome → goes to eservice.thencc.org.za
    ↓
Fills form with customer data → uploads ID → submits
    ↓
Updates Sheets with NCC status → emails you result
```

---

## ⚠️ Important Notes

- The NCC automation uses **Playwright** (headless Chrome). This runs fine on Netlify but the function timeout must be long enough (NCC site can be slow). Netlify free tier has a 10-second limit — you may need to upgrade to **Netlify Pro** (or use a background function) for the NCC step.

- If NCC automation fails (site changes, timeout, etc.), you'll get an email saying "Manual submission required" with the order details. Nothing breaks — you just handle it manually that one time.

- First deployment: run a **test order** with a real R1 payment to verify the full flow works before running ads.
