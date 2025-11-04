import * as THREE from 'https://unpkg.com/three@0.157.0/build/three.module.js';

// ---- SOCKET: Path B (HostGator page -> Render server) ----
const socket = io('https://snowball-dian.onrender.com', {
  withCredentials: true,
  transports: ['polling', 'websocket']
});

const qs = new URLSearchParams(location.search);
const token = qs.get('token');
const statusEl = document.getElementById('status');
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS || 1); // set 1 for solo dev


if (!token) statusEl.textContent = 'Missing token. Open via QR link.';

// ---- Three.js scene ----
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.setClearColor(0xd7ecff, 1);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

// --- Canvas Bodyguard (SINGLE BLOCK, no duplicates) ---
const cvs = renderer.domElement;
Object.assign(cvs.style, {
  position: 'fixed',
  inset: '0',
  width: '100%',
  height: '100%',
  display: 'block',
  zIndex: '2147483647',   // keep canvas on top
  background: '#d7ecff'
});
document.body.style.background = '#d7ecff';

cvs.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  console.warn('WebGL context lost');
  statusEl.textContent = 'Graphics context lost. Trying to recover…';
});
cvs.addEventListener('webglcontextrestored', () => {
  console.warn('WebGL context restored');
  statusEl.textContent = 'Graphics context restored.';
});

// ---- Scene / Camera / Lights ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd7ecff);
scene.fog = new THREE.Fog(0xd7ecff, 30, 90);

const camera = new THREE.PerspectiveCamera(70, innerWidth/innerHeight, 0.1, 200);
camera.position.set(0, 3, 8);
camera.lookAt(0, 0, 0);

const hemi = new THREE.HemisphereLight(0xffffff, 0x88aaff, 0.9);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(10, 20, 10);
scene.add(dir);

// ---- Ground + Grid + Test Cube ----
const groundGeo = new THREE.CircleGeometry(25, 64);
const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI/2;
scene.add(ground);

const grid = new THREE.GridHelper(60, 30, 0x88aaff, 0xbbccff);
grid.position.y = 0.001;
scene.add(grid);

const testCube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshNormalMaterial()
);
testCube.position.set(0, 1.2, 0);
scene.add(testCube);

// ---- Socket lifecycle + auth ----
socket.on('connect', () => {
  console.log('socket connected', socket.id);
  statusEl.textContent = 'Connected! Authenticating…';
  if (token) socket.emit('auth:join', { token });
});
socket.on('connect_error', (err) => {
  console.error('connect_error', err);
  statusEl.textContent = 'Connect error: ' + (err?.message || err);
});
socket.on('disconnect', (reason) => {
  console.warn('socket disconnected', reason);
  statusEl.textContent = 'Disconnected: ' + reason;
});
socket.io.engine.on('transport', (t) => console.log('transport', t.name));

// ---- Pools ----
const playerMeshes = new Map();
const snowballMeshes = new Map();

function makeNameSprite(text) {
  const fontSize = 48, padding = 12;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
  const textW = ctx.measureText(text).width;
  canvas.width  = Math.ceil(textW + padding * 2);
  canvas.height = Math.ceil(fontSize + padding * 2);

  ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 4;
  const r = 16, w = canvas.width, h = canvas.height;
  ctx.beginPath();
  ctx.moveTo(r,0); ctx.lineTo(w-r,0); ctx.quadraticCurveTo(w,0,w,r);
  ctx.lineTo(w,h-r); ctx.quadraticCurveTo(w,h,w-r,h);
  ctx.lineTo(r,h); ctx.quadraticCurveTo(0,h,0,h-r);
  ctx.lineTo(0,r); ctx.quadraticCurveTo(0,0,r,0); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'white';
  ctx.fillText(text, padding, padding);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(canvas.width * 0.015, canvas.height * 0.015, 1);
  return sprite;
}

function getPlayerMesh(id, color, labelText = 'Player') {
  if (playerMeshes.has(id)) return playerMeshes.get(id);

  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.0, flatShading: true });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 12, 10), bodyMat); head.position.y = 1.1;
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 10), bodyMat); torso.position.y = 0.6;
  const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.6, 6), bodyMat); legL.position.set(-0.2, 0.3, 0);
  const legR = legL.clone(); legR.position.x = 0.2;
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.35, 8), new THREE.MeshStandardMaterial({ color: 0x224488, roughness: 0.6, flatShading: true })); hat.position.y = 1.45;
  const nameSprite = makeNameSprite(labelText); nameSprite.position.set(0, 1.9, 0);
  group.add(torso, head, legL, legR, hat, nameSprite);
  scene.add(group);
  playerMeshes.set(id, group);
  return group;
}

