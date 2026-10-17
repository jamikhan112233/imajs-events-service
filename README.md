# Imaj's Events Service

Cloudflare Worker + D1 service for the Imaj's Events RuneLite plugin. It manages competition enrollment, server-owned event profiles, approved player rosters, participant identity, one-time RSN changes, event storage, and Discord forwarding.

## Security model

- Competition passwords use PBKDF2-SHA-256 with a random salt and 100,000 iterations, the maximum supported by Cloudflare Workers.
- Raw competition passwords are never stored.
- Enrollment tokens are random 256-bit values; only SHA-256 token hashes are stored.
- RSN-change codes are participant-specific, single-use, stored only as hashes, and expire after 15 minutes.
- Discord webhook URLs are never returned to plugin clients.
- Every event type and custom system-message pattern is revalidated against the server-owned competition profile.
- Screenshots are accepted only for enabled loot, kill-count, and Special Kill events; each file must be JPEG and is limited to 8 MiB.
- Screenshot bytes are forwarded directly to Discord and are not stored in D1.
- Discord mentions are disabled in forwarded messages.

Treat the `ADMIN_TOKEN`, D1 database, participant enrollment tokens, and Discord webhook URLs as secrets.

## Data retention and support

The service stores participant identity, hashed enrollment credentials, approved-roster data, and accepted event metadata in D1 until the competition organizer requests removal. Raw competition passwords and raw enrollment tokens are never stored. Uploaded screenshots are forwarded directly to the configured Discord webhook and are not retained by the service. The plugin and service have no paid or subscription-gated functionality.

Questions and data-removal requests can be submitted through this repository's [issue tracker](https://github.com/jamikhan112233/imajs-events-service/issues).

## API

Participant routes:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/enroll` | Exchange competition credentials for an opaque token and profile |
| `GET` | `/api/v1/profile` | Refresh the profile with an enrollment bearer token |
| `POST` | `/api/v1/rsn-change` | Use a one-time organizer code to change the registered RSN |
| `POST` | `/api/v1/events` | Store and forward a profile-authorized JSON or multipart event |

Organizer routes require `Authorization: Bearer <ADMIN_TOKEN>`:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/admin/competitions` | Create a competition and server-owned event profile |
| `PATCH` | `/api/v1/admin/competitions/:slug` | Update its password, webhook, or event profile |
| `POST` | `/api/v1/admin/competitions/:slug/players` | Add one or many approved RSNs to the roster |
| `POST` | `/api/v1/admin/competitions/:slug/rsn-codes` | Generate a 15-minute code for one enrolled RSN |

## Event profile

```json
{
  "lootEnabled": true,
  "minimumLootValue": 1000000,
  "minimumLootScreenshotValue": 5000000,
  "requireBothRarityAndValue": true,
  "allowedLootItems": ["Twisted bow", "Godsword shard *", "20997"],
  "ignoredLootItems": ["Coins"],
  "itemValueOverrides": {"Infernal max cape": 225000},
  "lootScreenshotsEnabled": false,
  "levelEnabled": true,
  "deathEnabled": true,
  "killCountEnabled": true,
  "setupCaptureEnabled": true,
  "killCountScreenshotsEnabled": false,
  "specialKillEnabled": false,
  "speedrunEnabled": true,
  "customChatEnabled": true,
  "customChatMessages": [
    "You have completed * Tombs of Amascut raids.",
    "New personal best: *"
  ]
}
```

Loot is received from RuneLite's Loot Tracker integration as one grouped event per source. With `requireBothRarityAndValue` set to `true`, each stack must meet `minimumLootValue` and match `allowedLootItems` when the allowlist is nonempty. With it set to `false`, meeting either condition is enough. `ignoredLootItems` always wins. Item rules accept exact case-insensitive names, numeric item IDs, and `*` wildcards. The service revalidates every item, removes nonqualifying stacks, and sends the remaining source drop in one Discord message. A loot screenshot is attached only when the accepted grouped total also meets `minimumLootScreenshotValue`.

