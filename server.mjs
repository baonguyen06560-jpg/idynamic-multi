// iDynamic multiplayer relay for Highway 3D: rooms of up to 16 players racing at the same time.
// Zero dependencies (Node 18+): a minimal WebSocket server (RFC 6455, text frames) on top of node:http.
// Run: node server/server.mjs   (PORT env var, default 8787)

import { createServer } from 'node:http'
import { createHash, randomInt } from 'node:crypto'
import { checkAdmin, eventConfig, eventRoute, isFinalist } from './event.mjs'

const port = Number(process.env.PORT) || 8787
const maxPlayers = 16
const startDelayMs = 3000
const codeLetters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const finalCode = 'FINALE'

// --- WebSocket plumbing -------------------------------------------------------------------------

function sendFrame(socket, text) {
  if (socket.destroyed) return
  const payload = Buffer.from(text)
  let header
  if (payload.length < 126) header = Buffer.from([0x81, payload.length])
  else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  socket.write(Buffer.concat([header, payload]))
}

// Splits the incoming byte stream into frames; returns the bytes not yet forming a whole frame.
function readFrames(buffer, onFrame) {
  let offset = 0
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 0x0f
    const masked = (buffer[offset + 1] & 0x80) !== 0
    let length = buffer[offset + 1] & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (buffer.length - cursor < 2) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    const maskLength = masked ? 4 : 0
    if (buffer.length - cursor < maskLength + length) break
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null
    cursor += maskLength
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
    onFrame(opcode, payload)
    offset = cursor + length
  }
  return buffer.subarray(offset)
}

// --- Rooms --------------------------------------------------------------------------------------

const rooms = new Map()
let nextPlayerId = 1

function newCode() {
  for (;;) {
    const code = Array.from({ length: 4 }, () => codeLetters[randomInt(codeLetters.length)]).join('')
    if (!rooms.has(code)) return code
  }
}

const describe = (room) => room.players.map((player) => ({ id: player.id, name: player.name, car: player.car, color: player.color, host: player === room.players[0] }))

function broadcast(room, message, except) {
  const text = JSON.stringify(message)
  for (const player of room.players) if (player !== except) sendFrame(player.socket, text)
}

function leave(player) {
  const room = player.room
  if (!room) return
  room.players = room.players.filter((other) => other !== player)
  player.room = null
  if (room.players.length === 0) rooms.delete(room.code)
  else broadcast(room, { t: 'players', players: describe(room), racing: room.racing })
}

const clean = (value, max) => String(value ?? '').replace(/[^\p{L}\p{N} _\-.!]/gu, '').trim().slice(0, max)

function handle(player, message) {
  const reply = (data) => sendFrame(player.socket, JSON.stringify(data))
  switch (message.t) {
    case 'create':
    case 'join': {
      leave(player)
      player.name = clean(message.name, 14) || `Pilote ${player.id}`
      player.car = Number.isInteger(message.car) ? message.car : 0
      player.color = /^#[0-9a-f]{6}$/i.test(message.color ?? '') ? message.color : '#ff5a5f'
      let room
      if (message.t === 'create') {
        room = { code: newCode(), players: [], racing: false }
        rooms.set(room.code, room)
      } else {
        room = rooms.get(clean(message.code, 4).toUpperCase())
        if (!room) return reply({ t: 'error', message: 'Partie introuvable. Vérifie le code.' })
        if (room.players.length >= maxPlayers) return reply({ t: 'error', message: 'Partie complète (16 joueurs).' })
        if (room.racing) return reply({ t: 'error', message: 'La course a déjà commencé.' })
      }
      room.players.push(player)
      player.room = room
      reply({ t: 'room', code: room.code, you: player.id })
      broadcast(room, { t: 'players', players: describe(room), racing: room.racing })
      return
    }
    case 'joinFinal': {
      // Grand Prix final: only the qualified finalists get in, the organiser starts it.
      leave(player)
      isFinalist(String(message.token ?? '')).then((ok) => {
        if (!ok) return reply({ t: 'error', message: 'Tu n’es pas qualifié pour la finale.' })
        player.name = clean(message.name, 14) || `Pilote ${player.id}`
        player.car = Number.isInteger(message.car) ? message.car : 0
        player.color = /^#[0-9a-f]{6}$/i.test(message.color ?? '') ? message.color : '#ff5a5f'
        player.token = String(message.token)
        let room = rooms.get(finalCode)
        if (!room) {
          room = { code: finalCode, players: [], racing: false, final: true }
          rooms.set(finalCode, room)
        }
        if (room.racing && room.heat >= finalHeats) return reply({ t: 'error', message: 'La finale est terminée.' })
        room.players.push(player)
        player.room = room
        reply({ t: 'room', code: room.code, you: player.id, final: true })
        broadcast(room, { t: 'players', players: describe(room), racing: room.racing })
      })
      return
    }
    case 'start': {
      const room = player.room
      if (!room || room.final || room.players[0] !== player) return
      room.racing = true
      broadcast(room, { t: 'start', delay: startDelayMs })
      return
    }
    case 'lobby': {
      // Back to the lobby after a race (any player): the host can start again.
      // (The Grand Prix final is run by the organiser: its heats are not reset by players.)
      if (player.room && !player.room.final) player.room.racing = false
      return
    }
    case 'state': {
      if (!player.room) return
      const { d, x, s, alive, f } = message
      if (![d, x, s].every(Number.isFinite)) return
      // Final results are kept as they come: furthest distance and whether still in the race.
      if (player.room.final && player.room.racing) {
        player.finalD = Math.max(player.finalD ?? 0, d)
        player.alive = Boolean(alive)
      }
      // f: sprint finish time, once across the line.
      const finish = Number.isFinite(f) && f > 0 ? f : undefined
      if (finish !== undefined && player.room.final && player.room.racing && player.heatTime === undefined) player.heatTime = finish
      broadcast(player.room, { t: 'state', id: player.id, d, x, s, alive: Boolean(alive), ...(finish !== undefined ? { f: finish } : {}) }, player)
      return
    }
    case 'leave':
      leave(player)
      return
    default:
  }
}

