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
const GAME_TIME_PATTERN = /^(?:\d+:){1,2}\d{2}(?:\.\d+)?$/
const EVENT_TYPES = new Set([
  'LOOT',
  'LEVEL',
  'DEATH',
  'KILL_COUNT',
  'SPECIAL_KILL',
  'SPEEDRUN',
  'CUSTOM_CHAT',
])
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024

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
  const eventRequest = await readEventRequest(c)
  if (eventRequest instanceof Response) return eventRequest
  const { body, screenshot, startingScreenshot, endingScreenshot } = eventRequest
  const type = stringValue(body.type, 20).toUpperCase()
  if (!EVENT_TYPES.has(type)) return error(c, 'Unsupported event type', 400)
  if (!eventAllowed(auth.competition, type, body)) {
    return error(c, 'This event is disabled by the competition profile', 403)
  }

  const profile = sanitizeProfile(parseObject(auth.competition.profile_json))
  const safePayload = sanitizeEvent(type, body, profile)
  if (
    screenshot &&
    !(
      (type === 'KILL_COUNT' && profile.killCountScreenshotsEnabled) ||
      (type === 'LOOT' &&
        profile.lootScreenshotsEnabled &&
        Number(safePayload.totalValue ?? 0) >= profile.minimumLootScreenshotValue)
    )
  ) {
    return error(c, 'Screenshots are disabled for this event', 403)
  }
  if (
    type === 'SPECIAL_KILL' &&
    (!profile.specialKillEnabled || !startingScreenshot || !endingScreenshot)
  ) {
    return error(c, 'Special Kill requires organizer approval and both screenshots', 403)
  }
  if (type === 'SPECIAL_KILL' && !GAME_TIME_PATTERN.test(stringValue(body.gameTime, 30))) {
    return error(c, 'Special Kill requires an official game time', 400)
  }
  if (type !== 'SPECIAL_KILL' && (startingScreenshot || endingScreenshot)) {
    return error(c, 'Special Kill screenshots are invalid for this event', 400)
  }
  if (type === 'CUSTOM_CHAT') {
    body.matchedRule = profile.customChatMessages.find((rule) =>
      wildcardMatch(rule, stringValue(body.message, 500))
    ) ?? ''
  }

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
    safePayload,
    { screenshot, startingScreenshot, endingScreenshot }
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
  const name = body.name === undefined
    ? existing.name
    : stringValue(body.name, 80)
  if (!name) return error(c, 'Competition name is required', 400)

  if (name.toLocaleLowerCase() !== existing.name.toLocaleLowerCase()) {
    const duplicate = await c.env.DB.prepare(
      'SELECT id FROM competitions WHERE lower(name) = lower(?) AND id != ? LIMIT 1'
    )
      .bind(name, existing.id)
      .first<{ id: number }>()
    if (duplicate) return error(c, 'A competition with that name already exists', 409)
  }

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
     SET name = ?, webhook_url = ?, profile_json = ?, password_salt = ?, password_hash = ?
     WHERE id = ?`
  )
    .bind(name, webhookUrl, JSON.stringify(profile), passwordSalt, passwordHash, existing.id)
    .run()
  return c.json({ slug, name, profile })
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
  const customChatMessages = Array.isArray(profile.customChatMessages)
    ? profile.customChatMessages
        .map((rule) => stringValue(rule, 200))
        .filter(Boolean)
        .slice(0, 50)
    : []
  return {
    lootEnabled: profile.lootEnabled !== false,
    minimumLootValue: integerValue(profile.minimumLootValue, 0, 2_147_483_647, 0),
    minimumLootScreenshotValue: integerValue(
      profile.minimumLootScreenshotValue,
      0,
      2_147_483_647,
      0
    ),
    requireBothRarityAndValue: profile.requireBothRarityAndValue !== false,
    allowedLootItems: sanitizeItemRules(profile.allowedLootItems),
    ignoredLootItems: sanitizeItemRules(profile.ignoredLootItems),
    itemValueOverrides: sanitizeItemValueOverrides(profile.itemValueOverrides),
    lootScreenshotsEnabled: profile.lootScreenshotsEnabled === true,
    levelEnabled: profile.levelEnabled === true,
    deathEnabled: profile.deathEnabled === true,
    killCountEnabled: profile.killCountEnabled === true,
    setupCaptureEnabled: profile.setupCaptureEnabled === true,
    killCountScreenshotsEnabled: profile.killCountScreenshotsEnabled === true,
    specialKillEnabled: profile.specialKillEnabled === true,
    speedrunEnabled: profile.speedrunEnabled === true,
    customChatEnabled: profile.customChatEnabled === true,
    customChatMessages,
  }
}

function sanitizeItemRules(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((rule) => stringValue(rule, 100))
    .filter(Boolean)
    .filter(
      (rule, index, rules) =>
        rules.findIndex((candidate) => candidate.toLocaleLowerCase() === rule.toLocaleLowerCase()) === index
    )
    .slice(0, 500)
}

function sanitizeItemValueOverrides(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const unique = new Map<string, [string, number]>()
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = stringValue(rawKey, 100)
    if (!key) continue
    const amount = integerValue(rawValue, 0, Number.MAX_SAFE_INTEGER, 0)
    unique.set(key.toLocaleLowerCase(), [key, amount])
    if (unique.size >= 500) break
  }
  return Object.fromEntries(unique.values())
}

function lootItemAccepted(
  profile: ReturnType<typeof sanitizeProfile>,
  item: ReturnType<typeof lootItemsFromBody>[number]
): boolean {
  if (profile.ignoredLootItems.some((rule) => lootRuleMatches(rule, item.itemName, item.itemId))) {
    return false
  }
  const hasAllowlist = profile.allowedLootItems.length > 0
  const matchesAllowlist =
    hasAllowlist &&
    profile.allowedLootItems.some((rule) => lootRuleMatches(rule, item.itemName, item.itemId))
  const meetsMinimum = item.totalValue >= profile.minimumLootValue
  return profile.requireBothRarityAndValue
    ? (!hasAllowlist || matchesAllowlist) && meetsMinimum
    : matchesAllowlist || meetsMinimum
}

function lootRuleMatches(rule: string, itemName: string, itemId: number): boolean {
  return rule === String(itemId) || wildcardMatch(rule, itemName)
}

function eventAllowed(competition: Competition, type: string, body: Record<string, unknown>): boolean {
  const profile = sanitizeProfile(parseObject(competition.profile_json))
  if (type === 'LOOT') {
    return (
      profile.lootEnabled &&
      lootItemsFromBody(body).some((item) => lootItemAccepted(profile, item))
    )
  }
  if (type === 'LEVEL') return profile.levelEnabled
  if (type === 'DEATH') return profile.deathEnabled
  if (type === 'KILL_COUNT') return profile.killCountEnabled
  if (type === 'SPECIAL_KILL') return profile.specialKillEnabled
  if (type === 'SPEEDRUN') return profile.speedrunEnabled
  if (type === 'CUSTOM_CHAT') {
    const message = stringValue(body.message, 500)
    return profile.customChatEnabled && profile.customChatMessages.some((rule) => wildcardMatch(rule, message))
  }
  return false
}

function sanitizeEvent(
  type: string,
  body: Record<string, unknown>,
  profile: ReturnType<typeof sanitizeProfile>
): Record<string, unknown> {
  if (type === 'LOOT') {
    const items = lootItemsFromBody(body).filter((item) => lootItemAccepted(profile, item))
    return {
      source: stringValue(body.source, 100),
      items,
      totalValue: items.reduce((sum, item) => sum + item.totalValue, 0),
    }
  }
  if (type === 'LEVEL') {
    return {
      skill: stringValue(body.skill, 30),
      level: integerValue(body.level, 1, 126, 1),
    }
  }
  if (type === 'KILL_COUNT') {
    const payload: Record<string, unknown> = {
      source: stringValue(body.source, 100),
      killCount: integerValue(body.killCount, 0, 2_147_483_647, 0),
    }
    if (profile.setupCaptureEnabled) {
      payload.setupTotalValue = integerValue(body.setupTotalValue, 0, Number.MAX_SAFE_INTEGER, 0)
      payload.priceBasis = 'RuneLite mapped market value with Jagex guide fallback'
    }
    return payload
  }
  if (type === 'SPECIAL_KILL') {
    const startingGuideValue = integerValue(
      body.startingGuideValue,
      0,
      Number.MAX_SAFE_INTEGER,
      0
    )
    const endingGuideValue = integerValue(
      body.endingGuideValue,
      0,
      Number.MAX_SAFE_INTEGER,
      0
    )
    return {
      source: stringValue(body.source, 100),
      killCount: integerValue(body.killCount, 0, 2_147_483_647, 0),
      gameTime: stringValue(body.gameTime, 30),
      gameTimeMessage: stringValue(body.gameTimeMessage, 500),
      startingGuideValue,
      endingGuideValue,
      guideValueUsed: Math.max(0, startingGuideValue - endingGuideValue),
      priceBasis: 'RuneLite mapped market value with Jagex guide fallback',
    }
  }
  if (type === 'SPEEDRUN') {
    return {
      label: stringValue(body.label, 40),
      duration: stringValue(body.duration, 30),
      message: stringValue(body.message, 500),
    }
  }
  if (type === 'CUSTOM_CHAT') {
    return {
      matchedRule: stringValue(body.matchedRule, 200),
      message: stringValue(body.message, 500),
    }
  }
  return {}
}

function lootItemsFromBody(body: Record<string, unknown>) {
  const supplied = Array.isArray(body.items) ? body.items : [body]
  return supplied
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object')
    .slice(0, 100)
    .map((value) => {
      const itemId = integerValue(value.itemId, 0, 100_000, 0)
      const quantity = integerValue(value.quantity, 1, 2_147_483_647, 1)
      const unitPrice = integerValue(value.unitPrice, 0, Number.MAX_SAFE_INTEGER, 0)
      return {
        itemId,
        itemName: stringValue(value.itemName, 100) || `Item ${itemId}`,
        quantity,
        unitPrice,
        totalValue: integerValue(
          value.totalValue,
          0,
          Number.MAX_SAFE_INTEGER,
          unitPrice * quantity
        ),
      }
    })
}

async function forwardToDiscord(
  webhookUrl: string,
  competition: string,
  rsn: string,
  type: string,
  payload: Record<string, unknown>,
  screenshots: {
    screenshot?: File
    startingScreenshot?: File
    endingScreenshot?: File
  }
): Promise<boolean> {
  const embed: Record<string, unknown> = {
    title: rsn,
    description: discordDescription(type, payload, rsn),
    color: type === 'DEATH' ? 0xc0392b : 0x7e57c2,
    footer: { text: competition },
    timestamp: new Date().toISOString(),
  }
  if (screenshots.screenshot) embed.image = { url: 'attachment://completion.jpg' }

  const embeds: Array<Record<string, unknown>> = [embed]
  if (type === 'SPECIAL_KILL' && screenshots.startingScreenshot && screenshots.endingScreenshot) {
    embed.image = { url: 'attachment://special-kill-end.jpg' }
    embeds.push({
      title: 'Starting setup',
      color: 0x5e4b8b,
      image: { url: 'attachment://special-kill-start.jpg' },
    })
  }

  const discordPayload = {
    username: "Imaj's Events",
    allowed_mentions: { parse: [] },
    embeds,
  }
  let response: Response
  if (
    screenshots.screenshot ||
    screenshots.startingScreenshot ||
    screenshots.endingScreenshot
  ) {
    const form = new FormData()
    form.set('payload_json', JSON.stringify(discordPayload))
    let fileIndex = 0
    if (screenshots.screenshot) {
      form.set(`files[${fileIndex++}]`, screenshots.screenshot, 'completion.jpg')
    }
    if (screenshots.startingScreenshot) {
      form.set(
        `files[${fileIndex++}]`,
        screenshots.startingScreenshot,
        'special-kill-start.jpg'
      )
    }
    if (screenshots.endingScreenshot) {
      form.set(
        `files[${fileIndex}]`,
        screenshots.endingScreenshot,
        'special-kill-end.jpg'
      )
    }
    response = await fetch(webhookUrl, { method: 'POST', body: form })
  } else {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordPayload),
    })
  }
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

function wildcardMatch(pattern: string, value: string): boolean {
  const expected = pattern.toLocaleLowerCase()
  const actual = value.toLocaleLowerCase()
  const parts = expected.split('*')
  let position = 0
  if (!expected.startsWith('*') && !actual.startsWith(parts[0])) return false
  for (const part of parts) {
    if (!part) continue
    const found = actual.indexOf(part, position)
    if (found < 0) return false
    position = found + part.length
  }
  return expected.endsWith('*') || actual.endsWith(parts.at(-1) ?? '')
}

function discordDescription(type: string, payload: Record<string, unknown>, rsn: string): string {
  const player = escapeDiscord(rsn)
  if (type === 'LOOT') {
    const items = Array.isArray(payload.items)
      ? payload.items.filter(
          (value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object'
        )
      : []
    const itemLines = items.map(
      (item) =>
        `• **${formatGp(item.quantity)} × ${escapeDiscord(String(item.itemName))}** — ${formatGp(item.totalValue)} gp`
    )
    return [
      '**Loot Drop**',
      '',
      `**${player} has looted:**`,
      ...itemLines,
      '',
      `**From:** ${escapeDiscord(String(payload.source))}`,
    ].join('\n')
  }
  if (type === 'LEVEL') {
    return `**Level Up**\n\n**${player}** reached **${escapeDiscord(String(payload.skill))} ${payload.level}**.`
  }
  if (type === 'KILL_COUNT') {
    return [
      '**Kill Count**',
      '',
      `**${player}** completed **${escapeDiscord(String(payload.source))}**.`,
      `Kill count: **${payload.killCount}**`,
    ].join('\n')
  }
  if (type === 'SPECIAL_KILL') {
    return [
      '**Special Kill**',
      '',
      `**${player}** completed **${escapeDiscord(String(payload.source))}**.`,
      `Kill count: **${payload.killCount}**`,
      `Official game time: **${escapeDiscord(String(payload.gameTime))}**`,
      `Starting risk value: **${formatGp(payload.startingGuideValue)} gp**`,
      `Ending risk value: **${formatGp(payload.endingGuideValue)} gp**`,
      `Risk value used: **${formatGp(payload.guideValueUsed)} gp**`,
    ].join('\n')
  }
  if (type === 'SPEEDRUN') {
    return `**Speedrun**\n\n**${player}** recorded **${escapeDiscord(String(payload.label))} ${escapeDiscord(String(payload.duration))}**.\n${escapeDiscordLong(String(payload.message))}`
  }
  if (type === 'CUSTOM_CHAT') {
    return `**Custom Chat Message**\n\n**${player}** triggered **${escapeDiscord(String(payload.matchedRule))}**.\n${escapeDiscordLong(String(payload.message))}`
  }
  return `**Death**\n\n**${player}** died in game.`
}

function formatGp(value: unknown): string {
  const amount = Number(value ?? 0)
  return Number.isFinite(amount) ? Math.max(0, Math.trunc(amount)).toLocaleString('en-US') : '0'
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

async function readEventRequest(
  c: AppContext
): Promise<{
  body: Record<string, unknown>
  screenshot?: File
  startingScreenshot?: File
  endingScreenshot?: File
} | Response> {
  const contentType = c.req.header('Content-Type') ?? ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return { body: await safeJson(c) }
  }
  try {
    const form = await c.req.formData()
    const payloadJson = form.get('payload_json')
    if (typeof payloadJson !== 'string' || payloadJson.length > 100_000) {
      return error(c, 'A valid event payload is required', 400)
    }
    const parsed: unknown = JSON.parse(payloadJson)
    if (!parsed || typeof parsed !== 'object') {
      return error(c, 'A valid event payload is required', 400)
    }
    const file = validScreenshot(form.get('file'))
    const startFile = validScreenshot(form.get('start_file'))
    const endFile = validScreenshot(form.get('end_file'))
    if (file === false || startFile === false || endFile === false) {
      return error(c, 'Screenshots must be JPEG files no larger than 8 MiB', 400)
    }
    return {
      body: parsed as Record<string, unknown>,
      screenshot: file ?? undefined,
      startingScreenshot: startFile ?? undefined,
      endingScreenshot: endFile ?? undefined,
    }
  } catch {
    return error(c, 'The multipart event payload is invalid', 400)
  }
}

function validScreenshot(value: FormDataEntryValue | null): File | null | false {
  if (value === null) return null
  if (!(value instanceof File)) return false
  if (value.type !== 'image/jpeg' || value.size > MAX_SCREENSHOT_BYTES) return false
  return value
}

function escapeDiscord(value: string): string {
  return value.replace(/([\\*_~`>|])/g, '\\$1').slice(0, 100)
}

function escapeDiscordLong(value: string): string {
  return value.replace(/([\\*_~`>|])/g, '\\$1').slice(0, 500)
}

function error(c: AppContext, message: string, status: number): Response {
  return c.json({ error: message }, status as ContentfulStatusCode)
}
