// ============================================================
//  StopTelemarketing — Google Apps Script Backend
//  Version: 2.0 (auth-gated flow)
// ============================================================
//
//  SETUP STEPS:
//  1. Open your Google Sheet
//  2. Extensions → Apps Script → paste this entire file
//  3. Run initSheets() once (creates the required tabs)
//  4. Set DRIVE_FOLDER_ID below to a Google Drive folder ID
//     (create a folder, right-click → Get link → copy the ID from the URL)
//  5. Deploy → New deployment → Web App
//     Execute as: Me | Who has access: Anyone
//  6. Copy the deployment URL into your index.html GOOGLE_SCRIPT_URL
//
// ============================================================

// ── CONFIG ────────────────────────────────────────────────────────────────────

var DRIVE_FOLDER_ID = '';                          // Paste your Drive folder ID here
var SITE_URL        = 'https://stoptelemarketing.co.za';
var FROM_NAME       = 'StopTelemarketing';
var SUPPORT_EMAIL   = 'support@stoptelemarketing.co.za'; // shown in emails
var SESSION_TTL_MS  = 7  * 24 * 60 * 60 * 1000;  // 7 days
var VERIFY_TTL_MS   = 24 * 60 * 60 * 1000;        // 24 hours

// ── SHEET NAMES ───────────────────────────────────────────────────────────────

var SHEET_ACCOUNTS    = 'Accounts';
var SHEET_SESSIONS    = 'Sessions';
var SHEET_SUBMISSIONS = 'Submissions';

// ── ACCOUNTS columns (0-indexed) ──────────────────────────────────────────────
var AC = { EMAIL:0, PW_HASH:1, FIRST:2, LAST:3, VERIFIED:4, VFY_TOKEN:5, VFY_EXPIRY:6, CREATED:7 };

// ── SESSIONS columns ──────────────────────────────────────────────────────────
var SC = { TOKEN:0, EMAIL:1, FIRST:2, EXPIRES:3, CREATED:4 };

// ── SUBMISSIONS columns ───────────────────────────────────────────────────────
var SUB = { ORDER_REF:0, TIMESTAMP:1, EMAIL:2, FIRST:3, SURNAME:4, ID_TYPE:5,
            ID_NUM:6, GENDER:7, MARITAL:8, PHONE:9, WORK_PHONE:10,
            ADDRESS:11, DOC_URL:12, STATUS:13, SESSION_TOKEN:14 };

// ============================================================
//  INITIALISE SHEETS  (run once manually)
// ============================================================

function initSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  function ensureSheet(name, headers) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length)
           .setFontWeight('bold')
           .setBackground('#1e293b')
           .setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    }
    return sheet;
  }

  ensureSheet(SHEET_ACCOUNTS, [
    'Email','PasswordHash','FirstName','LastName',
    'Verified','VerifyToken','VerifyTokenExpiry','CreatedAt'
  ]);
  ensureSheet(SHEET_SESSIONS, [
    'Token','Email','FirstName','ExpiresAt','CreatedAt'
  ]);
  ensureSheet(SHEET_SUBMISSIONS, [
    'OrderRef','Timestamp','Email','FirstName','Surname',
    'IDType','IDNumber','Gender','MaritalStatus',
    'Phone','WorkPhone','Address','IDDocURL','Status','SessionToken'
  ]);

  Logger.log('Sheets initialised successfully.');
}

// ============================================================
//  ROUTING
// ============================================================