`itemValueOverrides` maps exact case-insensitive item names or canonical numeric item IDs to organizer-defined GP values. The plugin checks an ID override first, then a name override, then RuneLite's current price (including untradeable-to-tradeable `ItemMapping` values), and finally the built-in guide value when no mapped/current price is available.

Custom message patterns are case-insensitive and use `*` as the only wildcard. The service keeps at most 50 rules of 200 characters each and independently checks every submitted custom-message event against them.

`setupCaptureEnabled` permits one combined equipment-plus-inventory risk-value total. The KC Discord text omits that value; the locally rendered screenshot panel contains its item-by-item audit and identifies override, GE, mapped, and guide fallback values. Individual setup item values are not submitted to the service. `killCountScreenshotsEnabled` and `lootScreenshotsEnabled` permit their respective JPEG uploads, but the player must also enable each screenshot type locally in RuneLite.

`specialKillEnabled` permits the player-initiated Special Kill workflow. It never starts automatically. The event requires starting and ending JPEGs and the official game-generated completion time, plus starting/ending risk totals and risk value used.

## Google Sheets settings sync

The optional bound script in [`google-apps-script/Code.gs`](google-apps-script/Code.gs) adds an **Imaj's Events** menu to the Battleship Friends Sheet. It can create a new competition from a copied Sheet, rename an existing competition, change its password through a masked dialog, manually sync `Webhook Settings`, add approved RSNs from `All Players!B2:B`, and generate one-time RSN-change codes. Neither competition passwords nor the Worker admin token are stored in cells. Installation instructions are in [`google-apps-script/README.md`](google-apps-script/README.md).

## Deploy

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

Create a D1 database:

```bash
pnpm wrangler d1 create imajs-events
```

Copy `wrangler.jsonc.example` to `wrangler.jsonc` and paste the returned database ID. Then create a strong administrator token:

```bash
pnpm wrangler secret put ADMIN_TOKEN
```

Apply migrations, build, and deploy:

```bash
pnpm run migrate
pnpm run typecheck
pnpm run build
pnpm wrangler deploy
```

## Create a competition

```bash
curl -X POST 'https://YOUR-WORKER.workers.dev/api/v1/admin/competitions' \
  -H 'Authorization: Bearer YOUR_ADMIN_TOKEN' \
  -H 'Content-Type: application/json' \
  --data '{
    "name": "Imaj Summer Event",
    "password": "use-a-long-random-password",
    "webhookUrl": "https://discord.com/api/webhooks/REPLACE/REPLACE",
    "profile": {
      "lootEnabled": true,
      "minimumLootValue": 1000000,
      "allowedLootItems": [],
      "ignoredLootItems": [],
      "itemValueOverrides": {"Infernal max cape": 225000},
      "lootScreenshotsEnabled": false,
      "levelEnabled": true,
      "deathEnabled": true,
      "killCountEnabled": true,
      "setupCaptureEnabled": true,
      "killCountScreenshotsEnabled": false,
      "specialKillEnabled": false,
      "speedrunEnabled": true,
      "customChatEnabled": true,
      "customChatMessages": ["New personal best: *"]
    }
  }'
```

Add the approved roster before giving participants the competition name and password:

```bash
curl -X POST 'https://YOUR-WORKER.workers.dev/api/v1/admin/competitions/imaj-summer-event/players' \
  -H 'Authorization: Bearer YOUR_ADMIN_TOKEN' \
  -H 'Content-Type: application/json' \
  --data '{"players":["Player One","Player Two"]}'
```

Enrollment is rejected unless the entered RSN has an unclaimed roster entry. Give participants the competition name and password separately from the Worker URL.

## Generate an RSN-change code

```bash
curl -X POST 'https://YOUR-WORKER.workers.dev/api/v1/admin/competitions/imaj-summer-event/rsn-codes' \
  -H 'Authorization: Bearer YOUR_ADMIN_TOKEN' \
  -H 'Content-Type: application/json' \
  --data '{"rsn":"Old Name"}'
```

Send the returned code only to that participant. It expires after 15 minutes.

## License

MIT License.
