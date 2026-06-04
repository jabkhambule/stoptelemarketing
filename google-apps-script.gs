// ============================================================
//  StopTelemarketing — Google Apps Script Backend v2.2
// ============================================================
//  Run setup() once from the Apps Script editor to initialise
//  sheets, Drive folder, and CRM email triggers.
// ============================================================

var SPREADSHEET_ID = '1hiXDRxc8VOv3wEnHv3bctTc-9mNoXpbZAUJxGRtOjqw';
var SITE_URL       = 'https://stoptelemarketing.co.za';
var FROM_NAME      = 'StopTelemarketing';
var SUPPORT_EMAIL  = 'stoptelemaketing@gmail.com';
var SESSION_TTL_MS = 7  * 24 * 60 * 60 * 1000;  // 7 days
var VERIFY_TTL_MS  = 24 * 60 * 60 * 1000;         // 24 hours

// PayFast merchant credentials
var PF_MERCHANT_ID  = '31907641';
var PF_VALIDATE_URL = 'https://www.payfast.co.za/eng/query/validate';
// var PF_VALIDATE_URL = 'https://sandbox.payfast.co.za/eng/query/validate'; // sandbox

function getPfPassphrase() {
  return PropertiesService.getScriptProperties().getProperty('PF_PASSPHRASE') || '';
}

// Sheet names
var SHEET_ACCOUNTS    = 'Accounts';
var SHEET_SESSIONS    = 'Sessions';
var SHEET_SUBMISSIONS = 'Submissions';
var SHEET_CRM_LOG     = 'CRM_Log';
var SHEET_PAYMENTS    = 'Payments';

// Column indices (0-based)
var AC  = { EMAIL:0, PW_HASH:1, FIRST:2, LAST:3, VERIFIED:4, VFY_TOKEN:5, VFY_EXPIRY:6, CREATED:7, VERIFIED_AT:8 };
var SC  = { TOKEN:0, EMAIL:1, FIRST:2, EXPIRES:3, CREATED:4 };
var SUB = { ORDER_REF:0, TIMESTAMP:1, EMAIL:2, FIRST:3, SURNAME:4, ID_TYPE:5,
            ID_NUM:6, GENDER:7, MARITAL:8, PHONE:9, WORK_PHONE:10,
            ADDRESS:11, DOC_URL:12, STATUS:13, SESSION_TOKEN:14 };
var CL  = { EMAIL:0, STAGE:1, SENT_AT:2 };
var PY  = { ORDER_REF:0, EMAIL:1, AMOUNT:2, PF_PAYMENT_ID:3, STATUS:4, RECEIVED_AT:5, RAW:6 };

// CRM follow-up schedule (milliseconds after the reference timestamp)
var CRM_SCHEDULE = {
  // Verified but never started personal details form
  verify_d1:  1  * 24 * 60 * 60 * 1000,   // 1 day  after verification
  verify_d3:  3  * 24 * 60 * 60 * 1000,   // 3 days after verification
  verify_d7:  7  * 24 * 60 * 60 * 1000,   // 7 days after verification
  // Submitted details but never completed payment
  payment_d1: 1  * 24 * 60 * 60 * 1000,   // 1 day  after submission
  payment_d3: 3  * 24 * 60 * 60 * 1000    // 3 days after submission
};

// ============================================================
//  ONE-TIME SETUP  — run this manually from the editor
// ============================================================

function setup() {
  initSheets();
  initDriveFolder();
  setupCrmTrigger();
  Logger.log('Setup complete!');
}


// Call this separately if you only need to install the CRM trigger
function setupCrmTrigger() {
  // Remove any existing runCrmFollowUps triggers to avoid duplicates
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runCrmFollowUps') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // Create a daily trigger at 09:00 SAST (07:00 UTC)
  ScriptApp.newTrigger('runCrmFollowUps')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();
  Logger.log('CRM daily trigger installed (09:00 SAST).');
}