function removePlayerMesh(id) {
  const m = playerMeshes.get(id);
  if (m) { scene.remove(m); m.traverse((o)=>{ if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose?.(); }); }
  playerMeshes.delete(id);
}

function getSnowballMesh(id) {
  if (snowballMeshes.has(id)) return snowballMeshes.get(id);
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 10), new THREE.MeshStandardMaterial({ color: 0xe6f2ff }));
  scene.add(m);
  snowballMeshes.set(id, m);
  return m;
}

// ---- Input ----
const keys = new Set();
window.addEventListener('keydown', e => keys.add(e.code));
window.addEventListener('keyup',   e => keys.delete(e.code));

let yaw = 0, pitch = 0, pointerLocked = false;
document.body.addEventListener('click', () => {
  if (!pointerLocked && renderer.domElement.requestPointerLock) {
    renderer.domElement.requestPointerLock();
  } else {
    const dir = new THREE.Vector3(0,0,-1).applyEuler(new THREE.Euler(pitch, yaw, 0));
    socket.emit('action:throw', { dir: [dir.x, dir.y, dir.z] });
  }
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
});
document.addEventListener('mousemove', e => {
  if (!pointerLocked) return;
  yaw   -= e.movementX * 0.003;
  pitch -= e.movementY * 0.003;
  pitch = Math.max(-1.0, Math.min(0.8, pitch));
});

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
});

// ---- Networked world state ----
let phase = 'lobby';
let snapshot = { players: [], snowballs: [], arena:{ radius: 25 }, countdown: 0 };
let firstState = true;

socket.on('world:state', (s) => {
  if (firstState) { console.log('first world state:', s); firstState = false; }
  phase = s.phase;
  snapshot = s;
  if (phase === 'countdown') statusEl.textContent = `Starting in ${s.countdown}…`;
  else if (phase === 'live') statusEl.textContent = `Fight! Players alive: ${s.players.filter(p=>p.alive).length}`;
  else if (phase === 'lobby') statusEl.textContent = 'Lobby… waiting for players';
});

let meId = null;
socket.on('you:spawn', (data) => {
  meId = data.id;
  statusEl.textContent = 'Joined! Waiting for match…';
  const spawn = data.pos || [0, 0, 0];
  const behind = new THREE.Vector3(0, 2.5, 6);
  camera.position.set(spawn[0] + behind.x, spawn[1] + behind.y, spawn[2] + behind.z);
  camera.lookAt(spawn[0], spawn[1], spawn[2]);
});

socket.on('game:winner', ({ id, name }) => {
  statusEl.textContent = name ? `Winner: ${name}` : (id ? `Winner: ${id}` : 'No winner');
});
socket.on('game:eliminated', ({ id }) => { if (id === meId) statusEl.textContent = 'You were hit! 🥶'; });
socket.on('error', ({ message }) => { statusEl.textContent = 'Error: ' + message; });

// ---- Send inputs periodically ----
setInterval(() => {
  const input = {
    fwd:  keys.has('KeyW') || keys.has('ArrowUp'),
    back: keys.has('KeyS') || keys.has('ArrowDown'),
    left: keys.has('KeyA') || keys.has('ArrowLeft'),
    right:keys.has('KeyD') || keys.has('ArrowRight'),
    yaw
  };
  socket.emit('input:state', input);
}, 50);

// ---- Render loop ----
function animate() {
  requestAnimationFrame(animate);

  // Rotate test cube so we know rendering works
  testCube.rotation.y += 0.02;
  testCube.rotation.x += 0.01;

  const seenPlayers = new Set();
  for (const p of snapshot.players) {
    const label = p.name || p.id;
    const mesh = getPlayerMesh(p.id, p.color, label);
    mesh.position.set(p.pos[0], 0, p.pos[2]);
    mesh.visible = p.alive;
    seenPlayers.add(p.id);

    if (p.id === meId) {
      const behind = new THREE.Vector3(0, 2.5, 6).applyEuler(new THREE.Euler(0, yaw, 0));
      camera.position.set(mesh.position.x + behind.x, mesh.position.y + behind.y, mesh.position.z + behind.z);
      camera.lookAt(mesh.position.x, mesh.position.y, mesh.position.z);
    }
  }
  for (const [id] of playerMeshes) if (!seenPlayers.has(id)) removePlayerMesh(id);

  const seenSnow = new Set();
  for (const s of snapshot.snowballs) {
    const m = getSnowballMesh(s.id);
    m.position.set(s.pos[0], s.pos[1], s.pos[2]);
    seenSnow.add(s.id);
  }
  for (const [id, m] of snowballMeshes) {
    if (!seenSnow.has(id)) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); snowballMeshes.delete(id); }
  }

  renderer.render(scene, camera);
}
animate();
