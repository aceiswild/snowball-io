import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT        = process.env.PORT || 3000;
const JWT_SECRET  = process.env.JWT_SECRET || 'dev-secret';

// ---- Game constants
const TICKRATE = 30;
const SNAPSHOT_RATE = 18;
const ARENA_RADIUS = 25;
const MOVE_SPEED = 7;
const THROW_COOLDOWN_MS = 600;
const SNOWBALL_SPEED = 24;
const SNOWBALL_LIFETIME = 1800;
const HIT_RADIUS = 1.2;

const PHASES = { LOBBY:'lobby', LIVE:'live', ENDED:'ended' };

// ---- State
const state = {
  phase: PHASES.LOBBY,
  players: new Map(), // id -> player
  snowballs: []
};

function randSpawn() {
  const a = Math.random() * Math.PI * 2;
  const r = ARENA_RADIUS * 0.7 * Math.random();
  return [Math.cos(a)*r, 0, Math.sin(a)*r];
}
function clampArena([x,y,z]) {
  const d = Math.hypot(x,z);
  return d > ARENA_RADIUS ? [x*ARENA_RADIUS/d, y, z*ARENA_RADIUS/d] : [x,y,z];
}

// ---- App / sockets
const app = express();
const server = http.createServer(app);
const io = new Server(server, { /* same-origin */ });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health + debug
app.get('/health', (_req,res)=>res.send('ok'));
app.get('/phase', (_req,res)=>{
  res.json({
    phase: state.phase,
    players: [...state.players.values()].map(p=>({id:p.id,name:p.name,alive:p.alive}))
  });
});

// Join: issue token and give client a redirect to /play.html
app.post('/join', (req,res)=>{
  const displayName = String((req.body?.displayName||'')).trim();
  if (!displayName) return res.status(400).json({ error: 'displayName required' });

  const token = jwt.sign({ displayName }, JWT_SECRET, { expiresIn: '10m' });
  const base  = `${req.protocol}://${req.get('host')}`;
  res.json({ ok:true, token, joinUrl: `${base}/play.html?token=${encodeURIComponent(token)}` });
});

// Sockets
io.on('connection', (socket)=>{
  let player = null;

  socket.on('auth:join', ({ token })=>{
    try {
      const { displayName } = jwt.verify(token, JWT_SECRET);
      const id = socket.id;
      const color = `hsl(${Math.floor(Math.random()*360)} 70% 55%)`;
      player = {
        id, name: displayName || 'Guest',
        color, pos: randSpawn(), yaw: 0,
        alive: true, lastThrow: 0,
        input: { fwd:false, back:false, left:false, right:false }
      };
      state.players.set(id, player);
      socket.emit('you:spawn', { id, name: player.name, color: player.color, pos: player.pos });

      // Force LIVE immediately for solo/dev
      state.phase = PHASES.LIVE;
      io.emit('world:state', snapshot());
    } catch (e) {
      socket.emit('error', { message: 'Invalid or expired token' });
      socket.disconnect();
    }
  });

  socket.on('input:state', (data)=>{
    if (!player || !player.alive) return;
    const { fwd, back, left, right, yaw } = data || {};
    player.input = { fwd:!!fwd, back:!!back, left:!!left, right:!!right };
    if (Number.isFinite(yaw)) player.yaw = yaw;
  });

  socket.on('action:throw', ({ dir })=>{
    if (!player || !player.alive) return;
    const now = Date.now();
    if (now - player.lastThrow < THROW_COOLDOWN_MS) return;
    player.lastThrow = now;

    const d = Array.isArray(dir) ? dir : [0,0,-1];
    const len = Math.hypot(d[0],d[1],d[2]) || 1;
    const n = [d[0]/len, d[1]/len, d[2]/len];
    state.snowballs.push({
      id: `${player.id}:${now}`,
      ownerId: player.id,
      pos: [player.pos[0], player.pos[1] + 1.0, player.pos[2]],
      vel: [n[0]*SNOWBALL_SPEED, n[1]*SNOWBALL_SPEED, n[2]*SNOWBALL_SPEED],
      bornAt: now
    });
  });

  socket.on('disconnect', ()=>{
    if (player) {
      state.players.delete(player.id);
      const alive = [...state.players.values()].filter(p=>p.alive);
      if (alive.length <= 1 && state.phase !== PHASES.LOBBY) {
        state.phase = PHASES.ENDED;
        setTimeout(resetMatch, 1500);
      }
    }
  });
});

// Physics
let lastTick = Date.now();
setInterval(()=>{
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTick)/1000);
  lastTick = now;

  if (state.phase === PHASES.LIVE) {
    for (const p of state.players.values()) {
      if (!p.alive) continue;
      let vx=0, vz=0;
      if (p.input.fwd)  vz -= 1;
      if (p.input.back) vz += 1;
      if (p.input.left) vx -= 1;
      if (p.input.right)vx += 1;
      const m = Math.hypot(vx,vz) || 1;
      p.pos[0] += (vx/m) * MOVE_SPEED * dt;
      p.pos[2] += (vz/m) * MOVE_SPEED * dt;
      p.pos = clampArena(p.pos);
    }
  }

  // snowballs
  state.snowballs = state.snowballs.filter(sb => now - sb.bornAt < SNOWBALL_LIFETIME);
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
    const alive = [...state.players.values()].filter(p=>p.alive);
    if (alive.length <= 1) {
      state.phase = PHASES.ENDED;
      io.emit('game:winner', { id: alive[0]?.id || null, name: alive[0]?.name || null });
      setTimeout(resetMatch, 1500);
    }
  }
}, 1000 / TICKRATE);

function snapshot() {
  const players = [...state.players.values()].map(p => ({
    id:p.id, name:p.name, color:p.color, pos:p.pos, yaw:p.yaw, alive:p.alive
  }));
  const snowballs = state.snowballs.map(s => ({ id:s.id, pos:s.pos }));
  return { phase: state.phase, players, snowballs, arena:{ radius: ARENA_RADIUS } };
}

setInterval(()=> io.emit('world:state', snapshot()), 1000 / SNAPSHOT_RATE);

function resetMatch() {
  state.phase = PHASES.LOBBY;
  state.snowballs.length = 0;
  for (const p of state.players.values()) {
    p.alive = true;
    p.pos = randSpawn();
    p.lastThrow = 0;
  }
}

server.listen(PORT, ()=> {
  console.log('Snowball listening on', PORT);
});
