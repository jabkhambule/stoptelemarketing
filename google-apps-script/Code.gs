// ============================================================
// StopTelemarketing.co.za - Google Apps Script
// Deploy as: Web App → Execute as Me → Anyone can access
// ============================================================

const SHEET_NAME = 'Orders';
const OWNER_EMAIL = 'stoptelemarketing@gmail.com'; // Fixed typo from stoptelemaketing

// Column positions (1-indexed)
const COL = {
    TIMESTAMP:      1,
    ORDER_REF:      2,
    FIRST_NAME:     3,
    SURNAME:        4,
    ID_TYPE:        5,
    ID_NUMBER:      6,
    GENDER:         7,
    MARITAL_STATUS: 8,
    EMAIL:          9,
    PHONE:          10,
    WORK_PHONE:     11,
    ADDRESS:        12,
    ID_DOC_URL:     13,
    PAYMENT_STATUS: 14,
    PAYMENT_AMOUNT: 15,
    NCC_STATUS:     16,
    NCC_SUBMITTED:  17,
};

function doGet(e) {
    const action = e.parameter.action;

    if (action === 'sendCode') {
        return sendVerificationCode(e);
    } else if (action === 'verifyCode') {
        return verifyCode(e);
    } else if (action === 'updatePayment') {
        return updatePaymentStatus(e);
    } else if (action === 'notifyOwner') {
        return notifyOwner(e);
    } else if (action === 'getOrder') {
        return getOrder(e);
    }

    return jsonResponse({ result: 'error', error: 'Unknown action' });
}

function doPost(e) {
    try {
        const data = e.parameter;
        return saveOrder(data);
    } catch (err) {
        return jsonResponse({ result: 'error', error: err.message });
    }
}

// ── Save new order from form ────────────────────────────────
function saveOrder(data) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);

    if (!sheet) {
        sheet = ss.insertSheet(SHEET_NAME);
        // Write headers
        const headers = [
            'Timestamp', 'Order Ref', 'First Name', 'Surname',
            'ID Type', 'ID Number', 'Gender', 'Marital Status',
            'Email', 'Phone', 'Work Phone', 'Address',
            'ID Doc URL', 'Payment Status', 'Amount', 'NCC Status', 'NCC Submitted'
        ];
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
        sheet.setFrozenRows(1);
    }

    // Save ID document to Google Drive
    let idDocUrl = '';
    if (data.idDocumentBase64) {
        try {
            const folder = getDriveFolder();
            const mimeType = data.idDocumentType || 'image/jpeg';
            const extension = mimeType.includes('pdf') ? '.pdf' : '.jpg';
            const fileName = `ID_${data.orderRef}${extension}`;
            const decoded = Utilities.base64Decode(data.idDocumentBase64);
            const blob = Utilities.newBlob(decoded, mimeType, fileName);
            const file = folder.createFile(blob);
            file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
            idDocUrl = file.getUrl();
        } catch (err) {
            Logger.log('Error saving ID doc: ' + err.message);
        }
    }

    // Append row
    sheet.appendRow([
        new Date().toISOString(),
        data.orderRef || '',
        data.firstName || '',
        data.surname || '',
        data.idType || '',
        data.idNumber || '',
        data.gender || '',
        data.maritalStatus || '',
        data.email || '',
        data.phone || '',
        data.workPhone || '',
        data.address || '',
        idDocUrl,
        'PENDING_PAYMENT',
        '',
        'PENDING',
        ''
    ]);

    return jsonResponse({ result: 'success', orderRef: data.orderRef });
}

// ── Update payment status ───────────────────────────────────
function updatePaymentStatus(e) {
    const orderRef = e.parameter.orderRef;
    const status = e.parameter.status;
    const amount = e.parameter.amount;

    const sheet = getSheet();
    if (!sheet) return jsonResponse({ result: 'error', error: 'Sheet not found' });

    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
        if (data[i][COL.ORDER_REF - 1] === orderRef) {
            sheet.getRange(i + 1, COL.PAYMENT_STATUS).setValue(status);
            if (amount) sheet.getRange(i + 1, COL.PAYMENT_AMOUNT).setValue(amount);
            return jsonResponse({ result: 'success' });
        }
    }

    return jsonResponse({ result: 'error', error: 'Order not found' });
}

