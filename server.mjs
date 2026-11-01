// iDynamic online rooms for Highway 3D.
// - Practice rooms: public, anyone drops in at any time, everyone drives their own endless run among the others' ghosts.
// - Race rooms: the host starts a 30 km sprint once at least two players are in; nobody joins mid-race.
// - Private rooms of either kind are reached with their 4-letter code only.
// Zero dependencies (Node 18+): a small WebSocket server (RFC 6455) on top of node:http, sized for a small free
// instance: one loop for every room, one binary snapshot per room and per update shared by all its players, JSON only
// for rare control messages.
// Run: node server.mjs   (PORT, default 8787)
//
// PROTOCOL (WebSocket, path /v2)
// Text frames, JSON, rare. Client -> server:
//   {t:'hello', v:2, name, car, color, device}   first message; device is a random id kept by the client
//   {t:'browse', on}                             receive the public room list (every 2 s while it changes)
//   {t:'quick'}                                  join the busiest public practice room that has room, or open one
//   {t:'create', mode:'practice'|'race', public, max}
//   {t:'join', code}   {t:'leave'}   {t:'ready', on}   {t:'start'}   {t:'kick', id}   {t:'chat', i}   {t:'lobby'}
// Server -> client:
//   {t:'welcome', id}   {t:'rooms', list:[{c, h, m, p, x, s}]}   {t:'room', ...room, you}   {t:'players', ...room}
//   {t:'start', delay}   {t:'chat', id, i}   {t:'kicked'}   {t:'error', code}
// Binary frames. Client -> server, 16 bytes, at most 10 per second:
//   u8 type=1, u8 flags (1 driving, 2 finished, 4 nitro), i16 x*100, u16 km/h, u32 distance in decimetres,
//   u32 score, u16 finish time in deciseconds (0 while racing)
// Server -> client, every update of a room: u8 type=2, u8 count, then per player 17 bytes:
//   u16 id, then the 15 bytes the player last sent from flags onwards

import { createServer } from 'node:http'
import { createHash, randomInt } from 'node:crypto'
import { eventRoute } from './event.mjs'

const port = Number(process.env.PORT) || 8787
const maxSockets = 600
const maxRooms = 150
const roomSizes = [4, 8, 12]
const practiceSize = 12
const minRacers = Number(process.env.MIN_RACERS) || 2
const countdownMs = 3000
// After the last racer crosses the line the room goes back to its lobby; a race can't last forever either.
const raceCooldownMs = 6000
const raceTimeoutMs = 15 * 60 * 1000
// Update periods: ghosts in practice only need to look right, racers want a tighter view of the pack.
const practicePeriodMs = 200
const racePeriodMs = 125
const browsePeriodMs = 2000
const pingPeriodMs = 15000
const silentLimitMs = 40000
const kickBanMs = 10 * 60 * 1000
const chatPresets = 8
const chatGapMs = 1500
const maxPayload = 1024
const codeLetters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const stateBytes = 16
const entryBytes = 17

// --- WebSocket frames -------------------------------------------------------------------------------

function frame(opcode, payload) {
  const length = payload.length
  const header = length < 126 ? 2 : 4
  const out = Buffer.allocUnsafe(header + length)
  out[0] = 0x80 | opcode
  if (length < 126) out[1] = length
  else {
    out[1] = 126
    out.writeUInt16BE(length, 2)
  }
  payload.copy(out, header)
  return out
}

const textFrame = (message) => frame(0x1, Buffer.from(JSON.stringify(message)))
const pingFrame = Buffer.from([0x89, 0])
const closeFrame = (code) => {
  const out = Buffer.from([0x88, 2, 0, 0])
  out.writeUInt16BE(code, 2)
  return out
}

function write(conn, data) {
  if (!conn.socket.destroyed && conn.socket.writable) conn.socket.write(data)
}

// --- Connections ------------------------------------------------------------------------------------

const conns = new Set()
const usedIds = new Set()
let lastId = 0

function nextId() {
  do lastId = lastId >= 65535 ? 1 : lastId + 1
  while (usedIds.has(lastId))
  usedIds.add(lastId)
  return lastId
}

// Short, printable names; a few insults are replaced by a neutral driver name.
const blocked = ['connard', 'connasse', 'encule', 'pute', 'salope', 'batard', 'nazi', 'hitler', 'fuck', 'shit', 'bitch', 'nigg', 'fdp', 'ntm', 'pd']
function cleanName(value, id) {
  const name = String(value ?? '').replace(/[^\p{L}\p{N} _\-.]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 14)
  const plain = name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]/g, '')
  if (name.length < 2 || blocked.some((word) => plain.includes(word))) return `Pilote ${id}`
  return name
}

