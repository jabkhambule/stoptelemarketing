/**
 * StopTelemarketing.co.za - Google Ads Daily Stats Script
 * 
 * HOW TO INSTALL:
 * 1. Go to Google Ads → Tools & Settings → Scripts
 * 2. Click the + button to create a new script
 * 3. Paste this entire file
 * 4. Click "Authorise" and follow the prompts
 * 5. Click "Run" once to test (check your Google Sheet for a new "Ads" tab)
 * 6. Set schedule: Daily at 6:50 AM (South Africa time)
 * 
 * IMPORTANT: Replace SHEET_ID below with your actual Google Sheet ID
 */

var SHEET_ID = '1hiXDRxc8VOv3wEnHv3bctTc-9mNoXpbZAUJxGRtOjqw';
var SHEET_NAME = 'Ads';

function main() {
  var spreadsheet = SpreadsheetApp.openById(SHEET_ID);
  var sheet = spreadsheet.getSheetByName(SHEET_NAME);

  // Create sheet if it doesn't exist
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
    var headers = [
      'Date', 'Campaign', 'Status', 'Impressions', 'Clicks',
      'CTR (%)', 'Avg CPC (R)', 'Cost (R)', 'Conversions', 'Cost/Conv (R)'
    ];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length)
      .setBackground('#0f766e')
      .setFontColor('#ffffff')
      .setFontWeight('bold');
  }

  // Get yesterday's date range
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  var dateStr = Utilities.formatDate(yesterday, 'Africa/Johannesburg', 'yyyy-MM-dd');

  // Query all campaigns
  var report = AdsApp.report(
    'SELECT CampaignName, CampaignStatus, Impressions, Clicks, Ctr, ' +
    'AverageCpc, Cost, Conversions, CostPerConversion ' +
    'FROM CAMPAIGN_PERFORMANCE_REPORT ' +
    'DURING YESTERDAY'
  );

  var rows = report.rows();
  var dataRows = [];

  while (rows.hasNext()) {
    var row = rows.next();
    var cpc = parseFloat(row['AverageCpc'].replace(',', '')) / 1000000; // micros to ZAR
    var cost = parseFloat(row['Cost'].replace(',', '')) / 1000000;
    var costPerConv = row['CostPerConversion'] === '--' ? 0 :
      parseFloat(row['CostPerConversion'].replace(',', '')) / 1000000;
    var ctr = parseFloat(row['Ctr'].replace('%', ''));

    dataRows.push([
      dateStr,
      row['CampaignName'],
      row['CampaignStatus'],
      parseInt(row['Impressions'].replace(',', '')),
      parseInt(row['Clicks'].replace(',', '')),
      ctr.toFixed(2),
      cpc.toFixed(2),
      cost.toFixed(2),
      parseFloat(row['Conversions']),
      costPerConv.toFixed(2)
    ]);
  }

  if (dataRows.length > 0) {
    // Insert new rows at row 2 (below headers)
    sheet.insertRowsBefore(2, dataRows.length);
    sheet.getRange(2, 1, dataRows.length, dataRows[0].length).setValues(dataRows);
  }

  Logger.log('Done. Wrote ' + dataRows.length + ' row(s) for ' + dateStr);
}
