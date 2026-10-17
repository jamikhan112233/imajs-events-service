# Google Sheets settings sync

This bound Google Apps Script adds an **Imaj's Events** menu to the Battleship Friends spreadsheet. It can create a competition from a copied Sheet, rename it, change its password, manually sync the `Webhook Settings` competition profile, add approved RSNs from `All Players!B2:B`, and generate participant-specific RSN-change codes without PowerShell.

## One-time installation

1. Open the Google Sheet and choose **Extensions → Apps Script**.
2. Add a new script file named `ImajEvents.gs` and paste this directory's `Code.gs` into it. Leave any existing `Code.gs` file untouched.
3. In **Triggers**, add a spreadsheet **On open** trigger for `imajEventsOnOpen`, then save and reload the Google Sheet.
4. Choose **Imaj's Events → Set or replace admin token** and paste the Cloudflare Worker `ADMIN_TOKEN`.
5. Review `Min Loot value`, the allowlist, and every checkbox. Add `Pet Notifications Enabled` (TRUE/FALSE) and `Pet Screenshots Enabled` (TRUE/FALSE) rows to `Webhook Settings`; if the pet notification row is absent, pet events default to enabled.
6. Choose **Imaj's Events → Sync settings now** and approve Google's requested permissions.

The token is stored in the current organizer's Apps Script user properties. It is not written to a spreadsheet cell. Competition passwords are entered in masked dialogs and sent directly to Cloudflare; they are never written to a spreadsheet cell.

## Menu actions

- **Create competition from this Sheet** reads the competition name, Worker URL, webhook, and complete profile from `Webhook Settings`; it prompts for a password and writes the new stable slug back to the Sheet.
- **Change competition password** changes the current competition's password without storing it in the Sheet.
- **Sync settings now** updates the Discord webhook and complete event profile from `Webhook Settings`.
- Changing **Imaj Competition Name** and choosing **Sync settings now** renames the existing competition. The slug remains stable so enrolled players and stored events remain attached.
- **Sync approved players** submits valid unique RSNs from `All Players!B2:B`; existing roster entries are left unchanged.
- **Generate RSN change code** prompts for an enrolled participant's current RSN and displays a single-use 15-minute code without writing it to the Sheet.
- **Clear saved admin token** removes the token stored for the current Google user.

## Starting another competition from a copied Sheet

1. Make a copy of the spreadsheet.
2. Change **Imaj Competition Name**, the webhook, filters, and event switches in `Webhook Settings`.
3. Keep **Imaj Service URL** unchanged when all competitions use the same Worker.
4. Choose **Create competition from this Sheet** and enter the new competition password.
5. The menu replaces the copied old slug with the newly created competition slug.
6. Choose **Sync approved players** after reviewing `All Players!B2:B`.

The bound script is copied with the spreadsheet, but installable triggers are not guaranteed to copy. If the menu is missing in a copied Sheet, add the spreadsheet **On open** trigger for `imajEventsOnOpen` in that copy.

## Loot behavior

- `Require both Rarity and Value = TRUE`: an item must match the allowlist (when nonempty) **and** meet `Min Loot value`.
- `Require both Rarity and Value = FALSE`: an item qualifies by matching the allowlist **or** meeting `Min Loot value`.
- `Ignored Loot Items` always wins.
- `Screenshot Min Value` applies to the accepted grouped loot total and controls whether a loot screenshot is attached.

## Pet behavior

- `Pet Notifications Enabled` controls whether the Worker accepts pet events.
- `Pet Screenshots Enabled` permits pet screenshots at the competition level; each player must separately enable pet screenshots in RuneLite.
- Pet-name identification is most reliable when RuneScape untradeable-drop notifications are enabled.