// --- Rooms ------------------------------------------------------------------------------------------

const rooms = new Map()
let listDirty = true
let listJson = '[]'
let listFrame = textFrame({ t: 'rooms', list: [] })
const browsers = new Set()

function newCode() {
  for (;;) {
    const code = Array.from({ length: 4 }, () => codeLetters[randomInt(codeLetters.length)]).join('')
    if (!rooms.has(code) && !legacyRooms.has(code)) return code
  }
}

const describe = (room) => ({
  code: room.code,
  mode: room.mode,
  public: room.isPublic,
  max: room.max,
  host: room.host?.id ?? 0,
  state: room.state,
  players: room.players.map((conn) => ({ id: conn.id, name: conn.name, car: conn.car, color: conn.color, ready: conn.ready })),
})

function sendRoom(room, type) {
  const data = textFrame({ t: type, ...describe(room) })
  for (const conn of room.players) write(conn, data)
}

function openRoom(mode, isPublic, max, host) {
  const room = {
    code: newCode(),
    mode,
    isPublic,
    max: mode === 'practice' ? practiceSize : roomSizes.includes(max) ? max : 8,
    host,
    players: [],
    state: mode === 'practice' ? 'open' : 'lobby',
    startedAt: 0,
    lastFinishAt: 0,
    lastSent: 0,
    changed: false,
    banned: new Map(),
  }
  rooms.set(room.code, room)
  return room
}

function enter(conn, room) {
  leave(conn)
  const ban = room.banned.get(conn.device)
  if (ban && ban > Date.now()) return write(conn, textFrame({ t: 'error', code: 'kicked' }))
  if (room.players.length >= room.max) return write(conn, textFrame({ t: 'error', code: 'full' }))
  if (room.state !== 'open' && room.state !== 'lobby') return write(conn, textFrame({ t: 'error', code: 'racing' }))
  room.players.push(conn)
  conn.room = room
  conn.ready = false
  conn.flags = 0
  if (!room.host) room.host = conn
  listDirty = listDirty || room.isPublic
  write(conn, textFrame({ t: 'room', ...describe(room), you: conn.id }))
  sendRoom(room, 'players')
}

function leave(conn) {
  const room = conn.room
  if (!room) return
  conn.room = null
  conn.flags = 0
  room.players = room.players.filter((other) => other !== conn)
  listDirty = listDirty || room.isPublic
  if (room.players.length === 0) {
    rooms.delete(room.code)
    return
  }
  if (room.host === conn) room.host = room.players[0]
  room.changed = true
  sendRoom(room, 'players')
}

function startRace(room) {
  room.state = 'racing'
  room.startedAt = Date.now() + countdownMs
  room.lastFinishAt = 0
  for (const conn of room.players) {
    conn.flags = 0
    conn.ready = false
  }
  listDirty = listDirty || room.isPublic
  const data = textFrame({ t: 'start', delay: countdownMs })
  for (const conn of room.players) write(conn, data)
  sendRoom(room, 'players')
}

function backToLobby(room) {
  room.state = 'lobby'
  room.startedAt = 0
  listDirty = listDirty || room.isPublic
  sendRoom(room, 'players')
}

// --- Messages ---------------------------------------------------------------------------------------

