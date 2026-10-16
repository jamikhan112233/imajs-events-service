import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Bindings, Competition, Participant } from '../types'
import {
  hashPassword,
  randomCode,
  randomHex,
  sha256,
  verifyPassword,
} from '../utils/security'

type AppContext = Context<{ Bindings: Bindings }>

const RSN_PATTERN = /^[A-Za-z0-9 _-]{1,12}$/
const EVENT_TYPES = new Set(['LOOT', 'LEVEL', 'DEATH'])

export async function enrollRoute(c: AppContext): Promise<Response> {
  const body = await safeJson(c)
  const competition = stringValue(body.competition, 80)
  const password = stringValue(body.password, 200)
  const rsn = stringValue(body.rsn, 12)
  if (!competition || !password || !RSN_PATTERN.test(rsn)) {
    return error(c, 'Competition, password, and a valid RSN are required', 400)
  }

  const row = await c.env.DB.prepare(
    'SELECT * FROM competitions WHERE slug = ? OR lower(name) = lower(?) LIMIT 1'
  )
    .bind(slugify(competition), competition)
    .first<Competition>()
  if (!row || !(await verifyPassword(password, row.password_salt, row.password_hash))) {
    return error(c, 'Competition or password is incorrect', 401)
  }

  const rosterEntry = await c.env.DB.prepare(
    `SELECT participant_id FROM competition_players
     WHERE competition_id = ? AND normalized_rsn = ? LIMIT 1`
  )
    .bind(row.id, normalizeRsn(rsn))
    .first<{ participant_id: string | null }>()
  if (!rosterEntry) return error(c, 'That RSN is not on the competition roster', 403)
  if (rosterEntry.participant_id) return error(c, 'That roster entry is already enrolled', 409)

  const token = randomHex(32)
  const tokenHash = await sha256(token)
  const participantId = crypto.randomUUID()
  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO participants
         (id, competition_id, token_hash, rsn, normalized_rsn)
         SELECT ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM competition_players
           WHERE competition_id = ? AND normalized_rsn = ? AND participant_id IS NULL
         )`
      ).bind(
        participantId,
        row.id,
        tokenHash,
        rsn,
        normalizeRsn(rsn),
        row.id,
        normalizeRsn(rsn)
      ),
      c.env.DB.prepare(
        `UPDATE competition_players SET participant_id = ?
         WHERE competition_id = ? AND normalized_rsn = ? AND participant_id IS NULL`
      ).bind(participantId, row.id, normalizeRsn(rsn)),
    ])
    if ((results[0].meta.changes ?? 0) !== 1 || (results[1].meta.changes ?? 0) !== 1) {
      return error(c, 'That roster entry is already enrolled', 409)
    }
  } catch {
    return error(c, 'That RSN is already enrolled in this competition', 409)
  }

  return c.json({
    enrollmentToken: token,
    profile: profileFor(row, rsn),
  })
}

export async function profileRoute(c: AppContext): Promise<Response> {
  const auth = await authenticate(c)
  if (auth instanceof Response) return auth
  return c.json(profileFor(auth.competition, auth.participant.rsn))
}

export async function rsnChangeRoute(c: AppContext): Promise<Response> {
  const auth = await authenticate(c)
  if (auth instanceof Response) return auth
  const body = await safeJson(c)
  const newRsn = stringValue(body.newRsn, 12)
  const code = stringValue(body.code, 64).toUpperCase()
  if (!RSN_PATTERN.test(newRsn) || !code) {
    return error(c, 'A valid new RSN and one-time code are required', 400)
  }

  const codeHash = await sha256(code)
  const change = await c.env.DB.prepare(
    `SELECT id FROM rsn_change_codes
     WHERE participant_id = ? AND code_hash = ? AND used_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP
     LIMIT 1`
  )
    .bind(auth.participant.id, codeHash)
    .first<{ id: string }>()
  if (!change) return error(c, 'The RSN change code is invalid or expired', 403)

  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE participants
         SET rsn = ?, normalized_rsn = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM rsn_change_codes
             WHERE id = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP
           )`
      ).bind(newRsn, normalizeRsn(newRsn), auth.participant.id, change.id),
      c.env.DB.prepare(
        `UPDATE competition_players
         SET rsn = ?, normalized_rsn = ?
         WHERE competition_id = ? AND participant_id = ?`
      ).bind(newRsn, normalizeRsn(newRsn), auth.competition.id, auth.participant.id),
      c.env.DB.prepare(
        `UPDATE rsn_change_codes
         SET used_at = CURRENT_TIMESTAMP
         WHERE id = ? AND used_at IS NULL`
      ).bind(change.id),
    ])
    if (
      (results[0].meta.changes ?? 0) !== 1 ||
      (results[1].meta.changes ?? 0) !== 1 ||
      (results[2].meta.changes ?? 0) !== 1
    ) {
      return error(c, 'The RSN change code was already used', 409)
    }
  } catch {
    return error(c, 'That RSN is already enrolled in this competition', 409)
  }

  return c.json(profileFor(auth.competition, newRsn))
}

