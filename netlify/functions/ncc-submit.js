// NCC Opt-Out Automation
// Uses Playwright (headless browser) to submit the form at eservice.thencc.org.za
// 
// Install dependency: npm install playwright-chromium
// Add to netlify.toml: [functions] node_bundler = "esbuild"

const { chromium } = require('playwright-chromium');

const NCC_URL = 'https://www.eservice.thencc.org.za';
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
const OWNER_EMAIL = process.env.NOTIFY_EMAIL;

exports.handler = async (event, context) => {
    // Allow GET (from payfast-notify trigger) or POST
    const orderRef = event.queryStringParameters?.orderRef || 
                     JSON.parse(event.body || '{}').orderRef;

    if (!orderRef) {
        return { statusCode: 400, body: 'Missing orderRef' };
    }

    console.log(`Starting NCC submission for order: ${orderRef}`);

    // 1. Fetch order data from Google Sheets
    let order;
    try {
        const res = await fetch(`${GOOGLE_SCRIPT_URL}?action=getOrder&orderRef=${encodeURIComponent(orderRef)}`);
        const data = await res.json();
        if (data.result !== 'success') {
            throw new Error(data.error || 'Order not found');
        }
        order = data.order;
    } catch (err) {
        console.error('Failed to fetch order:', err.message);
        return { statusCode: 500, body: 'Failed to fetch order data' };
    }

    // Only process paid orders
    if (order.paymentStatus !== 'PAID') {
        console.log(`Order ${orderRef} not paid yet (status: ${order.paymentStatus})`);
        return { statusCode: 200, body: 'Order not paid, skipping' };
    }

    // 2. Download ID document
    let idDocBuffer = null;
    let idDocFileName = `ID_${orderRef}.jpg`;
    if (order.idDocUrl) {
        try {
            const docRes = await fetch(order.idDocUrl);
            idDocBuffer = Buffer.from(await docRes.arrayBuffer());
            // Determine file extension from URL
            if (order.idDocUrl.includes('.pdf')) idDocFileName = `ID_${orderRef}.pdf`;
        } catch (err) {
            console.error('Failed to download ID doc:', err.message);
        }
    }

    // 3. Submit to NCC using headless browser
    let browser;
    let nccSuccess = false;
    let errorMessage = '';

    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();

        // Step 1: Go to NCC site
        await page.goto(NCC_URL, { waitUntil: 'networkidle', timeout: 30000 });
        console.log('NCC site loaded');

        // Step 2: Accept terms - look for checkbox and/or continue button
        try {
            // Try to find and check terms checkbox
            const termsCheckbox = await page.$('input[type="checkbox"]');
            if (termsCheckbox) {
                await termsCheckbox.check();
                console.log('Terms checkbox checked');
            }

            // Click accept/continue/next button
            const acceptBtn = await page.$('button:has-text("Accept"), button:has-text("Continue"), button:has-text("Next"), input[type="submit"]');
            if (acceptBtn) {
                await acceptBtn.click();
                await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
                console.log('Terms accepted');
            }
        } catch (err) {
            console.log('Terms step:', err.message);
        }

        // Step 3: Enter ID number
        try {
            await page.waitForSelector('input[type="text"], input[name*="id"], input[name*="ID"]', { timeout: 10000 });
            const idField = await page.$('input[name*="id" i], input[placeholder*="id" i], input[type="text"]:first-of-type');
            if (idField) {
                await idField.fill(order.idNumber);
                console.log('ID number entered');
            }

            // Click next
            const nextBtn = await page.$('button:has-text("Next"), button:has-text("Continue"), input[type="submit"]');
            if (nextBtn) {
                await nextBtn.click();
                await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
            }
        } catch (err) {
            console.log('ID step:', err.message);
        }

        // Step 4: Fill in personal details form
        try {
            await page.waitForSelector('form', { timeout: 10000 });

            // Fill each field — using flexible selectors since NCC form structure may vary
            const fillField = async (selectors, value) => {
                for (const sel of selectors) {
                    try {
                        const el = await page.$(sel);
                        if (el) {
                            await el.fill(value);
                            return true;
                        }
                    } catch {}
                }
                return false;
            };

            const selectField = async (selectors, value) => {
                for (const sel of selectors) {
                    try {
                        const el = await page.$(sel);
                        if (el) {
                            await el.selectOption({ label: value });
                            return true;
                        }
                    } catch {
                        try {
                            const el = await page.$(sel);
                            if (el) {
                                await el.selectOption({ value: value });
                                return true;
                            }
                        } catch {}
                    }
                }
                return false;
            };

            // Name
            await fillField(['input[name*="first" i]', 'input[placeholder*="first" i]', 'input[id*="first" i]'], order.firstName);
            await fillField(['input[name*="surname" i]', 'input[name*="last" i]', 'input[placeholder*="surname" i]'], order.surname);

            // Gender
            await selectField(['select[name*="gender" i]', 'select[id*="gender" i]'], order.gender);

            // Marital status
            await selectField(['select[name*="marital" i]', 'select[id*="marital" i]'], order.maritalStatus);

            // Contact details
            await fillField(['input[name*="email" i]', 'input[type="email"]', 'input[placeholder*="email" i]'], order.email);
            await fillField(['input[name*="address" i]', 'textarea[name*="address" i]', 'input[placeholder*="address" i]'], order.address);
            await fillField(['input[name*="work" i][name*="phone" i]', 'input[name*="work" i][name*="tel" i]', 'input[placeholder*="work" i]'], order.workPhone || '');
            await fillField(['input[name*="cell" i]', 'input[name*="mobile" i]', 'input[name*="phone" i]', 'input[type="tel"]'], order.phone);

            console.log('Personal details filled');

            // Upload ID document
            if (idDocBuffer) {
                try {
                    const fileInput = await page.$('input[type="file"]');
                    if (fileInput) {
                        // Write temp file for upload
                        const fs = require('fs');
                        const os = require('os');
                        const path = require('path');
                        const tmpPath = path.join(os.tmpdir(), idDocFileName);
                        fs.writeFileSync(tmpPath, idDocBuffer);
                        await fileInput.setInputFiles(tmpPath);
                        console.log('ID document uploaded');
                        
                        // Set file name if there's a name field near the upload
                        const fileNameInput = await page.$('input[name*="filename" i], input[name*="docname" i]');
                        if (fileNameInput) {
                            await fileNameInput.fill(`ID_${order.firstName}_${order.surname}`);
                        }
                    }
                } catch (err) {
                    console.log('File upload step:', err.message);
                }
            }

        } catch (err) {
            console.log('Details form step:', err.message);
        }

        // Step 5: Submit
        try {
            const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Submit")');
            if (submitBtn) {
                await submitBtn.click();
                await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
                console.log('Form submitted');
                nccSuccess = true;
            }
        } catch (err) {
            console.log('Submit step:', err.message);
            errorMessage = err.message;
        }

        await browser.close();

    } catch (err) {
        console.error('Browser automation error:', err.message);
        errorMessage = err.message;
        if (browser) await browser.close().catch(() => {});
    }

    // 4. Update NCC status in Google Sheets
    if (GOOGLE_SCRIPT_URL) {
        try {
            await fetch(`${GOOGLE_SCRIPT_URL}?action=updateNcc&orderRef=${encodeURIComponent(orderRef)}&status=${nccSuccess ? 'SUBMITTED' : 'FAILED'}`);
        } catch (err) {
            console.error('Failed to update NCC status in Sheets:', err.message);
        }
    }

    // 5. Send status notification to owner
    if (GOOGLE_SCRIPT_URL && OWNER_EMAIL) {
        const statusMsg = nccSuccess
            ? `✅ NCC submission SUCCESSFUL for order ${orderRef} (${order.firstName} ${order.surname})`
            : `❌ NCC submission FAILED for order ${orderRef} - Error: ${errorMessage}. Manual submission required.`;

        try {
            await fetch(`${GOOGLE_SCRIPT_URL}?action=notifyOwner&orderRef=${orderRef}&email=&name=&phone=&amount=&notifyEmail=${encodeURIComponent(OWNER_EMAIL)}&message=${encodeURIComponent(statusMsg)}`);
        } catch {}
    }

    console.log(`NCC submission ${nccSuccess ? 'succeeded' : 'failed'} for order ${orderRef}`);
    return { statusCode: 200, body: nccSuccess ? 'Submitted' : 'Failed - check logs' };
};
