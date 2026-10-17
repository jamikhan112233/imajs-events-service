# Patch notes

## 0.3.0 — Pet events and account-bound enrollment

- Added the `PET` event from RuneLite through the Worker to Discord.
- Added optional organizer-approved pet screenshots.
- Added Google Sheets profile keys `Pet Notifications Enabled` and `Pet Screenshots Enabled`.
- Enrollment now uses the RuneScape character currently logged into RuneLite; the player no longer types an RSN.
- Re-enrolling an approved roster RSN rotates its enrollment token, preventing an old client from permanently locking the roster entry.
- One-time RSN changes now apply to the character currently logged into RuneLite.
- Outbound plugin events are blocked when the logged-in character does not match the registered RSN.
