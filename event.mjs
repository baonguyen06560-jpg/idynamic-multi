// "Grand Prix iDynamic" event: registration, qualifying runs against bots (validated server-side),
// a public leaderboard, and a live final between the 16 best humans.
// Storage: Upstash Redis over its REST API when UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are set
// (persistent, free tier), otherwise in memory (tests only: lost on restart).

import { randomBytes } from 'node:crypto'

const env = process.env
export const eventConfig = {
  name: env.EVENT_NAME || 'Grand Prix iDynamic',
  qualifStart: env.EVENT_QUALIF_START || '2026-11-16T00:00:00+01:00',
  qualifEnd: env.EVENT_QUALIF_END || '2026-11-22T20:00:00+01:00',
  finalAt: env.EVENT_FINAL_AT || '2026-11-22T21:00:00+01:00',
  prizes: [500, 100],
  finalists: 16,
  // EVENT_TEST=1 keeps the qualifiers open whatever the dates (testing).
  alwaysOpen: env.EVENT_TEST === '1',
  // The prize event is called off (replaced by the free monthly cup): no sign-up, no qualifying run.
  // EVENT_CANCELLED=0 turns it back on.
  cancelled: env.EVENT_CANCELLED !== '0',
}
const adminKey = env.ADMIN_KEY || ''

// Qualifiers are 30 km sprints ranked by time (lower is better).
export const sprintLength = 30000
// Anti-cheat: top speed 380 + nitro 90 + slipstream 30 (game distance per second), plus network margin.
const maxMetresPerSecond = 520
// No run can be faster than the whole distance at that speed.
const fastestPossibleSeconds = sprintLength / maxMetresPerSecond
const tickSlackMetres = 60
const maxTickGapMs = 8000

// --- Storage --------------------------------------------------------------------------------------

function memoryStore() {
  const players = new Map()
  const emails = new Map()
  const best = new Map()
  const ranked = () => [...best.entries()].sort((a, b) => a[1] - b[1])
  return {
    async createPlayer(token, data) {
      if (emails.has(data.email)) return false
      emails.set(data.email, token)
      players.set(token, data)
      return true
    },
    async getPlayer(token) { return players.get(token) ?? null },
    async best(token) { return best.get(token) ?? null },
    async submit(token, time) {
      const previous = best.get(token) ?? Infinity
      if (time < previous) best.set(token, time)
      return Math.min(previous, time)
    },
    async rank(token) {
      const index = ranked().findIndex(([member]) => member === token)
      return index < 0 ? null : index + 1
    },
    async top(count) { return ranked().slice(0, count).map(([token, time]) => ({ token, time, pseudo: players.get(token)?.pseudo ?? '?' })) },
    async count() { return players.size },
    async all() { return [...players.entries()].map(([token, data]) => ({ token, ...data, best: best.get(token) ?? null })) },
  }
}

function upstashStore(url, token) {
  const call = async (...command) => {
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(command) })
    const body = await response.json()
    if (body.error) throw new Error(body.error)
    return body.result
  }
  return {
    async createPlayer(playerToken, data) {
      const claimed = await call('SET', `gp:email:${data.email}`, playerToken, 'NX')
      if (claimed !== 'OK') return false
      await call('HSET', `gp:player:${playerToken}`, 'pseudo', data.pseudo, 'email', data.email, 'birthYear', String(data.birthYear), 'created', data.created)
      await call('HSET', 'gp:pseudos', playerToken, data.pseudo)
      await call('SADD', 'gp:players', playerToken)
      return true
    },
    async getPlayer(playerToken) {
      const fields = await call('HGETALL', `gp:player:${playerToken}`)
      if (!fields || fields.length === 0) return null
      const data = {}
      for (let i = 0; i < fields.length; i += 2) data[fields[i]] = fields[i + 1]
      return data
    },
    async best(playerToken) {
      const score = await call('ZSCORE', 'gp:time', playerToken)
      return score === null ? null : Number(score)
    },
    async submit(playerToken, time) {
      await call('ZADD', 'gp:time', 'LT', time, playerToken)
      return Number(await call('ZSCORE', 'gp:time', playerToken))
    },
    async rank(playerToken) {
      const rank = await call('ZRANK', 'gp:time', playerToken)
      return rank === null ? null : rank + 1
    },
    async top(count) {
      const flat = await call('ZRANGE', 'gp:time', 0, count - 1, 'WITHSCORES')
      const tokens = flat.filter((_, index) => index % 2 === 0)
      if (tokens.length === 0) return []
      const pseudos = await call('HMGET', 'gp:pseudos', ...tokens)
      return tokens.map((member, index) => ({ token: member, time: Number(flat[index * 2 + 1]), pseudo: pseudos[index] ?? '?' }))
    },
    async count() { return Number(await call('SCARD', 'gp:players')) },
    async all() {
      const tokens = await call('SMEMBERS', 'gp:players')
      return Promise.all(tokens.map(async (member) => ({ token: member, ...(await this.getPlayer(member)), best: await this.best(member) })))
    },
  }
}

const store = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
  ? upstashStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN)
  : memoryStore()
export const storageKind = env.UPSTASH_REDIS_REST_URL ? 'upstash' : 'memory (tests)'

// --- Event logic ----------------------------------------------------------------------------------

const runs = new Map()

export function qualifOpen(now = Date.now()) {
  if (eventConfig.cancelled) return false
  return eventConfig.alwaysOpen || (now >= Date.parse(eventConfig.qualifStart) && now < Date.parse(eventConfig.qualifEnd))
}