export async function eventRoute(c: AppContext): Promise<Response> {
  const auth = await authenticate(c)
  if (auth instanceof Response) return auth
  const body = await safeJson(c)
  const type = stringValue(body.type, 20).toUpperCase()
  if (!EVENT_TYPES.has(type)) return error(c, 'Unsupported event type', 400)
  if (!eventAllowed(auth.competition, type, body)) {
    return error(c, 'This event is disabled by the competition profile', 403)
  }

  const safePayload = sanitizeEvent(type, body)
  const eventId = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO competition_events (id, participant_id, event_type, payload_json)
     VALUES (?, ?, ?, ?)`
  )
    .bind(eventId, auth.participant.id, type, JSON.stringify(safePayload))
    .run()

  const forwarded = await forwardToDiscord(
    auth.competition.webhook_url,
    auth.competition.name,
    auth.participant.rsn,
    type,
    safePayload
  )
  if (!forwarded) return error(c, 'Event saved but webhook delivery failed', 502)
  return c.json({ status: 'accepted', eventId }, 202)
}

export async function createCompetitionRoute(c: AppContext): Promise<Response> {
  if (!isAdmin(c)) return error(c, 'Unauthorized', 401)
  const body = await safeJson(c)
  const name = stringValue(body.name, 80)
  const password = stringValue(body.password, 200)
  const webhookUrl = stringValue(body.webhookUrl, 500)
  if (!name || password.length < 8 || !validDiscordWebhook(webhookUrl)) {
    return error(c, 'Name, an 8+ character password, and a Discord webhook URL are required', 400)
  }

  const profile = sanitizeProfile(body.profile)
  const passwordValue = await hashPassword(password)
  try {
    await c.env.DB.prepare(
      `INSERT INTO competitions
       (slug, name, password_salt, password_hash, webhook_url, profile_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        slugify(name),
        name,
        passwordValue.salt,
        passwordValue.hash,
        webhookUrl,
        JSON.stringify(profile)
      )
      .run()
  } catch {
    return error(c, 'A competition with that name already exists', 409)
  }
  return c.json({ slug: slugify(name), name, profile }, 201)
}

export async function createRsnCodeRoute(c: AppContext): Promise<Response> {
  if (!isAdmin(c)) return error(c, 'Unauthorized', 401)
  const slug = c.req.param('slug')
  const body = await safeJson(c)
  const rsn = stringValue(body.rsn, 12)
  const competition = await c.env.DB.prepare(
    'SELECT * FROM competitions WHERE slug = ? LIMIT 1'
  )
    .bind(slug)
    .first<Competition>()
  if (!competition) return error(c, 'Competition not found', 404)
  const participant = await c.env.DB.prepare(
    'SELECT * FROM participants WHERE competition_id = ? AND normalized_rsn = ? LIMIT 1'
  )
    .bind(competition.id, normalizeRsn(rsn))
    .first<Participant>()
  if (!participant) return error(c, 'Participant not found', 404)

  const code = randomCode()
  const codeHash = await sha256(code)
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()
  await c.env.DB.prepare(
    `INSERT INTO rsn_change_codes
     (id, competition_id, participant_id, code_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), competition.id, participant.id, codeHash, expiresAt)
    .run()
  return c.json({ code, expiresAt }, 201)
}

export async function updateCompetitionRoute(c: AppContext): Promise<Response> {
  if (!isAdmin(c)) return error(c, 'Unauthorized', 401)
  const slug = c.req.param('slug')
  const existing = await c.env.DB.prepare(
    'SELECT * FROM competitions WHERE slug = ? LIMIT 1'
  )
    .bind(slug)
    .first<Competition>()
  if (!existing) return error(c, 'Competition not found', 404)

  const body = await safeJson(c)
  const webhookCandidate = stringValue(body.webhookUrl, 500)
  const webhookUrl = webhookCandidate || existing.webhook_url
  if (!validDiscordWebhook(webhookUrl)) {
    return error(c, 'A valid Discord webhook URL is required', 400)
  }
  const profile = body.profile === undefined
    ? sanitizeProfile(parseObject(existing.profile_json))
    : sanitizeProfile(body.profile)

  let passwordSalt = existing.password_salt
  let passwordHash = existing.password_hash
  if (body.password !== undefined) {
    const password = stringValue(body.password, 200)
    if (password.length < 8) return error(c, 'Password must contain at least 8 characters', 400)
    const passwordValue = await hashPassword(password)
    passwordSalt = passwordValue.salt
    passwordHash = passwordValue.hash
  }

  await c.env.DB.prepare(
    `UPDATE competitions
     SET webhook_url = ?, profile_json = ?, password_salt = ?, password_hash = ?
     WHERE id = ?`
  )
    .bind(webhookUrl, JSON.stringify(profile), passwordSalt, passwordHash, existing.id)
    .run()
  return c.json({ slug, name: existing.name, profile })
}

export async function addPlayersRoute(c: AppContext): Promise<Response> {
  if (!isAdmin(c)) return error(c, 'Unauthorized', 401)
  const slug = c.req.param('slug')
  const competition = await c.env.DB.prepare(
    'SELECT * FROM competitions WHERE slug = ? LIMIT 1'
  )
    .bind(slug)
    .first<Competition>()
  if (!competition) return error(c, 'Competition not found', 404)

  const body = await safeJson(c)
  const supplied = Array.isArray(body.players) ? body.players : [body.rsn]
  const players = supplied
    .map((value) => stringValue(value, 12))
    .filter((value) => RSN_PATTERN.test(value))
    .filter((value, index, values) => values.findIndex((other) => normalizeRsn(other) === normalizeRsn(value)) === index)
    .slice(0, 500)
  if (players.length === 0) return error(c, 'At least one valid RSN is required', 400)

  const statements = players.map((rsn) =>
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO competition_players
       (competition_id, rsn, normalized_rsn) VALUES (?, ?, ?)`
    ).bind(competition.id, rsn, normalizeRsn(rsn))
  )
  const results = await c.env.DB.batch(statements)
  const added = results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0)
  return c.json({ added, submitted: players.length }, 201)
}