function onText(conn, message) {
  if (!conn.hello) {
    if (message.t !== 'hello' || message.v !== 2) return write(conn, textFrame({ t: 'error', code: 'update' }))
    conn.hello = true
    conn.device = String(message.device ?? '').slice(0, 40) || `anon-${conn.id}`
    conn.name = cleanName(message.name, conn.id)
    conn.car = Number.isInteger(message.car) ? Math.max(0, Math.min(15, message.car)) : 0
    conn.color = /^#[0-9a-f]{6}$/i.test(message.color ?? '') ? message.color : '#ff5a5f'
    return write(conn, textFrame({ t: 'welcome', id: conn.id }))
  }
  const room = conn.room
  switch (message.t) {
    case 'browse':
      if (message.on) {
        browsers.add(conn)
        write(conn, listFrame)
      } else browsers.delete(conn)
      return
    case 'quick': {
      let best = null
      for (const candidate of rooms.values()) {
        if (candidate.mode !== 'practice' || !candidate.isPublic || candidate.players.length >= candidate.max) continue
        if (candidate.banned.get(conn.device) > Date.now()) continue
        if (!best || candidate.players.length > best.players.length) best = candidate
      }
      if (!best) {
        if (rooms.size >= maxRooms) return write(conn, textFrame({ t: 'error', code: 'busy' }))
        best = openRoom('practice', true, practiceSize, null)
      }
      return enter(conn, best)
    }
    case 'create': {
      if (rooms.size >= maxRooms) return write(conn, textFrame({ t: 'error', code: 'busy' }))
      const mode = message.mode === 'race' ? 'race' : 'practice'
      return enter(conn, openRoom(mode, message.public !== false, Number(message.max), null))
    }
    case 'join': {
      const target = rooms.get(String(message.code ?? '').trim().toUpperCase().slice(0, 4))
      if (!target) return write(conn, textFrame({ t: 'error', code: 'unknown' }))
      return enter(conn, target)
    }
    case 'leave':
      return leave(conn)
    case 'ready':
      if (!room || room.mode !== 'race' || room.state !== 'lobby') return
      conn.ready = Boolean(message.on)
      return sendRoom(room, 'players')
    case 'start':
      if (!room || room.mode !== 'race' || room.state !== 'lobby' || room.host !== conn) return
      if (room.players.length < minRacers) return write(conn, textFrame({ t: 'error', code: 'alone' }))
      return startRace(room)
    case 'lobby':
      if (room && room.mode === 'race' && room.state === 'racing' && room.host === conn) backToLobby(room)
      return
    case 'kick': {
      if (!room || room.host !== conn) return
      const target = room.players.find((other) => other.id === message.id && other !== conn)
      if (!target) return
      room.banned.set(target.device, Date.now() + kickBanMs)
      write(target, textFrame({ t: 'kicked' }))
      return leave(target)
    }
    case 'chat': {
      const index = Number(message.i)
      const now = Date.now()
      if (!room || !Number.isInteger(index) || index < 0 || index >= chatPresets || now - conn.chatAt < chatGapMs) return
      conn.chatAt = now
      const data = textFrame({ t: 'chat', id: conn.id, i: index })
      for (const other of room.players) write(other, data)
      return
    }
    default:
  }
}

// The latest state of each player is kept as it came (from the flags byte on) and copied into the next snapshot.
function onState(conn, data, start) {
  const room = conn.room
  if (!room || data[start] !== 1) return
  if (room.mode === 'race' && room.state !== 'racing') return
  data.copy(conn.state, 0, start + 1, start + stateBytes)
  conn.flags = conn.state[0]
  conn.stateChanged = true
  room.changed = true
  if (room.mode === 'race' && conn.flags & 2 && room.lastFinishAt === 0) room.lastFinishAt = Date.now()
}

// --- Socket input -----------------------------------------------------------------------------------

function onData(conn, chunk) {
  const data = conn.pending ? Buffer.concat([conn.pending, chunk]) : chunk
  conn.pending = null
  let offset = 0
  while (data.length - offset >= 2) {
    const opcode = data[offset] & 0x0f
    const masked = data[offset + 1] & 0x80
    let length = data[offset + 1] & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (data.length - cursor < 2) break
      length = data.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127 || !masked) {
      conn.socket.destroy()
      return
    }
    if (length > maxPayload) {
      conn.socket.destroy()
      return
    }
    if (data.length - cursor < 4 + length) break
    const mask = cursor
    cursor += 4
    for (let i = 0; i < length; i++) data[cursor + i] ^= data[mask + (i & 3)]
    offset = cursor + length
    conn.lastSeen = Date.now()
    // A client may send about 10 states and a few control messages per second; anything beyond is dropped.
    conn.tokens = Math.min(40, conn.tokens + ((conn.lastSeen - conn.tokenAt) / 1000) * 25)
    conn.tokenAt = conn.lastSeen
    if (conn.tokens < 1) {
      if (++conn.dropped > 400) {
        conn.socket.destroy()
        return
      }
      continue
    }
    conn.tokens -= 1
    if (opcode === 0x2) {
      if (length === stateBytes && !conn.legacy) onState(conn, data, cursor)
    } else if (opcode === 0x1) {
      let message
      try {
        message = JSON.parse(data.toString('utf8', cursor, cursor + length))
      } catch {
        continue
      }
      if (message && typeof message === 'object') {
        if (conn.legacy) onLegacy(conn, message)
        else onText(conn, message)
      }
    } else if (opcode === 0x8) {
      write(conn, closeFrame(1000))
      conn.socket.end()
      return
    } else if (opcode === 0x9) {
      write(conn, frame(0xa, data.subarray(cursor, cursor + length)))
    }
  }
  if (offset < data.length) {
    conn.pending = Buffer.from(data.subarray(offset))
    if (conn.pending.length > maxPayload + 16) conn.socket.destroy()
  }
}

