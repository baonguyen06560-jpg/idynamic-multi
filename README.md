# Highway 3D online rooms server

Zero-dependency Node server (Node 18 or later) for the game's online rooms:
- **Practice rooms:** public, anyone can drop in at any time, and everyone drives their own endless run among the others' ghost cars.
- **Race rooms:** the host starts a 30 km sprint once at least two drivers are in.
- **Private rooms:** reached with their 4-letter code only.
- **Quick play** joins the busiest public practice room that still has space, or opens a new one.

The WebSocket protocol is described at the top of `server.mjs`. Players send a 16-byte binary state at most 10 times a second. Each room sends one shared binary snapshot of the players that moved: 8 times a second in a race, 5 times a second in practice. The public room list is pushed every 2 seconds while it changes.

## Run locally

```
node server.mjs
```

The game in development mode (`vite`) connects to `ws://localhost:8787/v2` by itself.

`LOG_LOAD=1` prints CPU, sockets, rooms and memory every 10 seconds. `MIN_RACERS=1` lets a single player start a race, for testing.

## Endpoints

| Path | Use |
|---|---|
| `GET /health` | Health check; answers `ok`. |
| `GET /rooms` | Public rooms and the number of connected players, as JSON. |
| `/v2` | WebSocket endpoint of the game. |
| `/event/*` | Former prize event, now closed (`EVENT_CANCELLED`). |

## Deploy on Render (free plan)

The Render service `idynamic-multi` deploys this repository automatically (Auto-Deploy on `main`).

Its settings should be:
- **Root Directory:** empty
- **Start Command:** `node server.mjs`
- **Health Check Path:** `/health`

The game is built with `VITE_MULTI_URL=wss://idynamic-multi.onrender.com`, and the 3.0 versions add `/v2` by themselves. Older versions of the game connect on `/` and keep working.

A free instance goes to sleep after 15 minutes without traffic and takes 30 to 50 seconds to wake up; the game shows a waking-up message meanwhile. To keep it awake, have a free monitor call `https://idynamic-multi.onrender.com/health` every 10 minutes (UptimeRobot, cron-job.org). One always-on service fits in the 750 free hours a month.