function initSheets() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  function ensureSheet(name, headers) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length)
           .setFontWeight('bold')
           .setBackground('#0f172a')
           .setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    }
    return sheet;
  }

  ensureSheet(SHEET_ACCOUNTS, [
    'Email','PasswordHash','FirstName','LastName',
    'Verified','VerifyToken','VerifyTokenExpiry','CreatedAt','VerifiedAt'
  ]);
  ensureSheet(SHEET_SESSIONS, [
    'Token','Email','FirstName','ExpiresAt','CreatedAt'
  ]);
  ensureSheet(SHEET_SUBMISSIONS, [
    'OrderRef','Timestamp','Email','FirstName','Surname',
    'IDType','IDNumber','Gender','MaritalStatus',
    'Phone','WorkPhone','Address','IDDocURL','Status','SessionToken'
  ]);
  ensureSheet(SHEET_CRM_LOG, [
    'Email','Stage','SentAt'
  ]);
  ensureSheet(SHEET_PAYMENTS, [
    'OrderRef','Email','AmountGross','PfPaymentId','Status','ReceivedAt','RawData'
  ]);

  Logger.log('Sheets initialised.');
}

function initDriveFolder() {
  var props    = PropertiesService.getScriptProperties();
  var existing = props.getProperty('DRIVE_FOLDER_ID');
  if (existing) {
    Logger.log('Drive folder already set: ' + existing);
    return existing;
  }
  var folder = DriveApp.createFolder('StopTelemarketing — ID Documents');
  folder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  props.setProperty('DRIVE_FOLDER_ID', folder.getId());
  Logger.log('Drive folder created: ' + folder.getId());
  return folder.getId();
}

function getDriveFolderId() {
  return PropertiesService.getScriptProperties().getProperty('DRIVE_FOLDER_ID') || '';
}

// ============================================================
//  ROUTING
// ============================================================

