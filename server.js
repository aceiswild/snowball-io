// server.js
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

// ----- __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----- Config / Env
const PORT          = process.env.PORT || 3000;
const JWT_SECRET    = process.env.JWT_SECRET || 'dev-secret';

// IMPORTANT: default to your HostGator domain so all join links land there
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://snowball.lanewaypcrepairs.com').replace(/\/+$/, '');

const MIN_PLAYERS = Number(process.env.MIN_PLAYERS || 1);      // 1 for solo dev, 2+ for real rounds
const DEV_SOLO    = (process.env.DEV_SOLO || 'true') === 'true';

// Front-end (HostGator), backend (Render), local
const ALLOWED_ORIGINS = [
  'https://snowball.lanewaypcrepairs.com',
  'https://snowball-dian.onrender.com',
  'http://localhost:3000'
];

// ----- App / Socket
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET','POST'], credentials: true }
});

app.set('trust proxy', true);
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ----- Health + Phase
app.get('/health', (_req, res) => res.send('ok'));
app.get('/phase', (_req, res) => {
  res.json({
    phase: state.phase,
    countdown: state.countdown,
    players: state.players.size,
    devSolo: DEV_SOLO,
    minPlayers: MIN_PLAYERS
  });
});

// =====================================================================
// QR FLOW (host admin page uses this to mint a QR with a join link)
// =====================================================================
app.post('/issue', async (req, res) => {
  try {
    const { employeeId, displayName } = req.body || {};
    if (!employeeId) return res.status(400).json({ error: 'employeeId required' });

    const token = jwt.sign({ employeeId, displayName }, JWT_SECRET, { expiresIn: '10m' });
    const joinUrl = `${PUBLIC_BASE_URL}/play.html?token=${encodeURIComponent(token)}`;
    const qrDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, scale: 8 });

    res.json({ joinUrl, qrDataUrl });
  } catch (err) {
    console.error('Error in /issue:', err?.stack || err);
    res.status(500).json({ error: 'Failed to issue QR' });
  }
});

// =====================================================================
// MOBILE NAME JOIN (the new mobile form posts a name here)
// Returns { ok, token, joinUrl } so client can pushState to play screen
// =====================================================================
app.post('/join', (req, res) => {
  try {
    const { displayName } = req.body || {};
    const name = String(displayName || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'displayName required' });

    // use name as employeeId too (no HR system here)
    const employeeId = name;
    const token = jwt.sign({ employeeId, displayName: name }, JWT_SECRET, { expiresIn: '10m' });
    const joinUrl = `${PUBLIC_BASE_URL}/play.html?token=${encodeURIComponent(token)}`;

    // simple success
    return res.json({ ok: true, token, joinUrl });
  } catch (err) {
    console.error('Error in /join:', err?.stack || err);
    res.status(500).json({ ok: false, error: 'join failed' });
  }
});

// Convenience: GET that gives back a ready link for quick testing in a browser
app.get('/join-url', (req, res) => {
  const name = String(req.query.name || 'Player').trim();
  const token = jwt.sign({ employeeId: name, displayName: name }, JWT_SECRET, { expiresIn: '10m' });
  const joinUrl = `${PUBLIC_BASE_URL}/play.html?token=${encodeURIComponent(token)}`;
  res.json({ ok: true, joinUrl });
});

// ================= Game State =================
const TICKRATE = 30;
const SNAPSHOT_RATE = 18;
const ARENA_RADIUS = 25;
const MOVE_SPEED = 7;
const THROW_COOLDOWN_MS = 600;
const SNOWBALL_SPEED = 24;
const SNOWBALL_LIFETIME = 1800;
const HIT_RADIUS = 1.2;

const PHASES = { LOBBY: 'lobby', COUNTDOWN: 'countdown', LIVE: 'live', ENDED: 'ended' };

const state = {
  phase: PHASES.LOBBY,
  countdown: 0,
  players: new Map(),   // id -> player
  snowballs: []
};

function randSpawn() {
  const a = Math.random() * Math.PI * 2;
  const r = ARENA_RADIUS * 0.7 * Math.random();
  return [Math.cos(a) * r, 0, Math.sin(a) * r];
}
function clampArena([x, y, z]) {
  const d = Math.hypot(x, z);
  if (d > ARENA_RADIUS) {
    const s = ARENA_RADIUS / d;
    return [x * s, y, z * s];
  }
  return [x, y, z];
}

function tryStartMatch() {
  if (state.phase !== PHASES.LOBBY) return;
  const aliveCount = state.players.size;
  if (aliveCount >= MIN_PLAYERS) {
    state.phase = PHASES.COUNTDOWN;
    state.countdown = 3;
    setTimeout(() => (state.countdown = 2), 1000);
    setTimeout(() => (state.countdown = 1), 2000);
    setTimeout(() => (state.phase = PHASES.LIVE), 3000);
    console.log('Match countdown started');
  }
}

function resetMatch() {
  console.log('Resetting match');
  state.phase = PHASES.LOBBY;
  state.countdown = 0;
  state.snowballs.length = 0;
  for (const p of state.players.values()) {
    p.alive = true;
    p.pos = randSpawn();
    p.lastThrow = 0;
  }
}

// Dev helpers (optional)
app.post('/dev/force-start', (_req, res) => {
  if ([PHASES.LOBBY, PHASES.COUNTDOWN].includes(state.phase)) {
    state.phase = PHASES.LIVE;
    state.countdown = 0;
    console.log('Dev force-start: phase -> LIVE');
    return res.json({ ok: true, phase: state.phase });
  }
  res.json({ ok: false, phase: state.phase });
});

