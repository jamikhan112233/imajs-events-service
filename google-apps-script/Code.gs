const IMAJ_SETTINGS_SHEET = 'Webhook Settings';
const IMAJ_PLAYERS_SHEET = 'All Players';
const IMAJ_ADMIN_TOKEN_PROPERTY = 'IMAJ_EVENTS_ADMIN_TOKEN';

function imajEventsOnOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Imaj's Events")
    .addItem('Create competition from this Sheet', 'showCreateImajCompetitionDialog')
    .addItem('Change competition password', 'showChangeImajPasswordDialog')
    .addSeparator()
    .addItem('Set or replace admin token', 'setImajEventsAdminToken')
    .addItem('Sync settings now', 'syncImajEventsSettings')
    .addItem('Sync approved players', 'syncImajEventsPlayers')
    .addItem('Generate RSN change code', 'generateImajRsnChangeCode')
    .addSeparator()
    .addItem('Clear saved admin token', 'clearImajEventsAdminToken')
    .addToUi();
}

function showCreateImajCompetitionDialog() {
  showImajPasswordDialog_('create');
}

function showChangeImajPasswordDialog() {
  showImajPasswordDialog_('change');
}

function showImajPasswordDialog_(mode) {
  const isCreate = mode === 'create';
  const title = isCreate ? 'Create Imaj competition' : 'Change competition password';
  const buttonText = isCreate ? 'Create competition' : 'Change password';
  const serverCall = isCreate
    ? 'createImajEventsCompetition'
    : 'changeImajEventsPassword';
  const html = HtmlService.createHtmlOutput(`
    <!doctype html>
    <html>
      <head>
        <base target="_top">
        <style>
          body { font: 14px Arial, sans-serif; padding: 16px; color: #202124; }
          label { display: block; margin: 12px 0 4px; font-weight: 600; }
          input { box-sizing: border-box; width: 100%; padding: 8px; }
          button { margin-top: 16px; padding: 8px 14px; }
          #status { margin-top: 12px; white-space: pre-wrap; }
        </style>
      </head>
      <body>
        <div>The password must contain at least 8 characters. It will be sent directly to the Worker and will not be stored in this spreadsheet.</div>
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="new-password">
        <label for="confirm">Confirm password</label>
        <input id="confirm" type="password" autocomplete="new-password">
        <button id="submit" onclick="submitPassword()">${buttonText}</button>
        <div id="status"></div>
        <script>
          function submitPassword() {
            const password = document.getElementById('password').value;
            const confirm = document.getElementById('confirm').value;
            const status = document.getElementById('status');
            if (password.length < 8) {
              status.textContent = 'Password must contain at least 8 characters.';
              return;
            }
            if (password !== confirm) {
              status.textContent = 'The two passwords do not match.';
              return;
            }
            document.getElementById('submit').disabled = true;
            status.textContent = 'Working…';
            google.script.run
              .withSuccessHandler(function (message) {
                status.textContent = message;
                setTimeout(function () { google.script.host.close(); }, 1400);
              })
              .withFailureHandler(function (error) {
                document.getElementById('submit').disabled = false;
                status.textContent = error && error.message ? error.message : String(error);
              })
              [${JSON.stringify(serverCall)}](password);
          }
        </script>
      </body>
    </html>
  `).setWidth(420).setHeight(330);
  SpreadsheetApp.getUi().showModalDialog(html, title);
}

function createImajEventsCompetition(password) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(IMAJ_SETTINGS_SHEET);
  if (!sheet) throw new Error('Missing sheet: ' + IMAJ_SETTINGS_SHEET);
  const settings = readSettings_(sheet);
  const serviceUrl = requiredText_(settings, 'Imaj Service URL').replace(/\/+$/, '');
  const name = requiredText_(settings, 'Imaj Competition Name');
  const webhookUrl = requiredText_(settings, 'Webhook URL');
  const adminToken = requireAdminToken_();
  if (!adminToken) throw new Error('Set the Imaj Events admin token first.');
  if (String(password || '').length < 8) throw new Error('Password must contain at least 8 characters.');

  const result = workerRequest_(
    'post',
    serviceUrl + '/api/v1/admin/competitions',
    adminToken,
    {
      name: name,
      password: password,
      webhookUrl: webhookUrl,
      profile: profileFromSettings_(settings),
    }
  );
  writeStatus_(sheet, 'Imaj Competition Slug', result.slug);
  writeStatus_(sheet, 'Last Imaj Sync', new Date());
  writeStatus_(sheet, 'Last Imaj Sync Status', 'Created competition — ' + result.name);
  return 'Created “' + result.name + '”. The competition slug is ' + result.slug + '.';
}

function changeImajEventsPassword(password) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(IMAJ_SETTINGS_SHEET);
  if (!sheet) throw new Error('Missing sheet: ' + IMAJ_SETTINGS_SHEET);
  const settings = readSettings_(sheet);
  const serviceUrl = requiredText_(settings, 'Imaj Service URL').replace(/\/+$/, '');
  const slug = requiredText_(settings, 'Imaj Competition Slug');
  const adminToken = requireAdminToken_();
  if (!adminToken) throw new Error('Set the Imaj Events admin token first.');
  if (String(password || '').length < 8) throw new Error('Password must contain at least 8 characters.');

  workerRequest_(
    'patch',
    serviceUrl + '/api/v1/admin/competitions/' + encodeURIComponent(slug),
    adminToken,
    { password: password }
  );
  writeStatus_(sheet, 'Last Imaj Sync', new Date());
  writeStatus_(sheet, 'Last Imaj Sync Status', 'Competition password changed successfully');
  return 'Competition password changed successfully.';
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

  const profile = profileFromSettings_(settings);

  const body = {
    name: requiredText_(settings, 'Imaj Competition Name'),
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
    ui.alert("Imaj's Events settings and competition name synced successfully.");
  } catch (error) {
    writeStatus_(sheet, 'Last Imaj Sync', new Date());
    writeStatus_(sheet, 'Last Imaj Sync Status', 'ERROR — ' + error.message);
    ui.alert('Settings were not synced.\n\n' + error.message);
    throw error;
  }
}