function doGet(e) {
  var action = (e.parameter && e.parameter.action) || '';
  var result;
  try {
    switch (action) {
      case 'register':            result = handleRegister(e.parameter);           break;
      case 'login':               result = handleLogin(e.parameter);              break;
      case 'verifyEmail':         result = handleVerifyEmail(e.parameter);        break;
      case 'checkSession':        result = handleCheckSession(e.parameter);       break;
      case 'resendVerification':  result = handleResend(e.parameter);             break;
      default:                    result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    Logger.log('doGet error [' + action + ']: ' + err.message);
    result = { error: 'Server error. Please try again.' };
  }
  return jsonOut(result);
}

function doPost(e) {
  var params;
  try {
    // Try JSON body first, fall back to form params
    if (e.postData && e.postData.contents) {
      try { params = JSON.parse(e.postData.contents); } catch (_) { params = e.parameter; }
    } else {
      params = e.parameter || {};
    }
  } catch (_) { params = {}; }

  var result;
  try {
    result = handleSubmitDetails(params);
  } catch (err) {
    Logger.log('doPost error: ' + err.message);
    result = { error: 'Server error. Please try again.' };
  }
  return jsonOut(result);
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
//  HANDLER: register
//  params: email, pwHash, firstName, lastName
// ============================================================

function handleRegister(p) {
  var email     = normaliseEmail(p.email);
  var pwHash    = (p.pwHash   || '').trim();
  var firstName = (p.firstName || '').trim();
  var lastName  = (p.lastName  || '').trim();

  if (!email || !pwHash || !firstName || !lastName) {
    return { error: 'Missing required fields.' };
  }
  if (!isValidEmail(email)) {
    return { error: 'Invalid email address.' };
  }

  var sheet = getSheet(SHEET_ACCOUNTS);
  var rows  = sheet.getDataRange().getValues();

  // Check for existing account
  for (var i = 1; i < rows.length; i++) {
    if (normaliseEmail(rows[i][AC.EMAIL]) === email) {
      return { error: 'An account with this email already exists. Please sign in.' };
    }
  }

  // Generate verification token
  var vfyToken  = Utilities.getUuid();
  var vfyExpiry = new Date(Date.now() + VERIFY_TTL_MS).toISOString();

  sheet.appendRow([
    email, pwHash, firstName, lastName,
    false, vfyToken, vfyExpiry, new Date().toISOString()
  ]);

  // Send verification email
  sendVerificationEmail(email, firstName, vfyToken);

  return { result: 'success' };
}

// ============================================================
//  HANDLER: login
//  params: email, pwHash
// ============================================================

function handleLogin(p) {
  var email  = normaliseEmail(p.email);
  var pwHash = (p.pwHash || '').trim();

  if (!email || !pwHash) {
    return { error: 'Missing email or password.' };
  }

  var sheet = getSheet(SHEET_ACCOUNTS);
  var rows  = sheet.getDataRange().getValues();

  for (var i = 1; i < rows.length; i++) {
    if (normaliseEmail(rows[i][AC.EMAIL]) === email) {
      var row = rows[i];

      // Check password hash
      if (row[AC.PW_HASH] !== pwHash) {
        return { error: 'Incorrect email or password.' };
      }

      // Check email verified
      if (!row[AC.VERIFIED]) {
        return { result: 'success', verified: false };
      }

      // Create session
      var token = createSession(email, row[AC.FIRST]);
      return {
        result:    'success',
        verified:  true,
        token:     token,
        firstName: row[AC.FIRST]
      };
    }
  }

  return { error: 'No account found with that email address.' };
}

// ============================================================
//  HANDLER: verifyEmail
//  params: token
// ============================================================

function handleVerifyEmail(p) {
  var token = (p.token || '').trim();
  if (!token) return { error: 'Missing verification token.' };

  var sheet = getSheet(SHEET_ACCOUNTS);
  var rows  = sheet.getDataRange().getValues();

  for (var i = 1; i < rows.length; i++) {
    if (rows[i][AC.VFY_TOKEN] === token) {
      // Check expiry
      var expiry = new Date(rows[i][AC.VFY_EXPIRY]);
      if (Date.now() > expiry.getTime()) {
        return { error: 'Verification link has expired. Please request a new one.' };
      }

      // Mark as verified, clear token
      var rowNum = i + 1; // 1-indexed
      sheet.getRange(rowNum, AC.VERIFIED + 1).setValue(true);
      sheet.getRange(rowNum, AC.VFY_TOKEN + 1).setValue('');
      sheet.getRange(rowNum, AC.VFY_EXPIRY + 1).setValue('');

      var email = rows[i][AC.EMAIL];
      sendWelcomeEmail(email, rows[i][AC.FIRST]);

      return { result: 'success', email: email };
    }
  }

  return { error: 'Invalid verification token. It may have already been used.' };
}

// ============================================================
//  HANDLER: checkSession
//  params: token
// ============================================================

function handleCheckSession(p) {
  var token = (p.token || '').trim();
  if (!token) return { valid: false };

  var sheet = getSheet(SHEET_SESSIONS);
  var rows  = sheet.getDataRange().getValues();

  for (var i = 1; i < rows.length; i++) {
    if (rows[i][SC.TOKEN] === token) {
      var expires = new Date(rows[i][SC.EXPIRES]);
      if (Date.now() > expires.getTime()) {
        // Expired — clean up row
        sheet.deleteRow(i + 1);
        return { valid: false };
      }
      return {
        valid:     true,
        email:     rows[i][SC.EMAIL],
        firstName: rows[i][SC.FIRST]
      };
    }
  }

  return { valid: false };
}

// ============================================================
//  HANDLER: resendVerification
//  params: email
// ============================================================

function handleResend(p) {
  var email = normaliseEmail(p.email);
  if (!email) return { error: 'Missing email.' };

  var sheet = getSheet(SHEET_ACCOUNTS);
  var rows  = sheet.getDataRange().getValues();

  for (var i = 1; i < rows.length; i++) {
    if (normaliseEmail(rows[i][AC.EMAIL]) === email) {
      if (rows[i][AC.VERIFIED]) {
        return { error: 'This account is already verified. Please sign in.' };
      }

      // Issue a fresh token
      var newToken  = Utilities.getUuid();
      var newExpiry = new Date(Date.now() + VERIFY_TTL_MS).toISOString();
      var rowNum    = i + 1;
      sheet.getRange(rowNum, AC.VFY_TOKEN  + 1).setValue(newToken);
      sheet.getRange(rowNum, AC.VFY_EXPIRY + 1).setValue(newExpiry);

      sendVerificationEmail(email, rows[i][AC.FIRST], newToken);
      return { result: 'success' };
    }
  }

  return { error: 'No account found with that email address.' };
}

// ============================================================
//  HANDLER: submitDetails (POST)
//  Receives: sessionToken + all personal fields + idDocumentBase64
// ============================================================

function handleSubmitDetails(p) {
  var sessionToken = (p.sessionToken || '').trim();

  // Validate session
  if (sessionToken) {
    var sessionCheck = handleCheckSession({ token: sessionToken });
    if (!sessionCheck.valid) {
      return { error: 'Session expired. Please sign in again.' };
    }
  }

  var orderRef  = p.orderRef  || ('OPT' + Date.now());
  var email     = p.email     || (sessionToken ? sessionCheck.email : '');
  var firstName = p.firstName || '';
  var surname   = p.surname   || '';

  // Upload ID document to Drive (if provided)
  var docUrl = '';
  if (p.idDocumentBase64 && DRIVE_FOLDER_ID) {
    try {
      var folder   = DriveApp.getFolderById(DRIVE_FOLDER_ID);
      var mimeType = p.idDocumentType || 'image/jpeg';
      var ext      = mimeType === 'application/pdf' ? '.pdf' : '.jpg';
      var fileName = orderRef + '_' + (email.split('@')[0]) + ext;
      var blob     = Utilities.newBlob(
        Utilities.base64Decode(p.idDocumentBase64),
        mimeType,
        fileName
      );
      var file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      docUrl = file.getUrl();
    } catch (e) {
      Logger.log('Drive upload error: ' + e.message);
      docUrl = 'UPLOAD_FAILED';
    }
  } else if (p.idDocumentBase64) {
    // No folder configured — log a warning
    Logger.log('Warning: DRIVE_FOLDER_ID not set. ID document not saved to Drive.');
    docUrl = 'NO_DRIVE_FOLDER_CONFIGURED';
  }

  // Save to Submissions sheet
  var sheet = getSheet(SHEET_SUBMISSIONS);
  sheet.appendRow([
    orderRef,
    p.timestamp || new Date().toISOString(),
    email,
    firstName,
    surname,
    p.idType        || '',
    p.idNumber      || '',
    p.gender        || '',
    p.maritalStatus || '',
    p.phone         || '',
    p.workPhone     || '',
    p.address       || '',
    docUrl,
    'pending_payment',
    sessionToken
  ]);

  Logger.log('Submission saved: ' + orderRef + ' for ' + email);
  return { result: 'success', orderRef: orderRef };
}

// ============================================================
//  SESSION HELPERS
// ============================================================

function createSession(email, firstName) {
  var token   = Utilities.getUuid();
  var expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  getSheet(SHEET_SESSIONS).appendRow([
    token, email, firstName, expires, new Date().toISOString()
  ]);
  // Clean up expired sessions periodically
  cleanExpiredSessions();
  return token;
}

function cleanExpiredSessions() {
  var sheet = getSheet(SHEET_SESSIONS);
  var rows  = sheet.getDataRange().getValues();
  var now   = Date.now();
  // Walk backwards to avoid index shift when deleting
  for (var i = rows.length - 1; i >= 1; i--) {
    var exp = new Date(rows[i][SC.EXPIRES]);
    if (now > exp.getTime()) {
      sheet.deleteRow(i + 1);
    }
  }
}

// ============================================================
//  EMAIL HELPERS
// ============================================================

function sendVerificationEmail(email, firstName, token) {
  var verifyUrl = SITE_URL + '/?verify=' + token;

  var subject = 'Verify your StopTelemarketing account';

  var body = 'Hi ' + firstName + ',\n\n' +
    'Thank you for registering with StopTelemarketing.\n\n' +
    'Click the link below to verify your email address:\n\n' +
    verifyUrl + '\n\n' +
    'This link expires in 24 hours.\n\n' +
    'If you did not create this account, please ignore this email.\n\n' +
    'Regards,\nThe StopTelemarketing Team\n' + SITE_URL;

  var htmlBody =
    '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">' +
    '<div style="text-align:center;margin-bottom:32px;">' +
    '<div style="display:inline-flex;align-items:center;gap:10px;">' +
    '<div style="width:36px;height:36px;background:#16a34a;border-radius:50%;display:flex;align-items:center;justify-content:center;">' +
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' +
    '</div>' +
    '<span style="font-size:18px;font-weight:800;color:#0f172a;text-transform:uppercase;letter-spacing:0.5px;">StopTelemarketing</span>' +
    '</div></div>' +
    '<h2 style="font-size:24px;font-weight:800;color:#0f172a;margin-bottom:12px;">Verify your email</h2>' +
    '<p style="font-size:15px;color:#475569;line-height:1.7;margin-bottom:24px;">Hi ' + firstName + ', thanks for signing up! Click the button below to verify your email address and activate your account.</p>' +
    '<div style="text-align:center;margin-bottom:32px;">' +
    '<a href="' + verifyUrl + '" style="display:inline-block;background:#16a34a;color:#fff;font-size:16px;font-weight:700;padding:16px 36px;border-radius:8px;text-decoration:none;letter-spacing:0.3px;">Verify my email</a>' +
    '</div>' +
    '<p style="font-size:13px;color:#94a3b8;line-height:1.6;">Or copy this link into your browser:<br>' +
    '<span style="color:#475569;word-break:break-all;">' + verifyUrl + '</span></p>' +
    '<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">' +
    '<p style="font-size:12px;color:#94a3b8;">This link expires in 24 hours. If you did not create this account, please ignore this email.</p>' +
    '</div>';

  MailApp.sendEmail({
    to:       email,
    subject:  subject,
    body:     body,
    htmlBody: htmlBody,
    name:     FROM_NAME
  });
}

function sendWelcomeEmail(email, firstName) {
  var subject = 'Email verified — complete your opt-out registration';

  var loginUrl = SITE_URL + '/#order';

  var body = 'Hi ' + firstName + ',\n\n' +
    'Your email address has been verified.\n\n' +
    'Sign in to complete your opt-out registration:\n' +
    loginUrl + '\n\n' +
    'Regards,\nThe StopTelemarketing Team\n' + SITE_URL;

  var htmlBody =
    '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">' +
    '<div style="text-align:center;margin-bottom:32px;">' +
    '<div style="width:64px;height:64px;background:#dcfce7;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 12px;">' +
    '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>' +
    '</div>' +
    '<h2 style="font-size:24px;font-weight:800;color:#0f172a;margin-bottom:8px;">Email verified!</h2>' +
    '</div>' +
    '<p style="font-size:15px;color:#475569;line-height:1.7;margin-bottom:24px;">Hi ' + firstName + ', your email address is now verified. Sign in to complete your opt-out registration and upload your ID document.</p>' +
    '<div style="text-align:center;margin-bottom:32px;">' +
    '<a href="' + loginUrl + '" style="display:inline-block;background:#16a34a;color:#fff;font-size:16px;font-weight:700;padding:16px 36px;border-radius:8px;text-decoration:none;">Complete my registration</a>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">' +
    '<p style="font-size:12px;color:#94a3b8;">Questions? Reply to this email or contact ' + SUPPORT_EMAIL + '</p>' +
    '</div>';

  MailApp.sendEmail({
    to:       email,
    subject:  subject,
    body:     body,
    htmlBody: htmlBody,
    name:     FROM_NAME
  });
}

// ============================================================
//  UTILITY FUNCTIONS
// ============================================================

function getSheet(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Sheet "' + name + '" not found. Run initSheets() first.');
  return sheet;
}

function normaliseEmail(email) {
  return (email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ============================================================
//  PAYFAST PAYMENT NOTIFICATION  (optional — for notify_url)
//  If your notify_url points to this script, add ?action=payfastNotify
// ============================================================

function handlePayfastNotify(p) {
  // TODO: verify PayFast signature before trusting these params
  // See: https://developers.payfast.co.za/docs#step_4_notify_your_site
  var orderRef = p.custom_str1 || '';
  if (!orderRef) return { error: 'Missing order ref' };

  var sheet = getSheet(SHEET_SUBMISSIONS);
  var rows  = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][SUB.ORDER_REF] === orderRef) {
      sheet.getRange(i + 1, SUB.STATUS + 1).setValue('paid');
      Logger.log('Payment confirmed for: ' + orderRef);
      break;
    }
  }
  return { result: 'success' };
}
