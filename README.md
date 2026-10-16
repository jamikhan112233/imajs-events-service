# Imaj's Events Service

Cloudflare Worker + D1 service for the Imaj's Events RuneLite plugin. It extends the architecture of [`pajlads/dink-url-manager`](https://github.com/pajlads/dink-url-manager) while adding separate competition enrollment, server-owned profiles, participant identity, one-time RSN changes, event storage, and Discord forwarding.

The service is independent and does not require Dink. The original project's MIT license is retained because its Cloudflare/Hono structure was used as the starting point.

## Security model

- Competition passwords use PBKDF2-SHA-256 with a random salt and 210,000 iterations.
- Raw competition passwords are never stored.
- Enrollment tokens are random 256-bit values; only SHA-256 token hashes are stored.
- RSN-change codes are participant-specific, single-use, stored only as hashes, and expire after 15 minutes.
- Discord webhook URLs are never returned to plugin clients.
- Every accepted event is checked against the server-owned competition profile.
- Discord mentions are disabled in forwarded messages.

Treat the `ADMIN_TOKEN`, D1 database, participant enrollment tokens, and Discord webhook URLs as secrets.

## API

Participant routes:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/enroll` | Exchange competition credentials for an opaque token and profile |
| `GET` | `/api/v1/profile` | Refresh the profile with an enrollment bearer token |
| `POST` | `/api/v1/rsn-change` | Use a one-time organizer code to change the registered RSN |
| `POST` | `/api/v1/events` | Store and forward a profile-authorized event |

Organizer routes require `Authorization: Bearer <ADMIN_TOKEN>`:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/admin/competitions` | Create a competition and server-owned event profile |
| `PATCH` | `/api/v1/admin/competitions/:slug` | Update its password, webhook, or event profile |
| `POST` | `/api/v1/admin/competitions/:slug/players` | Add one or many approved RSNs to the roster |
| `POST` | `/api/v1/admin/competitions/:slug/rsn-codes` | Generate a 15-minute code for one enrolled RSN |

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
      "levelEnabled": true,
      "deathEnabled": true
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

## Attribution and license

This service began from the MIT-licensed Dink URL Manager by iProdigy. The original MIT license and copyright notice are retained in `LICENSE`.