function profileFromSettings_(settings) {
  return {
    lootEnabled: booleanSetting_(settings, 'Enable loot'),
    minimumLootValue: integerSetting_(settings, 'Min Loot value'),
    minimumLootScreenshotValue: integerSetting_(settings, 'Screenshot Min Value'),
    requireBothRarityAndValue: booleanSetting_(settings, 'Require both Rarity and Value'),
    allowedLootItems: listSetting_(settings, 'Item Allowlist'),
    ignoredLootItems: listSetting_(settings, 'Ignored Loot Items'),
    itemValueOverrides: overrideSetting_(settings, 'Item Value Overrides'),
    lootScreenshotsEnabled: booleanSetting_(settings, 'Loot Screenshots Enabled'),
    petEnabled: booleanSettingDefault_(settings, 'Pet Notifications Enabled', true),
    petScreenshotsEnabled: booleanSetting_(settings, 'Pet Screenshots Enabled'),
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
}

function syncImajEventsPlayers() {
  const ui = SpreadsheetApp.getUi();
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const settingsSheet = spreadsheet.getSheetByName(IMAJ_SETTINGS_SHEET);
  const playersSheet = spreadsheet.getSheetByName(IMAJ_PLAYERS_SHEET);
  if (!settingsSheet) throw new Error('Missing sheet: ' + IMAJ_SETTINGS_SHEET);
  if (!playersSheet) throw new Error('Missing sheet: ' + IMAJ_PLAYERS_SHEET);

  const settings = readSettings_(settingsSheet);
  const serviceUrl = requiredText_(settings, 'Imaj Service URL').replace(/\/+$/, '');
  const slug = requiredText_(settings, 'Imaj Competition Slug');
  const adminToken = requireAdminToken_();
  if (!adminToken) return;

  const lastRow = playersSheet.getLastRow();
  const names = lastRow < 2
    ? []
    : playersSheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues().flat();
  const seen = {};
  const players = names
    .map((name) => name.replace(/\u00a0/g, ' ').trim())
    .filter((name) => /^[A-Za-z0-9 _-]{1,12}$/.test(name))
    .filter((name) => {
      const normalized = name.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (seen[normalized]) return false;
      seen[normalized] = true;
      return true;
    });
  if (!players.length) {
    ui.alert('No valid RSNs were found in All Players column B.');
    return;
  }

  const result = workerRequest_(
    'post',
    serviceUrl + '/api/v1/admin/competitions/' + encodeURIComponent(slug) + '/players',
    adminToken,
    { players: players }
  );
  ui.alert(
    'Approved player sync finished.\n\nSubmitted: ' + result.submitted + '\nNewly added: ' + result.added
  );
}

function generateImajRsnChangeCode() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(IMAJ_SETTINGS_SHEET);
  if (!sheet) throw new Error('Missing sheet: ' + IMAJ_SETTINGS_SHEET);
  const settings = readSettings_(sheet);
  const serviceUrl = requiredText_(settings, 'Imaj Service URL').replace(/\/+$/, '');
  const slug = requiredText_(settings, 'Imaj Competition Slug');
  const adminToken = requireAdminToken_();
  if (!adminToken) return;

  const response = ui.prompt(
    'Generate one-time RSN change code',
    "Enter the participant's CURRENT registered RSN.",
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const rsn = response.getResponseText().replace(/\u00a0/g, ' ').trim();
  if (!/^[A-Za-z0-9 _-]{1,12}$/.test(rsn)) {
    ui.alert('Enter a valid current RSN of 1–12 characters.');
    return;
  }

  const result = workerRequest_(
    'post',
    serviceUrl + '/api/v1/admin/competitions/' + encodeURIComponent(slug) + '/rsn-codes',
    adminToken,
    { rsn: rsn }
  );
  ui.alert(
    'One-time code for ' + rsn + ':\n\n' + result.code
      + '\n\nExpires: ' + result.expiresAt + '\nThis code can be used only once.'
  );
}

function requireAdminToken_() {
  const token = PropertiesService.getUserProperties().getProperty(IMAJ_ADMIN_TOKEN_PROPERTY);
  if (!token) {
    SpreadsheetApp.getUi().alert("Use Imaj's Events → Set or replace admin token first.");
    return '';
  }
  return token;
}

function workerRequest_(method, url, adminToken, body) {
  const response = UrlFetchApp.fetch(url, {
    method: method,
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + adminToken },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  const text = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('Worker returned HTTP ' + status + ': ' + text);
  }
  return text ? JSON.parse(text) : {};
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

function booleanSettingDefault_(settings, key, fallback) {
  if (!Object.prototype.hasOwnProperty.call(settings, key)) return fallback;
  return booleanSetting_(settings, key);
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
