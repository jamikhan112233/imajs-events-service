# Google Sheets settings sync

This bound Google Apps Script adds an **Imaj's Events** menu to the Battleship Friends spreadsheet. It reads the `Webhook Settings` tab and manually PATCHes the selected competition profile only when an organizer chooses **Sync settings now**.

## One-time installation

1. Open the Google Sheet and choose **Extensions → Apps Script**.
2. Replace the generated `Code.gs` contents with this directory's `Code.gs`.
3. Save the project and reload the Google Sheet.
4. Choose **Imaj's Events → Set or replace admin token** and paste the Cloudflare Worker `ADMIN_TOKEN`.
5. Review `Min Loot value`, the allowlist, and every checkbox.
6. Choose **Imaj's Events → Sync settings now** and approve Google's requested permissions.

The token is stored in the current organizer's Apps Script user properties. It is not written to a spreadsheet cell. The competition password remains in Cloudflare and is not read or changed by this sync.

## Loot behavior

- `Require both Rarity and Value = TRUE`: an item must match the allowlist (when nonempty) **and** meet `Min Loot value`.
- `Require both Rarity and Value = FALSE`: an item qualifies by matching the allowlist **or** meeting `Min Loot value`.
- `Ignored Loot Items` always wins.
- `Screenshot Min Value` applies to the accepted grouped loot total and controls whether a loot screenshot is attached.