function drop(conn) {
  if (!conns.has(conn)) return
  conns.delete(conn)
  browsers.delete(conn)
  usedIds.delete(conn.id)
  if (conn.legacy) legacyLeave(conn)
  else leave(conn)
}

// --- First protocol ---------------------------------------------------------------------------------
// Games released before 3.0 keep racing until they update: JSON relay, rooms of up to 16, the host starts.

const legacyRooms = new Map()
const legacySize = 16
const legacyDescribe = (room) => room.players.map((conn) => ({ id: conn.id, name: conn.name, car: conn.car, color: conn.color, host: conn === room.players[0] }))

function legacyBroadcast(room, message, except) {
  const data = textFrame(message)
  for (const conn of room.players) if (conn !== except) write(conn, data)
}

function legacyLeave(conn) {
  const room = conn.room
  if (!room) return
  conn.room = null
  room.players = room.players.filter((other) => other !== conn)
  if (room.players.length === 0) legacyRooms.delete(room.code)
  else legacyBroadcast(room, { t: 'players', players: legacyDescribe(room), racing: room.racing })
}

function onLegacy(conn, message) {
  const reply = (data) => write(conn, textFrame(data))
  const room = conn.room
  switch (message.t) {
    case 'create':
    case 'join': {
      legacyLeave(conn)
      conn.name = cleanName(message.name, conn.id)
      conn.car = Number.isInteger(message.car) ? message.car : 0
      conn.color = /^#[0-9a-f]{6}$/i.test(message.color ?? '') ? message.color : '#ff5a5f'
      let target
      if (message.t === 'create') {
        if (rooms.size + legacyRooms.size >= maxRooms) return reply({ t: 'error', message: 'Serveur plein, réessaie plus tard.' })
        target = { code: newCode(), players: [], racing: false }
        legacyRooms.set(target.code, target)
      } else {
        target = legacyRooms.get(String(message.code ?? '').trim().toUpperCase().slice(0, 4))
        if (!target) return reply({ t: 'error', message: 'Partie introuvable. Vérifie le code.' })
        if (target.players.length >= legacySize) return reply({ t: 'error', message: 'Partie complète (16 joueurs).' })
        if (target.racing) return reply({ t: 'error', message: 'La course a déjà commencé.' })
      }
      target.players.push(conn)
      conn.room = target
      reply({ t: 'room', code: target.code, you: conn.id })
      legacyBroadcast(target, { t: 'players', players: legacyDescribe(target), racing: target.racing })
      return
    }
    case 'joinFinal':
      return reply({ t: 'error', message: 'Le Grand Prix est annulé.' })
    case 'start':
      if (!room || room.players[0] !== conn) return
      room.racing = true
      legacyBroadcast(room, { t: 'start', delay: countdownMs })
      return
    case 'lobby':
      if (room) room.racing = false
      return
    case 'state': {
      if (!room) return
      const { d, x, s, alive, f } = message
      if (![d, x, s].every(Number.isFinite)) return
      const finish = Number.isFinite(f) && f > 0 ? f : undefined
      legacyBroadcast(room, { t: 'state', id: conn.id, d, x, s, alive: Boolean(alive), ...(finish !== undefined ? { f: finish } : {}) }, conn)
      return
    }
    case 'leave':
      return legacyLeave(conn)
    default:
  }
}

// --- Loop -------------------------------------------------------------------------------------------

function snapshot(room) {
  let count = 0
  for (const conn of room.players) if (conn.stateChanged) count++
  if (count === 0) return
  const payload = Buffer.allocUnsafe(2 + count * entryBytes)
  payload[0] = 2
  payload[1] = count
  let offset = 2
  for (const conn of room.players) {
    if (!conn.stateChanged) continue
    conn.stateChanged = false
    payload.writeUInt16BE(conn.id, offset)
    conn.state.copy(payload, offset + 2)
    offset += entryBytes
  }
  const data = frame(0x2, payload)
  for (const conn of room.players) write(conn, data)
}

