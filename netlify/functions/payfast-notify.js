const crypto = require('crypto');

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const params = new URLSearchParams(event.body);
    const pfData = {};
    for (const [key, value] of params) {
        pfData[key] = value;
    }

    console.log('PayFast ITN received:', pfData);

    // Credentials from environment variables (never hardcode these)
    const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID;
    const PAYFAST_PASSPHRASE = process.env.PAYFAST_PASSPHRASE;
    const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
    const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
    const NCC_TRIGGER_URL = process.env.NCC_TRIGGER_URL; // background function URL

    // Verify signature
    const signature = pfData.signature;
    const pfDataCopy = { ...pfData };
    delete pfDataCopy.signature;

    let paramString = '';
    for (const key of Object.keys(pfDataCopy)) {
        if (pfDataCopy[key] !== undefined && pfDataCopy[key] !== '') {
            paramString += `${key}=${encodeURIComponent(pfDataCopy[key].toString().trim()).replace(/%20/g, '+')}&`;
        }
    }
    paramString = paramString.slice(0, -1);
    if (PAYFAST_PASSPHRASE) {
        paramString += `&passphrase=${encodeURIComponent(PAYFAST_PASSPHRASE.trim()).replace(/%20/g, '+')}`;
    }

    const generatedSignature = crypto.createHash('md5').update(paramString).digest('hex');

    if (generatedSignature !== signature) {
        console.error('Signature mismatch!');
        return { statusCode: 400, body: 'Invalid signature' };
    }

    const orderRef = pfData.m_payment_id || pfData.custom_str1;
    const paymentStatus = pfData.payment_status;
    const amount = pfData.amount_gross;
    const email = pfData.email_address || pfData.custom_str2;
    const phone = pfData.custom_str3;
    const firstName = pfData.name_first;
    const lastName = pfData.name_last;

    console.log(`Payment ${paymentStatus} for order ${orderRef}`);

    if (paymentStatus === 'COMPLETE') {
        console.log(`✅ Payment COMPLETE for order ${orderRef}`);

        // 1. Update Google Sheets with payment status
        if (GOOGLE_SCRIPT_URL) {
            try {
                await fetch(`${GOOGLE_SCRIPT_URL}?action=updatePayment&orderRef=${encodeURIComponent(orderRef)}&status=PAID&amount=${amount}`);
                console.log('Google Sheets updated');
            } catch (err) {
                console.error('Failed to update Sheets:', err.message);
            }
        }

        // 2. Send email notification to owner via Gmail (Google Apps Script)
        if (GOOGLE_SCRIPT_URL && NOTIFY_EMAIL) {
            try {
                const notifyUrl = `${GOOGLE_SCRIPT_URL}?action=notifyOwner` +
                    `&orderRef=${encodeURIComponent(orderRef)}` +
                    `&email=${encodeURIComponent(email)}` +
                    `&name=${encodeURIComponent(firstName + ' ' + lastName)}` +
                    `&phone=${encodeURIComponent(phone || '')}` +
                    `&amount=${encodeURIComponent(amount)}` +
                    `&notifyEmail=${encodeURIComponent(NOTIFY_EMAIL)}`;
                await fetch(notifyUrl);
                console.log('Owner notified');
            } catch (err) {
                console.error('Failed to notify owner:', err.message);
            }
        }

        // 3. Trigger NCC automation (background function)
        if (NCC_TRIGGER_URL) {
            try {
                // Fire and forget — background function handles the NCC submission
                fetch(`${NCC_TRIGGER_URL}?orderRef=${encodeURIComponent(orderRef)}`).catch(() => {});
                console.log('NCC automation triggered');
            } catch (err) {
                console.error('Failed to trigger NCC automation:', err.message);
            }
        }
    }

    // Always return 200 to PayFast
    return { statusCode: 200, body: 'OK' };
};
