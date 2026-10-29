// iDynamic multiplayer relay for Highway 3D: rooms of up to 8 players racing at the same time.
// Zero dependencies (Node 18+): a minimal WebSocket server (RFC 6455, text frames) on top of node:http.
// Run: node server/server.mjs   (PORT env var, default 8787)

import { createServer } from 'node:http'
import { createHash, randomInt } from 'node:crypto'

const port = Number(process.env.PORT) || 8787
const maxPlayers = 8
const startDelayMs = 3000
const codeLetters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'

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
        if (room.players.length >= maxPlayers) return reply({ t: 'error', message: 'Partie complète (8 joueurs).' })
        if (room.racing) return reply({ t: 'error', message: 'La course a déjà commencé.' })
      }
      room.players.push(player)
      player.room = room
      reply({ t: 'room', code: room.code, you: player.id })
      broadcast(room, { t: 'players', players: describe(room), racing: room.racing })
      return
    }
    case 'start': {
      const room = player.room
      if (!room || room.players[0] !== player) return
      room.racing = true
      broadcast(room, { t: 'start', delay: startDelayMs })
      return
    }
    case 'lobby': {
      // Back to the lobby after a race (any player): the host can start again.
      if (player.room) player.room.racing = false
      return
    }
    case 'state': {
      if (!player.room) return
      const { d, x, s, alive } = message
      if (![d, x, s].every(Number.isFinite)) return
      broadcast(player.room, { t: 'state', id: player.id, d, x, s, alive: Boolean(alive) }, player)
      return
    }
    case 'leave':
      leave(player)
      return
    default:
  }
}

// --- HTTP + upgrade -----------------------------------------------------------------------------

const server = createServer((request, response) => {
  // Health check for the hosting platform.
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' })
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