const isEmail = (value) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(value)

export async function isFinalist(token) {
  const top = await store.top(eventConfig.finalists)
  return top.some((entry) => entry.token === token)
}

async function publicBoard(count) {
  const top = await store.top(count)
  return top.map((entry, index) => ({ rank: index + 1, pseudo: entry.pseudo, time: entry.time }))
}

// Routes under /event. Returns [status, body].
export async function eventRoute(method, path, query, body) {
  const now = Date.now()
  if (method === 'GET' && path === '/event/info') {
    return [200, { ...eventConfig, open: qualifOpen(now), registered: await store.count(), storage: storageKind, serverTime: now }]
  }
  if (method === 'GET' && path === '/event/leaderboard') {
    return [200, { top: await publicBoard(Math.min(Number(query.get('count')) || 50, 100)), registered: await store.count() }]
  }
  if (method === 'POST' && path === '/event/register') {
    if (eventConfig.cancelled) return [410, { error: 'Le Grand Prix est annulé : il est remplacé par la Coupe des Panneaux, gratuite.' }]
    const pseudo = String(body.pseudo ?? '').replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 14)
    const email = String(body.email ?? '').trim().toLowerCase()
    const birthYear = Number(body.birthYear)
    if (pseudo.length < 2) return [400, { error: 'Pseudo trop court (2 caractères minimum).' }]
    if (!isEmail(email)) return [400, { error: 'Adresse e-mail invalide.' }]
    if (!Number.isInteger(birthYear) || new Date().getFullYear() - birthYear < 18) return [400, { error: 'Le Grand Prix est réservé aux joueurs majeurs (18 ans et plus).' }]
    if (body.acceptRules !== true) return [400, { error: 'Tu dois accepter le règlement.' }]
    const token = randomBytes(18).toString('base64url')
    if (!(await store.createPlayer(token, { pseudo, email, birthYear, created: new Date(now).toISOString() }))) return [409, { error: 'Cette adresse e-mail est déjà inscrite.' }]
    return [200, { token, pseudo }]
  }
  if (method === 'GET' && path === '/event/me') {
    const token = query.get('token') ?? ''
    const player = await store.getPlayer(token)
    if (!player) return [404, { error: 'Inscription introuvable.' }]
    const top = await store.top(eventConfig.finalists)
    const entry = top.find((item) => item.token === token)
    return [200, { pseudo: player.pseudo, best: await store.best(token), rank: await store.rank(token), finalist: Boolean(entry) && now >= Date.parse(eventConfig.qualifEnd) }]
  }
  if (method === 'POST' && path === '/event/run/start') {
    if (!qualifOpen(now)) return [403, { error: 'Les qualifications ne sont pas ouvertes.' }]
    const token = String(body.token ?? '')
    if (!(await store.getPlayer(token))) return [404, { error: 'Inscription introuvable.' }]
    const runId = randomBytes(9).toString('base64url')
    runs.set(runId, { token, start: now, lastAt: now, lastD: 0, movingMs: 0, valid: true })
    return [200, { runId }]
  }
  if (method === 'POST' && (path === '/event/run/tick' || path === '/event/run/end')) {
    const run = runs.get(String(body.runId ?? ''))
    if (!run || run.token !== body.token) return [404, { error: 'Course inconnue.' }]
    const d = Number(body.d)
    const seconds = (now - run.lastAt) / 1000
    // Distance must only grow, never faster than the fastest car, with regular check-ins.
    if (!Number.isFinite(d) || d < run.lastD - 1 || d - run.lastD > maxMetresPerSecond * seconds + tickSlackMetres || now - run.lastAt > maxTickGapMs) run.valid = false
    if (d > maxMetresPerSecond * ((now - run.start) / 1000) + tickSlackMetres) run.valid = false
    // Time spent actually moving (pauses excluded): the reported race time can't be shorter.
    if (d > run.lastD + 1) run.movingMs += now - run.lastAt
    run.lastAt = now
    run.lastD = Math.max(run.lastD, d)
    if (path === '/event/run/tick') return [200, { ok: run.valid }]
    runs.delete(String(body.runId))
    const time = Math.round(Number(body.time) * 100) / 100
    // The line must be crossed, at a possible pace, in no less time than the car actually drove.
    if (d < sprintLength - 50 || !Number.isFinite(time) || time < fastestPossibleSeconds || time < run.movingMs / 1000 * 0.9 - 4 || time > (now - run.start) / 1000 + 180) run.valid = false
    if (!run.valid) return [200, { accepted: false, error: 'Course non validée (connexion instable ou chrono incohérent).' }]
    const best = await store.submit(run.token, time)
    return [200, { accepted: true, time, best, rank: await store.rank(run.token) }]
  }
  if (method === 'GET' && path === '/event/admin/players') {
    if (!adminKey || query.get('key') !== adminKey) return [403, { error: 'Accès refusé.' }]
    const players = await store.all()
    return [200, { players: players.sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity)) }]
  }
  return [404, { error: 'Introuvable.' }]
}

export function checkAdmin(key) {
  return Boolean(adminKey) && key === adminKey
}

// Old abandoned runs are dropped every minute.
setInterval(() => {
  const now = Date.now()
  for (const [id, run] of runs) if (now - run.lastAt > 60000) runs.delete(id)
}, 60000).unref()