async function authenticate(
  c: AppContext
): Promise<{ participant: Participant; competition: Competition } | Response> {
  const header = c.req.header('Authorization') ?? ''
  if (!header.startsWith('Bearer ')) return error(c, 'Enrollment token required', 401)
  const tokenHash = await sha256(header.slice(7).trim())
  const participant = await c.env.DB.prepare(
    'SELECT * FROM participants WHERE token_hash = ? LIMIT 1'
  )
    .bind(tokenHash)
    .first<Participant>()
  if (!participant) return error(c, 'Enrollment token is invalid', 401)
  const competition = await c.env.DB.prepare(
    'SELECT * FROM competitions WHERE id = ? LIMIT 1'
  )
    .bind(participant.competition_id)
    .first<Competition>()
  if (!competition) return error(c, 'Competition no longer exists', 404)
  return { participant, competition }
}

function profileFor(competition: Competition, rsn: string) {
  const profile = sanitizeProfile(parseObject(competition.profile_json))
  return {
    competitionName: competition.name,
    registeredRsn: rsn,
    ...profile,
  }
}

function sanitizeProfile(value: unknown) {
  const profile = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    lootEnabled: profile.lootEnabled !== false,
    minimumLootValue: integerValue(profile.minimumLootValue, 0, 2_147_483_647, 0),
    levelEnabled: profile.levelEnabled === true,
    deathEnabled: profile.deathEnabled === true,
  }
}

function eventAllowed(competition: Competition, type: string, body: Record<string, unknown>): boolean {
  const profile = sanitizeProfile(parseObject(competition.profile_json))
  if (type === 'LOOT') {
    return profile.lootEnabled && Number(body.totalValue ?? 0) >= profile.minimumLootValue
  }
  if (type === 'LEVEL') return profile.levelEnabled
  if (type === 'DEATH') return profile.deathEnabled
  return false
}

function sanitizeEvent(type: string, body: Record<string, unknown>): Record<string, unknown> {
  if (type === 'LOOT') {
    const items = Array.isArray(body.items)
      ? body.items.slice(0, 64).map((item) => {
          const value = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
          return {
            itemId: integerValue(value.itemId, 0, 100_000, 0),
            quantity: integerValue(value.quantity, 1, 2_147_483_647, 1),
            unitPrice: integerValue(value.unitPrice, 0, 2_147_483_647, 0),
          }
        })
      : []
    return {
      source: stringValue(body.source, 100),
      totalValue: integerValue(body.totalValue, 0, Number.MAX_SAFE_INTEGER, 0),
      items,
    }
  }
  if (type === 'LEVEL') {
    return {
      skill: stringValue(body.skill, 30),
      level: integerValue(body.level, 1, 126, 1),
    }
  }
  return {}
}

async function forwardToDiscord(
  webhookUrl: string,
  competition: string,
  rsn: string,
  type: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const description =
    type === 'LOOT'
      ? `Received loot from **${escapeDiscord(String(payload.source))}** worth **${Number(payload.totalValue).toLocaleString()} gp**.`
      : type === 'LEVEL'
        ? `Reached **${escapeDiscord(String(payload.skill))} ${payload.level}**.`
        : 'Died in game.'
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: "Imaj's Events",
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: `${competition}: ${rsn}`,
          description,
          color: type === 'DEATH' ? 0xc0392b : 0x7e57c2,
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  })
  return response.ok
}

function isAdmin(c: AppContext): boolean {
  const configured = c.env.ADMIN_TOKEN ?? ''
  const supplied = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  return configured.length >= 24 && configured === supplied
}

function validDiscordWebhook(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      ['discord.com', 'discordapp.com'].includes(url.hostname) &&
      url.pathname.startsWith('/api/webhooks/')
    )
  } catch {
    return false
  }
}

function normalizeRsn(value: string): string {
  return value.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function stringValue(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function integerValue(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)))
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function safeJson(c: AppContext): Promise<Record<string, unknown>> {
  try {
    const value = await c.req.json()
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function escapeDiscord(value: string): string {
  return value.replace(/([\\*_~`>|])/g, '\\$1').slice(0, 100)
}

function error(c: AppContext, message: string, status: number): Response {
  return c.json({ error: message }, status as ContentfulStatusCode)
}