function tick() {
  const now = Date.now()
  for (const room of rooms.values()) {
    if (room.mode === 'race' && room.state === 'racing') {
      const everyoneDone = room.players.every((conn) => conn.flags & 2)
      if ((everyoneDone && room.lastFinishAt && now - room.lastFinishAt > raceCooldownMs) || now - room.startedAt > raceTimeoutMs) backToLobby(room)
    }
    if (!room.changed) continue
    const period = room.mode === 'race' ? racePeriodMs : practicePeriodMs
    if (now - room.lastSent < period) continue
    room.lastSent = now
    room.changed = false
    snapshot(room)
  }
}

function refreshList() {
  if (!listDirty) return
  listDirty = false
  const order = { open: 0, lobby: 1, racing: 2 }
  const list = [...rooms.values()]
    .filter((room) => room.isPublic)
    .sort((a, b) => order[a.state] - order[b.state] || b.players.length - a.players.length)
    .slice(0, 60)
    .map((room) => ({ c: room.code, h: room.host?.name ?? '', m: room.mode, p: room.players.length, x: room.max, s: room.state }))
  listJson = JSON.stringify(list)
  listFrame = textFrame({ t: 'rooms', list })
  for (const conn of browsers) write(conn, listFrame)
}

function keepAlive() {
  const now = Date.now()
  for (const conn of conns) {
    if (now - conn.lastSeen > silentLimitMs) conn.socket.destroy()
    else write(conn, pingFrame)
  }
}

setInterval(tick, 50).unref()
setInterval(refreshList, browsePeriodMs).unref()
setInterval(keepAlive, pingPeriodMs).unref()

// --- HTTP -------------------------------------------------------------------------------------------

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders })
  response.end(typeof body === 'string' ? body : JSON.stringify(body))
}

const server = createServer(async (request, response) => {
  const path = (request.url ?? '/').split('?')[0]
  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders)
    response.end()
    return
  }
  if (path === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain', ...corsHeaders })
    response.end('ok')
    return
  }
  if (path === '/rooms') {
    refreshList()
    return sendJson(response, 200, `{"rooms":${listJson},"online":${conns.size}}`)
  }
  if (path.startsWith('/event/')) {
    try {
      let body = {}
      if (request.method === 'POST') {
        let raw = ''
        for await (const chunk of request) {
          raw += chunk
          if (raw.length > 4096) return sendJson(response, 413, { error: 'Requête trop grande.' })
        }
        body = raw ? JSON.parse(raw) : {}
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const [status, result] = await eventRoute(request.method, url.pathname, url.searchParams, body)
      return sendJson(response, status, result)
    } catch {
      return sendJson(response, 500, { error: 'Erreur du serveur, réessaie.' })
    }
  }
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...corsHeaders })
  response.end(`iDynamic multijoueur OK · ${rooms.size} salon(s) · ${conns.size} connecté(s)`)
})

server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key']
  if (!key || request.headers.upgrade?.toLowerCase() !== 'websocket' || conns.size >= maxSockets) {
    socket.destroy()
    return
  }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  socket.setNoDelay(true)
  const now = Date.now()
  const conn = {
    id: nextId(), socket, hello: false, device: '', name: '', car: 0, color: '#ff5a5f',
    room: null, ready: false, flags: 0, state: Buffer.alloc(entryBytes - 2), stateChanged: false,
    pending: null, lastSeen: now, tokens: 40, tokenAt: now, dropped: 0, chatAt: 0,
  }
  conns.add(conn)
  // Games released before 3.0 connect on '/' and speak the first protocol.
  conn.legacy = !(request.url ?? '').startsWith('/v2')
  socket.on('data', (chunk) => onData(conn, chunk))
  socket.on('close', () => drop(conn))
  socket.on('error', () => drop(conn))
})

// The host restarts the instance with SIGTERM: tell every client so it reconnects instead of waiting.
process.on('SIGTERM', () => {
  for (const conn of conns) write(conn, closeFrame(1012))
  server.close()
  setTimeout(() => process.exit(0), 300).unref()
})

if (process.env.LOG_LOAD === '1') {
  let previous = process.cpuUsage()
  setInterval(() => {
    const usage = process.cpuUsage(previous)
    previous = process.cpuUsage()
    const cpu = ((usage.user + usage.system) / 1000 / 10000) * 100
    console.log(`cpu ${cpu.toFixed(1)}% · ${conns.size} sockets · ${rooms.size} rooms · ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`)
  }, 10000).unref()
}

server.listen(port, () => console.log(`iDynamic multijoueur prêt sur le port ${port}`))