function doGet(e) {
  var action = (e.parameter && e.parameter.action) || '';
  var result;
  try {
    switch (action) {
      case 'register':            result = handleRegister(e.parameter);    break;
      case 'login':               result = handleLogin(e.parameter);       break;
      case 'verifyEmail':         result = handleVerifyEmail(e.parameter); break;
      case 'checkSession':        result = handleCheckSession(e.parameter); break;
      case 'resendVerification':  result = handleResend(e.parameter);      break;
      default:                    result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    Logger.log('doGet error [' + action + ']: ' + err.message + '\n' + err.stack);
    result = { error: 'Server error. Please try again.' };
  }
  return jsonOut(result);
}

function doPost(e) {
  // PayFast ITN arrives as application/x-www-form-urlencoded with a payment_status field
  if (e.parameter && e.parameter.payment_status) {
    try {
      return jsonOut(handlePayfastItn(e.parameter));
    } catch (err) {
      Logger.log('doPost ITN error: ' + err.message + '\n' + err.stack);
      return jsonOut({ error: 'ITN processing error.' });
    }
  }

  // Regular JSON submission (details + ID doc)
  var params = {};
  try {
    if (e.postData && e.postData.contents) {
      try { params = JSON.parse(e.postData.contents); } catch (_) { params = e.parameter || {}; }
    } else {
      params = e.parameter || {};
    }
  } catch (_) { params = {}; }

  var result;
  try {
    result = handleSubmitDetails(params);
  } catch (err) {
    Logger.log('doPost error: ' + err.message + '\n' + err.stack);
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
//  REGISTER
// ============================================================

function handleRegister(p) {
  var email     = normaliseEmail(p.email);
  var pwHash    = (p.pwHash    || '').trim();
  var firstName = (p.firstName || '').trim();
  var lastName  = (p.lastName  || '').trim();

  if (!email || !pwHash || !firstName || !lastName)
    return { error: 'Missing required fields.' };
  if (!isValidEmail(email))
    return { error: 'Invalid email address.' };

  var sheet = getSheet(SHEET_ACCOUNTS);
  var rows  = sheet.getDataRange().getValues();

  for (var i = 1; i < rows.length; i++) {
    if (normaliseEmail(rows[i][AC.EMAIL]) === email)
      return { error: 'An account with this email already exists. Please sign in.' };
  }

  var vfyToken  = Utilities.getUuid();
  var vfyExpiry = new Date(Date.now() + VERIFY_TTL_MS).toISOString();

  sheet.appendRow([
    email, pwHash, firstName, lastName,
    false, vfyToken, vfyExpiry, new Date().toISOString()
  ]);

  sendVerificationEmail(email, firstName, vfyToken);
  return { result: 'success' };
}

// ============================================================
//  LOGIN
// ============================================================

function handleLogin(p) {
  var email  = normaliseEmail(p.email);
  var pwHash = (p.pwHash || '').trim();

  if (!email || !pwHash)
    return { error: 'Missing email or password.' };

  var sheet = getSheet(SHEET_ACCOUNTS);
  var rows  = sheet.getDataRange().getValues();

  for (var i = 1; i < rows.length; i++) {
    if (normaliseEmail(rows[i][AC.EMAIL]) === email) {
      if (rows[i][AC.PW_HASH] !== pwHash)
        return { error: 'Incorrect email or password.' };
      if (!rows[i][AC.VERIFIED])
        return { result: 'success', verified: false };

      var token = createSession(email, rows[i][AC.FIRST]);
      return { result: 'success', verified: true, token: token, firstName: rows[i][AC.FIRST] };
    }
  }

  return { error: 'No account found with that email address.' };
}

// ============================================================
//  VERIFY EMAIL
// ============================================================

function handleVerifyEmail(p) {
  var token = (p.token || '').trim();
  if (!token) return { error: 'Missing verification token.' };

  var sheet = getSheet(SHEET_ACCOUNTS);
  var rows  = sheet.getDataRange().getValues();

  for (var i = 1; i < rows.length; i++) {
    if (rows[i][AC.VFY_TOKEN] === token) {
      if (Date.now() > new Date(rows[i][AC.VFY_EXPIRY]).getTime())
        return { error: 'Verification link has expired. Please request a new one.' };

      var rowNum    = i + 1;
      var verifiedAt = new Date().toISOString();
      sheet.getRange(rowNum, AC.VERIFIED    + 1).setValue(true);
      sheet.getRange(rowNum, AC.VFY_TOKEN   + 1).setValue('');
      sheet.getRange(rowNum, AC.VFY_EXPIRY  + 1).setValue('');
      sheet.getRange(rowNum, AC.VERIFIED_AT + 1).setValue(verifiedAt);

      var email = rows[i][AC.EMAIL];
      sendWelcomeEmail(email, rows[i][AC.FIRST]);
      return { result: 'success', email: email };
    }
  }

  return { error: 'Invalid or already-used verification link.' };
}

// ============================================================
//  CHECK SESSION
// ============================================================

function handleCheckSession(p) {
  var token = (p.token || '').trim();
  if (!token) return { valid: false };

  var sheet = getSheet(SHEET_SESSIONS);
  var rows  = sheet.getDataRange().getValues();

  for (var i = 1; i < rows.length; i++) {
    if (rows[i][SC.TOKEN] === token) {
      if (Date.now() > new Date(rows[i][SC.EXPIRES]).getTime()) {
        sheet.deleteRow(i + 1);
        return { valid: false };
      }
      return { valid: true, email: rows[i][SC.EMAIL], firstName: rows[i][SC.FIRST] };
    }
  }
  return { valid: false };
}

// ============================================================
//  RESEND VERIFICATION
// ============================================================

function handleResend(p) {
  var email = normaliseEmail(p.email);
  if (!email) return { error: 'Missing email.' };

  var sheet = getSheet(SHEET_ACCOUNTS);
  var rows  = sheet.getDataRange().getValues();

  for (var i = 1; i < rows.length; i++) {
    if (normaliseEmail(rows[i][AC.EMAIL]) === email) {
      if (rows[i][AC.VERIFIED])
        return { error: 'This account is already verified. Please sign in.' };

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
//  SUBMIT DETAILS (POST)
// ============================================================

function handleSubmitDetails(p) {
  var sessionToken = (p.sessionToken || '').trim();
  var sessionEmail = '';

  if (sessionToken) {
    var check = handleCheckSession({ token: sessionToken });
    if (!check.valid) return { error: 'Session expired. Please sign in again.' };
    sessionEmail = check.email;
  }

  var orderRef = p.orderRef || ('OPT' + Date.now());
  var email    = p.email || sessionEmail;

  var docUrl       = '';
  var folderId     = getDriveFolderId();
  var base64Content = p.idDocumentBase64 || '';

  if (base64Content && folderId) {
    try {
      var folder   = DriveApp.getFolderById(folderId);
      var mimeType = p.idDocumentType || 'image/jpeg';
      var ext      = mimeType === 'application/pdf' ? '.pdf' : '.jpg';
      var fileName = orderRef + '_' + (email.split('@')[0]) + ext;
      var decoded  = Utilities.base64Decode(base64Content);
      var blob     = Utilities.newBlob(decoded, mimeType, fileName);
      var file     = folder.createFile(blob);
      file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      docUrl = file.getUrl();
    } catch (e) {
      Logger.log('Drive upload error: ' + e.message);
      docUrl = 'UPLOAD_FAILED';
    }
  } else if (base64Content) {
    Logger.log('Warning: Drive folder not set. Run setup() first.');
    docUrl = 'NO_FOLDER_RUN_SETUP';
  }

  // Check if ITN has already confirmed payment for this orderRef
  var paymentConfirmed = isPaymentConfirmed(orderRef);
  // Also accept front-end signal (only trusted because session is validated)
  var submissionStatus = paymentConfirmed ? 'active' : 'pending_payment';

  getSheet(SHEET_SUBMISSIONS).appendRow([
    orderRef,
    p.timestamp || new Date().toISOString(),
    email,
    p.firstName     || '',
    p.surname       || '',
    p.idType        || '',
    p.idNumber      || '',
    p.gender        || '',
    p.maritalStatus || '',
    p.phone         || '',
    p.workPhone     || '',
    p.address       || '',
    docUrl,
    submissionStatus,
    sessionToken
  ]);

  Logger.log('Submission saved: ' + orderRef + ' [' + submissionStatus + '] for ' + email);
  return { result: 'success', orderRef: orderRef, status: submissionStatus };
}

// ============================================================
//  SESSION HELPERS
// ============================================================

function createSession(email, firstName) {
  var token   = Utilities.getUuid();
  var expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  getSheet(SHEET_SESSIONS).appendRow([token, email, firstName, expires, new Date().toISOString()]);
  cleanExpiredSessions();
  return token;
}

function cleanExpiredSessions() {
  var sheet = getSheet(SHEET_SESSIONS);
  var rows  = sheet.getDataRange().getValues();
  var now   = Date.now();
  for (var i = rows.length - 1; i >= 1; i--) {
    if (now > new Date(rows[i][SC.EXPIRES]).getTime()) sheet.deleteRow(i + 1);
  }
}

// ============================================================
//  EMAILS
// ============================================================

function sendVerificationEmail(email, firstName, token) {
  var verifyUrl = SITE_URL + '/?verify=' + token;
  var subject   = 'Verify your StopTelemarketing account';

  var htmlBody =
    '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">' +
    '<div style="text-align:center;margin-bottom:28px;">' +
    '<div style="background:#16a34a;display:inline-block;padding:10px 20px;border-radius:8px;">' +
    '<span style="color:white;font-size:16px;font-weight:800;">STOPTELEMARKETING</span>' +
    '</div></div>' +
    '<h2 style="font-size:22px;font-weight:800;color:#0f172a;margin-bottom:10px;">Verify your email address</h2>' +
    '<p style="font-size:15px;color:#475569;line-height:1.7;margin-bottom:24px;">Hi ' + firstName + ', thanks for signing up! Click the button below to verify your email and activate your account.</p>' +
    '<div style="text-align:center;margin-bottom:28px;">' +
    '<a href="' + verifyUrl + '" style="display:inline-block;background:#16a34a;color:#fff;font-size:16px;font-weight:700;padding:16px 40px;border-radius:8px;text-decoration:none;">Verify my email</a>' +
    '</div>' +
    '<p style="font-size:13px;color:#94a3b8;line-height:1.6;">Or copy this link into your browser:<br><span style="color:#475569;word-break:break-all;">' + verifyUrl + '</span></p>' +
    '<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">' +
    '<p style="font-size:12px;color:#94a3b8;">This link expires in 24 hours. If you did not create this account, please ignore this email.</p>' +
    '</div>';

  MailApp.sendEmail({
    to: email, subject: subject, name: FROM_NAME,
    body: 'Hi ' + firstName + ',\n\nVerify your email:\n' + verifyUrl + '\n\nThis link expires in 24 hours.\n\nStopTelemarketing',
    htmlBody: htmlBody
  });
}

function sendWelcomeEmail(email, firstName) {
  var loginUrl = SITE_URL + '/#order';
  var subject  = 'Email verified — complete your opt-out registration';

  var htmlBody =
    '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">' +
    '<div style="text-align:center;margin-bottom:28px;">' +
    '<div style="width:64px;height:64px;background:#dcfce7;border-radius:50%;margin:0 auto 12px;line-height:64px;text-align:center;">' +
    '<span style="font-size:32px;color:#16a34a;">&#10003;</span>' +
    '</div>' +
    '<h2 style="font-size:22px;font-weight:800;color:#0f172a;margin-bottom:6px;">Email verified!</h2>' +
    '</div>' +
    '<p style="font-size:15px;color:#475569;line-height:1.7;margin-bottom:24px;">Hi ' + firstName + ', your email is verified. Sign in to complete your opt-out registration.</p>' +
    '<div style="text-align:center;margin-bottom:28px;">' +
    '<a href="' + loginUrl + '" style="display:inline-block;background:#16a34a;color:#fff;font-size:16px;font-weight:700;padding:16px 40px;border-radius:8px;text-decoration:none;">Complete my registration</a>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">' +
    '<p style="font-size:12px;color:#94a3b8;">Questions? Email ' + SUPPORT_EMAIL + '</p>' +
    '</div>';

  MailApp.sendEmail({
    to: email, subject: subject, name: FROM_NAME,
    body: 'Hi ' + firstName + ',\n\nYour email is verified.\n\nComplete your registration:\n' + loginUrl + '\n\nStopTelemarketing',
    htmlBody: htmlBody
  });
}

// ============================================================
//  PAYFAST ITN HANDLER
// ============================================================
//  PayFast POSTs to this endpoint after every payment event.
//  We validate the signature, back-ping PayFast to confirm,
//  log the result, then mark the matching Submission active.
// ============================================================

function handlePayfastItn(p) {
  var orderRef     = (p.custom_str1 || '').trim();
  var email        = normaliseEmail(p.custom_str2 || p.email_address || '');
  var paymentId    = (p.pf_payment_id || p.m_payment_id || '').toString().trim();
  var amountGross  = (p.amount_gross  || '0').toString().trim();
  var status       = (p.payment_status || '').trim();
  var receivedAt   = new Date().toISOString();

  Logger.log('ITN received: orderRef=' + orderRef + ' status=' + status + ' pf_id=' + paymentId);

  // 1. Signature validation
  if (!validatePayfastSignature(p)) {
    Logger.log('ITN REJECTED: invalid signature');
    return { error: 'Invalid signature' };
  }

  // 2. Back-ping PayFast to confirm this ITN is genuine
  if (!validateWithPayfast(p)) {
    Logger.log('ITN REJECTED: PayFast back-validation failed');
    return { error: 'PayFast validation failed' };
  }

  // 3. Verify our merchant ID
  if (p.merchant_id !== PF_MERCHANT_ID) {
    Logger.log('ITN REJECTED: merchant_id mismatch (' + p.merchant_id + ')');
    return { error: 'Merchant ID mismatch' };
  }

  // 4. Log the payment (regardless of status)
  getSheet(SHEET_PAYMENTS).appendRow([
    orderRef, email, amountGross, paymentId, status, receivedAt,
    JSON.stringify(p).substring(0, 500)   // truncate to avoid cell size limits
  ]);

  // 5. If payment complete, activate the matching submission (if it exists already)
  if (status === 'COMPLETE') {
    var activated = activateSubmission(orderRef);
    Logger.log('ITN COMPLETE: orderRef=' + orderRef + ' activated=' + activated);
  }

  return { result: 'ok', orderRef: orderRef, status: status };
}

// ── Validate the PayFast MD5 signature ──────────────────────
function validatePayfastSignature(p) {
  try {
    // Collect all params except signature, sort alphabetically
    var keys = Object.keys(p).filter(function(k){ return k !== 'signature'; }).sort();
    var parts = keys.map(function(k) {
      return k + '=' + pfUrlEncode(p[k]);
    });
    var str = parts.join('&');
    var passphrase = getPfPassphrase();
    if (passphrase) str += '&passphrase=' + pfUrlEncode(passphrase);

    // MD5 hash
    var hashBytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.MD5, str, Utilities.Charset.UTF_8
    );
    var hexHash = hashBytes.map(function(b){
      var h = (b & 0xFF).toString(16);
      return h.length === 1 ? '0' + h : h;
    }).join('');

    Logger.log('ITN sig computed=' + hexHash + ' received=' + p.signature);
    return hexHash === p.signature;
  } catch(e) {
    Logger.log('Signature validation error: ' + e.message);
    return false;
  }
}

// URL-encode like PHP urlencode (spaces → +, special chars → %XX)
function pfUrlEncode(val) {
  return encodeURIComponent(String(val || ''))
    .replace(/%20/g, '+')
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

// ── Back-ping PayFast to confirm the ITN is genuine ─────────
function validateWithPayfast(p) {
  try {
    var keys  = Object.keys(p).sort();
    var parts = keys.map(function(k){ return encodeURIComponent(k) + '=' + encodeURIComponent(p[k]); });
    var body  = parts.join('&');

    var response = UrlFetchApp.fetch(PF_VALIDATE_URL, {
      method:            'POST',
      payload:           body,
      contentType:       'application/x-www-form-urlencoded',
      muteHttpExceptions: true,
      headers:           { 'User-Agent': 'StopTelemarketing-GAS/2.2' }
    });
    var text = response.getContentText().trim();
    Logger.log('PayFast back-validation response: ' + text);
    return text === 'VALID';
  } catch(e) {
    Logger.log('PayFast back-validation fetch error: ' + e.message);
    return false;   // Fail safe: reject if we can't reach PayFast
  }
}

// ── Update a Submissions row from pending_payment → active ──
function activateSubmission(orderRef) {
  if (!orderRef) return false;
  var sheet = getSheet(SHEET_SUBMISSIONS);
  var rows  = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][SUB.ORDER_REF] === orderRef) {
      sheet.getRange(i + 1, SUB.STATUS + 1).setValue('active');
      Logger.log('Submission activated: row ' + (i + 1));
      return true;
    }
  }
  Logger.log('activateSubmission: no submission found for ' + orderRef);
  return false;  // ITN arrived before form submission — Payments sheet log covers this
}

// ── Check if a payment is already confirmed (for submitDetails) ──
function isPaymentConfirmed(orderRef) {
  if (!orderRef) return false;
  try {
    var sheet = getSheet(SHEET_PAYMENTS);
    var rows  = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][PY.ORDER_REF] === orderRef && rows[i][PY.STATUS] === 'COMPLETE') {
        return true;
      }
    }
  } catch(e) {
    Logger.log('isPaymentConfirmed error: ' + e.message);
  }
  return false;
}