// ── Notify owner of new paid order ─────────────────────────
function notifyOwner(e) {
    const orderRef = e.parameter.orderRef;
    const email = e.parameter.email;
    const name = e.parameter.name;
    const phone = e.parameter.phone;
    const amount = e.parameter.amount;
    const notifyEmail = e.parameter.notifyEmail || OWNER_EMAIL;

    const subject = `✅ New Order - ${orderRef} - R${amount}`;
    const body = `
New paid order received!

Order Ref: ${orderRef}
Customer: ${name}
Email: ${email}
Phone: ${phone}
Amount: R${amount}

Log into Google Sheets to see full details and ID document.
NCC submission is queued for automation.

---
StopTelemarketing.co.za
    `.trim();

    try {
        GmailApp.sendEmail(notifyEmail, subject, body);
        return jsonResponse({ result: 'success' });
    } catch (err) {
        return jsonResponse({ result: 'error', error: err.message });
    }
}

// ── Get order data (for NCC automation) ────────────────────
function getOrder(e) {
    const orderRef = e.parameter.orderRef;
    const sheet = getSheet();
    if (!sheet) return jsonResponse({ result: 'error', error: 'Sheet not found' });

    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
        if (data[i][COL.ORDER_REF - 1] === orderRef) {
            return jsonResponse({
                result: 'success',
                order: {
                    orderRef:      data[i][COL.ORDER_REF - 1],
                    firstName:     data[i][COL.FIRST_NAME - 1],
                    surname:       data[i][COL.SURNAME - 1],
                    idType:        data[i][COL.ID_TYPE - 1],
                    idNumber:      data[i][COL.ID_NUMBER - 1],
                    gender:        data[i][COL.GENDER - 1],
                    maritalStatus: data[i][COL.MARITAL_STATUS - 1],
                    email:         data[i][COL.EMAIL - 1],
                    phone:         data[i][COL.PHONE - 1],
                    workPhone:     data[i][COL.WORK_PHONE - 1],
                    address:       data[i][COL.ADDRESS - 1],
                    idDocUrl:      data[i][COL.ID_DOC_URL - 1],
                    paymentStatus: data[i][COL.PAYMENT_STATUS - 1],
                }
            });
        }
    }

    return jsonResponse({ result: 'error', error: 'Order not found' });
}

// ── Update NCC submission status ────────────────────────────
function updateNccStatus(orderRef, status) {
    const sheet = getSheet();
    if (!sheet) return;

    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
        if (data[i][COL.ORDER_REF - 1] === orderRef) {
            sheet.getRange(i + 1, COL.NCC_STATUS).setValue(status);
            sheet.getRange(i + 1, COL.NCC_SUBMITTED).setValue(new Date().toISOString());
            return;
        }
    }
}

// ── Email verification ──────────────────────────────────────
function sendVerificationCode(e) {
    const email = e.parameter.email;
    if (!email) return jsonResponse({ result: 'error', error: 'Email required' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = Date.now() + 10 * 60 * 1000; // 10 minutes

    const props = PropertiesService.getScriptProperties();
    props.setProperty(`code_${email}`, JSON.stringify({ code, expiry }));

    try {
        GmailApp.sendEmail(email, 'Your verification code - StopTelemarketing.co.za',
            `Your verification code is: ${code}\n\nThis code expires in 10 minutes.\n\n— StopTelemarketing.co.za`
        );
        return jsonResponse({ result: 'success' });
    } catch (err) {
        return jsonResponse({ result: 'error', error: 'Failed to send email: ' + err.message });
    }
}

function verifyCode(e) {
    const email = e.parameter.email;
    const code = e.parameter.code;

    const props = PropertiesService.getScriptProperties();
    const stored = props.getProperty(`code_${email}`);

    if (!stored) return jsonResponse({ result: 'error', error: 'No code found. Please request a new one.' });

    const { code: storedCode, expiry } = JSON.parse(stored);

    if (Date.now() > expiry) {
        props.deleteProperty(`code_${email}`);
        return jsonResponse({ result: 'error', error: 'Code expired. Please request a new one.' });
    }

    if (code !== storedCode) {
        return jsonResponse({ result: 'error', error: 'Invalid code.' });
    }

    props.deleteProperty(`code_${email}`);
    return jsonResponse({ result: 'success' });
}

// ── Helpers ─────────────────────────────────────────────────
function getSheet() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    return ss.getSheetByName(SHEET_NAME);
}

function getDriveFolder() {
    const folderName = 'StopTelemarketing_Orders';
    const folders = DriveApp.getFoldersByName(folderName);
    if (folders.hasNext()) return folders.next();
    return DriveApp.createFolder(folderName);
}

function jsonResponse(data) {
    return ContentService
        .createTextOutput(JSON.stringify(data))
        .setMimeType(ContentService.MimeType.JSON);
}
