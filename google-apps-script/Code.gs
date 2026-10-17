const IMAJ_SETTINGS_SHEET = 'Webhook Settings';
const IMAJ_ADMIN_TOKEN_PROPERTY = 'IMAJ_EVENTS_ADMIN_TOKEN';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Imaj's Events")
    .addItem('Set or replace admin token', 'setImajEventsAdminToken')
    .addItem('Sync settings now', 'syncImajEventsSettings')
    .addSeparator()
    .addItem('Clear saved admin token', 'clearImajEventsAdminToken')
    .addToUi();
}

function setImajEventsAdminToken() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    "Imaj's Events admin token",
    'Paste the Cloudflare ADMIN_TOKEN. It is stored in your Google user properties, not in a Sheet cell.',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;

  const token = response.getResponseText().trim();
  if (!token) {
    ui.alert('No token was saved.');
    return;
  }
  PropertiesService.getUserProperties().setProperty(IMAJ_ADMIN_TOKEN_PROPERTY, token);
  ui.alert('Admin token saved for your Google account.');
}

function clearImajEventsAdminToken() {
  PropertiesService.getUserProperties().deleteProperty(IMAJ_ADMIN_TOKEN_PROPERTY);
  SpreadsheetApp.getUi().alert('Your saved Imaj Events admin token was cleared.');
}

function syncImajEventsSettings() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(IMAJ_SETTINGS_SHEET);
  if (!sheet) throw new Error('Missing sheet: ' + IMAJ_SETTINGS_SHEET);

  const settings = readSettings_(sheet);
  const serviceUrl = requiredText_(settings, 'Imaj Service URL').replace(/\/+$/, '');
  const slug = requiredText_(settings, 'Imaj Competition Slug');
  const adminToken = PropertiesService.getUserProperties().getProperty(IMAJ_ADMIN_TOKEN_PROPERTY);
  if (!adminToken) {
    ui.alert("Use Imaj's Events → Set or replace admin token first.");
    return;
  }

  const profile = {
    lootEnabled: booleanSetting_(settings, 'Enable loot'),
    minimumLootValue: integerSetting_(settings, 'Min Loot value'),
    minimumLootScreenshotValue: integerSetting_(settings, 'Screenshot Min Value'),
    requireBothRarityAndValue: booleanSetting_(settings, 'Require both Rarity and Value'),
    allowedLootItems: listSetting_(settings, 'Item Allowlist'),
    ignoredLootItems: listSetting_(settings, 'Ignored Loot Items'),
    itemValueOverrides: overrideSetting_(settings, 'Item Value Overrides'),
    lootScreenshotsEnabled: booleanSetting_(settings, 'Loot Screenshots Enabled'),
    levelEnabled: booleanSetting_(settings, 'Level Notifications Enabled'),
    deathEnabled: booleanSetting_(settings, 'Death Notifications Enabled'),
    killCountEnabled: booleanSetting_(settings, 'Kill Count Notifications Enabled'),
    setupCaptureEnabled: booleanSetting_(settings, 'Setup Value Capture Enabled'),
    killCountScreenshotsEnabled: booleanSetting_(settings, 'Completion Screenshots Enabled'),
    specialKillEnabled: booleanSetting_(settings, 'Special Kill Enabled'),
    speedrunEnabled: booleanSetting_(settings, 'Speedrun Notifications Enabled'),
    customChatEnabled: booleanSetting_(settings, 'Enable Chat Notifications'),
    customChatMessages: listSetting_(settings, 'Message Filters')
      .filter((rule) => rule.toLowerCase() !== '::triggerdink'),
  };

  const body = {
    webhookUrl: textSetting_(settings, 'Webhook URL'),
    profile: profile,
  };

  try {
    const response = UrlFetchApp.fetch(
      serviceUrl + '/api/v1/admin/competitions/' + encodeURIComponent(slug),
      {
        method: 'patch',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + adminToken },
        payload: JSON.stringify(body),
        muteHttpExceptions: true,
      }
    );
    const status = response.getResponseCode();
    if (status < 200 || status >= 300) {
      throw new Error('Worker returned HTTP ' + status + ': ' + response.getContentText());
    }

    writeStatus_(sheet, 'Last Imaj Sync', new Date());
    writeStatus_(
      sheet,
      'Last Imaj Sync Status',
      'Success — ' + profile.allowedLootItems.length + ' allowed, '
        + profile.ignoredLootItems.length + ' ignored, '
        + profile.customChatMessages.length + ' chat rules'
    );
    ui.alert("Imaj's Events settings synced successfully.");
  } catch (error) {
    writeStatus_(sheet, 'Last Imaj Sync', new Date());
    writeStatus_(sheet, 'Last Imaj Sync Status', 'ERROR — ' + error.message);
    ui.alert('Settings were not synced.\n\n' + error.message);
    throw error;
  }
}

function readSettings_(sheet) {
  const lastRow = Math.max(sheet.getLastRow(), 1);
  const rows = sheet.getRange(1, 1, lastRow, 2).getValues();
  const settings = {};
  rows.forEach((row) => {
    const key = String(row[0] || '').trim();
    if (key) settings[key] = row[1];
  });
  return settings;
}

function textSetting_(settings, key) {
  return String(settings[key] == null ? '' : settings[key]).trim();
}

function requiredText_(settings, key) {
  const value = textSetting_(settings, key);
  if (!value) throw new Error('Missing required setting: ' + key);
  return value;
}

function booleanSetting_(settings, key) {
  const value = settings[key];
  return value === true || String(value).trim().toLowerCase() === 'true';
}

function integerSetting_(settings, key) {
  const value = Number(String(settings[key] == null ? 0 : settings[key]).replace(/,/g, ''));
  if (!Number.isFinite(value) || value < 0) throw new Error(key + ' must be zero or a positive number.');
  return Math.floor(value);
}

function listSetting_(settings, key) {
  const seen = {};
  return textSetting_(settings, key)
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => {
      const normalized = value.toLowerCase();
      if (!value || seen[normalized]) return false;
      seen[normalized] = true;
      return true;
    });
}

function overrideSetting_(settings, key) {
  const result = {};
  listSetting_(settings, key).forEach((line) => {
    const match = line.match(/^(.+?)\s*=\s*([\d,]+)$/);
    if (!match) throw new Error('Invalid item override: ' + line + '. Use Item name=GP value.');
    result[match[1].trim()] = Number(match[2].replace(/,/g, ''));
  });
  return result;
}

function writeStatus_(sheet, label, value) {
  const labels = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getDisplayValues();
  const index = labels.findIndex((row) => row[0].trim() === label);
  if (index >= 0) sheet.getRange(index + 1, 2).setValue(value);
}