// --- HTTP + upgrade -----------------------------------------------------------------------------

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...corsHeaders })
  response.end(JSON.stringify(body))
}

// The final is 3 sprint heats; each heat gives points (F1 scale), the most points wins.
const finalHeats = 3
const heatPoints = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]

// Ranking of the heat being raced: finishers by time, then the others by distance.
function heatRanking(room) {
  return [...room.players].sort((a, b) => (a.heatTime ?? Infinity) - (b.heatTime ?? Infinity) || (b.finalD ?? 0) - (a.finalD ?? 0))
}

function finalResults() {
  const room = rooms.get(finalCode)
  if (!room) return { heat: 0, heats: finalHeats, current: [], totals: [] }
  const current = room.heat > 0 ? heatRanking(room) : []
  const totals = new Map(room.points ?? [])
  current.forEach((player, index) => totals.set(player.name, (totals.get(player.name) ?? 0) + (heatPoints[index] ?? 0)))
  // Equal points: the better place in the latest heat goes first.
  const lastPlace = (pseudo) => current.findIndex((player) => player.name === pseudo)
  const standings = [...totals.entries()].sort((a, b) => b[1] - a[1] || lastPlace(a[0]) - lastPlace(b[0]))
  return {
    heat: room.heat ?? 0,
    heats: finalHeats,
    racing: room.racing,
    current: current.map((player, index) => ({ rank: index + 1, pseudo: player.name, time: player.heatTime ?? null, distance: Math.round(player.finalD ?? 0), points: heatPoints[index] ?? 0 })),
    totals: standings.map(([pseudo, points], index) => ({ rank: index + 1, pseudo, points, prize: room.heat >= finalHeats ? eventConfig.prizes[index] ?? 0 : 0 })),
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders)
    response.end()
    return
  }
  if (url.pathname.startsWith('/event/')) {
    try {
      // Organiser: start the final and read its results.
      if (url.pathname === '/event/final/start' && request.method === 'POST') {
        if (!checkAdmin(url.searchParams.get('key'))) return sendJson(response, 403, { error: 'Accès refusé.' })
        const room = rooms.get(finalCode)
        if (!room || room.players.length === 0) return sendJson(response, 409, { error: 'Aucun finaliste connecté.' })
        room.heat = room.heat ?? 0
        if (room.heat >= finalHeats) return sendJson(response, 409, { error: 'Les 3 manches sont terminées.' })
        // Bank the points of the heat just raced, then start the next one.
        if (room.heat > 0) {
          room.points = room.points ?? new Map()
          heatRanking(room).forEach((player, index) => room.points.set(player.name, (room.points.get(player.name) ?? 0) + (heatPoints[index] ?? 0)))
        }
        room.players.forEach((player) => { player.heatTime = undefined; player.finalD = 0 })
        room.heat += 1
        room.racing = true
        broadcast(room, { t: 'start', delay: startDelayMs })
        return sendJson(response, 200, { started: true, heat: room.heat, players: room.players.length })
      }
      if (url.pathname === '/event/final/status') {
        // Who is in the final lobby right now (organiser dashboard).
        if (!checkAdmin(url.searchParams.get('key'))) return sendJson(response, 403, { error: 'Accès refusé.' })
        const room = rooms.get(finalCode)
        return sendJson(response, 200, { racing: room?.racing ?? false, heat: room?.heat ?? 0, players: (room?.players ?? []).map((player) => player.name) })
      }
      if (url.pathname === '/event/final/results') {
        if (!checkAdmin(url.searchParams.get('key'))) return sendJson(response, 403, { error: 'Accès refusé.' })
        return sendJson(response, 200, finalResults())
      }
      let body = {}
      if (request.method === 'POST') {
        let raw = ''
        for await (const chunk of request) {
          raw += chunk
          if (raw.length > 4096) return sendJson(response, 413, { error: 'Requête trop grande.' })
        }
        body = raw ? JSON.parse(raw) : {}
      }
      const [status, result] = await eventRoute(request.method, url.pathname, url.searchParams, body)
      return sendJson(response, status, result)
    } catch {
      return sendJson(response, 500, { error: 'Erreur du serveur, réessaie.' })
    }
  }
  // Health check for the hosting platform.
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...corsHeaders })
  response.end(`iDynamic multijoueur OK · ${rooms.size} partie(s)`)
})

server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key']
  if (!key || request.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy()
    return
  }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  socket.setNoDelay(true)

  const player = { id: nextPlayerId++, socket, room: null, name: '', car: 0, color: '#ff5a5f' }
  let pending = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    pending = readFrames(Buffer.concat([pending, chunk]), (opcode, payload) => {
      if (opcode === 0x8) {
        socket.end(Buffer.from([0x88, 0]))
        return
      }
      if (opcode === 0x9) {
        socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]))
        return
      }
      if (opcode !== 0x1) return
      try {
        handle(player, JSON.parse(payload.toString('utf8')))
      } catch {
        // Ignore malformed messages.
      }
    })
    // A client flooding unparseable data is dropped.
    if (pending.length > 64 * 1024) socket.destroy()
  })
  socket.on('close', () => leave(player))
  socket.on('error', () => leave(player))
})

server.listen(port, () => console.log(`iDynamic multijoueur prêt sur le port ${port}`))