// ============================================================
//  CRM — TIME-TRIGGERED FOLLOW-UP EMAILS
// ============================================================
//  runCrmFollowUps() is called daily by the time trigger.
//  It sends emails in two sequences:
//    A) Verified users who never submitted personal details
//    B) Users who submitted details but never paid
// ============================================================

function runCrmFollowUps() {
  var now         = Date.now();
  var logSheet    = getSheet(SHEET_CRM_LOG);
  var sentLog     = buildCrmLog(logSheet);   // { "email|stage": true }

  var acctRows    = getSheet(SHEET_ACCOUNTS).getDataRange().getValues();
  var subRows     = getSheet(SHEET_SUBMISSIONS).getDataRange().getValues();

  // Build set of emails that have a Submission row
  var submittedEmails = {};
  for (var s = 1; s < subRows.length; s++) {
    submittedEmails[normaliseEmail(subRows[s][SUB.EMAIL])] = subRows[s][SUB.TIMESTAMP];
  }

  var emailsSent = 0;

  for (var a = 1; a < acctRows.length; a++) {
    var row       = acctRows[a];
    var email     = normaliseEmail(row[AC.EMAIL]);
    var firstName = row[AC.FIRST] || 'there';
    var verified  = row[AC.VERIFIED];

    if (!verified) continue;  // not verified yet — skip

    var verifiedAt = row[AC.VERIFIED_AT] ? new Date(row[AC.VERIFIED_AT]).getTime() : null;

    // ----- Sequence A: verified but never submitted -----
    if (!submittedEmails[email] && verifiedAt) {
      var ageMs = now - verifiedAt;

      if (ageMs >= CRM_SCHEDULE.verify_d7 && !hasSent(sentLog, email, 'verify_d7')) {
        sendCrmEmail(email, firstName, 'verify_d7');
        logSent(logSheet, email, 'verify_d7');
        sentLog[email + '|verify_d7'] = true;
        emailsSent++;
      } else if (ageMs >= CRM_SCHEDULE.verify_d3 && !hasSent(sentLog, email, 'verify_d3')) {
        sendCrmEmail(email, firstName, 'verify_d3');
        logSent(logSheet, email, 'verify_d3');
        sentLog[email + '|verify_d3'] = true;
        emailsSent++;
      } else if (ageMs >= CRM_SCHEDULE.verify_d1 && !hasSent(sentLog, email, 'verify_d1')) {
        sendCrmEmail(email, firstName, 'verify_d1');
        logSent(logSheet, email, 'verify_d1');
        sentLog[email + '|verify_d1'] = true;
        emailsSent++;
      }
    }

    // ----- Sequence B: submitted but never paid -----
    if (submittedEmails[email]) {
      var subTime = submittedEmails[email] ? new Date(submittedEmails[email]).getTime() : null;

      // Check status — only follow up on pending_payment
      var isPending = false;
      for (var s2 = 1; s2 < subRows.length; s2++) {
        if (normaliseEmail(subRows[s2][SUB.EMAIL]) === email &&
            subRows[s2][SUB.STATUS] === 'pending_payment') {
          isPending  = true;
          subTime    = new Date(subRows[s2][SUB.TIMESTAMP]).getTime();
          break;
        }
      }

      if (isPending && subTime && subRows[s2][SUB.STATUS] !== 'active') {
        var subAgeMs = now - subTime;

        if (subAgeMs >= CRM_SCHEDULE.payment_d3 && !hasSent(sentLog, email, 'payment_d3')) {
          sendCrmEmail(email, firstName, 'payment_d3');
          logSent(logSheet, email, 'payment_d3');
          emailsSent++;
        } else if (subAgeMs >= CRM_SCHEDULE.payment_d1 && !hasSent(sentLog, email, 'payment_d1')) {
          sendCrmEmail(email, firstName, 'payment_d1');
          logSent(logSheet, email, 'payment_d1');
          emailsSent++;
        }
      }
    }
  }

  Logger.log('CRM run complete. Emails sent: ' + emailsSent);
}