app.post('/dev/reset', (_req, res) => { resetMatch(); res.json({ ok: true, phase: state.phase }); });

// ----- Socket handlers
io.on('connection', (socket) => {
  console.log('socket connected', socket.id);
  let player = null;

  socket.on('auth:join', ({ token }) => {
    try {
      const { employeeId, displayName } = jwt.verify(token, JWT_SECRET);

      const id = socket.id;
      const color = `hsl(${Math.floor(Math.random() * 360)} 70% 55%)`;
      player = {
        id,
        name: displayName || String(employeeId),
        color,
        pos: randSpawn(),
        yaw: 0,
        alive: true,
        lastThrow: 0,
        input: { fwd: 0, back: 0, left: 0, right: 0 }
      };

      state.players.set(id, player);
      socket.emit('you:spawn', { id, color, pos: player.pos, name: player.name });

      if (DEV_SOLO && state.phase === PHASES.LOBBY) {
        state.phase = PHASES.LIVE; // solo: start immediately
        console.log('DEV_SOLO: forcing immediate LIVE');
      } else {
        tryStartMatch();
      }
    } catch (e) {
      console.error('auth failed', e.message);
      socket.emit('error', { message: 'Invalid or expired token' });
      socket.disconnect();
    }
  });

  socket.on('input:state', (data) => {
    if (!player || !player.alive) return;
    if (!DEV_SOLO && state.phase !== PHASES.LIVE) return;

    const { fwd, back, left, right, yaw } = data || {};
    player.input = { fwd: !!fwd, back: !!back, left: !!left, right: !!right };
    if (Number.isFinite(yaw)) player.yaw = yaw;
  });

  socket.on('action:throw', ({ dir }) => {
    if (!player || !player.alive) return;
    if (!DEV_SOLO && state.phase !== PHASES.LIVE) return;

    const now = Date.now();
    if (now - player.lastThrow < THROW_COOLDOWN_MS) return;
    player.lastThrow = now;

    const d = Array.isArray(dir) ? dir : [0, 0, -1];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    const n = [d[0] / len, d[1] / len, d[2] / len];

    state.snowballs.push({
      id: `${socket.id}:${now}`,
      ownerId: player.id,
      pos: [player.pos[0], player.pos[1] + 1.0, player.pos[2]],
      vel: [n[0] * SNOWBALL_SPEED, n[1] * SNOWBALL_SPEED, n[2] * SNOWBALL_SPEED],
      bornAt: now
    });
  });

  socket.on('disconnect', () => {
    if (player) {
      state.players.delete(player.id);
      const alive = [...state.players.values()].filter((p) => p.alive).length;
      if (alive < 2 && state.phase !== PHASES.LOBBY) {
        state.phase = PHASES.ENDED;
        setTimeout(resetMatch, 1500);
      }
    }
  });
});

// ----- Physics loop
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;

  if (state.phase === PHASES.LIVE || DEV_SOLO) {
    for (const p of state.players.values()) {
      if (!p.alive) continue;
      let vx = 0, vz = 0;
      if (p.input.fwd)  vz -= 1;
      if (p.input.back) vz += 1;
      if (p.input.left) vx -= 1;
      if (p.input.right)vx += 1;
      const mag = Math.hypot(vx, vz) || 1;
      vx /= mag; vz /= mag;
      p.pos[0] += vx * MOVE_SPEED * dt;
      p.pos[2] += vz * MOVE_SPEED * dt;
      p.pos = clampArena(p.pos);
    }
  }

  // Snowball sim + hits
  state.snowballs = state.snowballs.filter((sb) => now - sb.bornAt < SNOWBALL_LIFETIME);
  for (const sb of state.snowballs) {
    sb.pos[0] += sb.vel[0] * dt;
    sb.pos[1] += sb.vel[1] * dt;
    sb.pos[2] += sb.vel[2] * dt;
    if (sb.pos[1] < 0) sb.pos[1] = 0;
    for (const p of state.players.values()) {
      if (!p.alive || p.id === sb.ownerId) continue;
      const d = Math.hypot(p.pos[0] - sb.pos[0], p.pos[2] - sb.pos[2]);
      if (d < HIT_RADIUS) {
        p.alive = false;
        io.emit('game:eliminated', { id: p.id });
      }
    }
  }

  if (state.phase === PHASES.LIVE) {
    const alive = [...state.players.values()].filter((p) => p.alive);
    if (alive.length <= 1) {
      state.phase = PHASES.ENDED;
      io.emit('game:winner', { id: alive[0]?.id || null, name: alive[0]?.name || null });
      setTimeout(resetMatch, 2500);
    }
  }
}, 1000 / TICKRATE);

// ----- Snapshots
setInterval(() => {
  const players = [...state.players.values()].map((p) => ({
    id: p.id, name: p.name, color: p.color, pos: p.pos, yaw: p.yaw, alive: p.alive
  }));
  const snowballs = state.snowballs.map((s) => ({ id: s.id, pos: s.pos }));
  io.emit('world:state', {
    phase: state.phase,
    countdown: state.countdown,
    players,
    snowballs,
    arena: { radius: ARENA_RADIUS }
  });
}, 1000 / SNAPSHOT_RATE);

// ----- Start server
server.listen(PORT, () => {
  console.log(`Snowball-IO listening on ${PORT}`);
  console.log('PUBLIC_BASE_URL:', PUBLIC_BASE_URL);
  console.log('Allowed CORS origins:', ALLOWED_ORIGINS);
  console.log('MIN_PLAYERS:', MIN_PLAYERS, 'DEV_SOLO:', DEV_SOLO);
});