function buildCrmLog(logSheet) {
  var map  = {};
  var rows = logSheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    map[rows[i][CL.EMAIL] + '|' + rows[i][CL.STAGE]] = true;
  }
  return map;
}

function hasSent(sentLog, email, stage) {
  return !!sentLog[email + '|' + stage];
}

function logSent(logSheet, email, stage) {
  logSheet.appendRow([email, stage, new Date().toISOString()]);
}

function sendCrmEmail(email, firstName, stage) {
  var loginUrl  = SITE_URL + '/#order';
  var subject, headline, body, cta;

  switch (stage) {
    // ---- Verified, never submitted ----
    case 'verify_d1':
      subject  = firstName + ', your opt-out is not complete yet';
      headline = 'Your account is ready — finish your registration';
      body     = 'Hi ' + firstName + ',<br><br>You verified your email yesterday — great start! You just need to sign in and complete your personal details to get your name removed from telemarketing lists across South Africa.';
      cta      = 'Complete my registration';
      break;
    case 'verify_d3':
      subject  = 'Still getting unwanted calls, ' + firstName + '?';
      headline = 'Remove yourself from calling lists today';
      body     = 'Hi ' + firstName + ',<br><br>You\'re only a few minutes away from stopping those annoying calls. Your account is verified and waiting — just sign in to finish the process.';
      cta      = 'Sign in and finish';
      break;
    case 'verify_d7':
      subject  = 'Last reminder — complete your opt-out';
      headline = 'Don\'t let telemarketers keep calling you';
      body     = 'Hi ' + firstName + ',<br><br>A week ago you signed up to stop telemarketing calls. We don\'t want to keep emailing you, but we also don\'t want you to miss out. Take 3 minutes to complete your registration.';
      cta      = 'Complete now — R199';
      break;
    // ---- Submitted, never paid ----
    case 'payment_d1':
      subject  = 'Your details are saved — just one step left, ' + firstName;
      headline = 'Complete your payment to activate your opt-out';
      body     = 'Hi ' + firstName + ',<br><br>You\'ve submitted your personal details — well done! The only thing left is the once-off R199 payment that activates your opt-out registration with the NCC.';
      cta      = 'Complete payment — R199';
      break;
    case 'payment_d3':
      subject  = firstName + ', your opt-out is still pending';
      headline = 'Your registration is waiting for payment';
      body     = 'Hi ' + firstName + ',<br><br>Your personal details are safely saved, but your opt-out won\'t be submitted until payment is received. Complete the once-off R199 payment to activate your registration.';
      cta      = 'Pay now and stop the calls';
      break;
    default:
      return;
  }

  var htmlBody =
    '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">' +
    '<div style="text-align:center;margin-bottom:28px;">' +
    '<div style="background:#16a34a;display:inline-block;padding:10px 20px;border-radius:8px;">' +
    '<span style="color:white;font-size:16px;font-weight:800;">STOPTELEMARKETING</span>' +
    '</div></div>' +
    '<h2 style="font-size:22px;font-weight:800;color:#0f172a;margin-bottom:10px;">' + headline + '</h2>' +
    '<p style="font-size:15px;color:#475569;line-height:1.7;margin-bottom:24px;">' + body + '</p>' +
    '<div style="text-align:center;margin-bottom:28px;">' +
    '<a href="' + loginUrl + '" style="display:inline-block;background:#16a34a;color:#fff;font-size:16px;font-weight:700;padding:16px 40px;border-radius:8px;text-decoration:none;">' + cta + '</a>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">' +
    '<p style="font-size:12px;color:#94a3b8;">You\'re receiving this because you signed up at stoptelemarketing.co.za. ' +
    'If you no longer wish to receive these reminders, reply with "unsubscribe" to ' + SUPPORT_EMAIL + '</p>' +
    '</div>';

  MailApp.sendEmail({
    to: email,
    subject: subject,
    name: FROM_NAME,
    body: headline + '\n\n' + body.replace(/<br><br>/g, '\n\n').replace(/<[^>]+>/g, '') + '\n\n' + loginUrl,
    htmlBody: htmlBody
  });

  Logger.log('CRM email sent [' + stage + '] → ' + email);
}

// ============================================================
//  UTILITIES
// ============================================================

function getSheet(name) {
  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name);
  if (!sheet) throw new Error('Sheet "' + name + '" not found. Run setup() first.');
  return sheet;
}

function normaliseEmail(email) { return (email || '').trim().toLowerCase(); }
function isValidEmail(email)   { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

// v2.2 — PayFast ITN webhook handler added
