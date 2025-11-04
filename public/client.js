
import * as THREE from 'https://unpkg.com/three@0.157.0/build/three.module.js';

const socket = io();
const qs = new URLSearchParams(location.search);
const token = qs.get('token');
const statusEl = document.getElementById('status');

if (!token) {
  statusEl.textContent = 'Missing token. Open via QR link.';
} else {
  socket.emit('auth:join', { token });
}

let meId = null;
let phase = 'lobby';

socket.on('you:spawn', (data) => {
  meId = data.id;
  statusEl.textContent = 'Joined! Waiting for match…';
});

socket.on('error', ({ message }) => {
  statusEl.textContent = 'Error: ' + message;
});

// --- Three.js scene
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xd7ecff, 30, 90);
const camera = new THREE.PerspectiveCamera(70, innerWidth/innerHeight, 0.1, 200);

const hemi = new THREE.HemisphereLight(0xffffff, 0x88aaff, 0.8);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(10,20,10);
scene.add(dir);

// Arena
const groundGeo = new THREE.CircleGeometry(25, 64);
const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI/2;
scene.add(ground);

// Pools
const playerMeshes = new Map();
const snowballMeshes = new Map();

function makeNameSprite(text) {
  const fontSize = 48;
  const padding = 12;
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
  const scale = 0.015;
  sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
  return sprite;
}

function getPlayerMesh(id, color, labelText = 'Player') {
  if (playerMeshes.has(id)) return playerMeshes.get(id);

  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.0, flatShading: true });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 12, 10), bodyMat);
  head.position.y = 1.1;
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 10), bodyMat);
  torso.position.y = 0.6;
  const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.6, 6), bodyMat);
  legL.position.set(-0.2, 0.3, 0);
  const legR = legL.clone(); legR.position.x = 0.2;

  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.35, 8), new THREE.MeshStandardMaterial({ color: 0x224488, roughness: 0.6, flatShading: true }));
  hat.position.y = 1.45;

  const nameSprite = makeNameSprite(labelText);
  nameSprite.position.set(0, 1.9, 0);

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
  const geo = new THREE.SphereGeometry(0.25, 12, 10);
  const mat = new THREE.MeshStandardMaterial({ color: 0xe6f2ff });
  const m = new THREE.Mesh(geo, mat);
  scene.add(m);
  snowballMeshes.set(id, m);
  return m;
}

// Input
const keys = new Set();
window.addEventListener('keydown', e => keys.add(e.code));
window.addEventListener('keyup',   e => keys.delete(e.code));

let yaw = 0;
let pitch = 0;
let pointerLocked = false;
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
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let snapshot = { players: [], snowballs: [], arena:{ radius: 25 }, countdown: 0 };
socket.on('world:state', (s) => {
  phase = s.phase;
  snapshot = s;
  if (phase === 'countdown') statusEl.textContent = `Starting in ${s.countdown}…`;
  else if (phase === 'live') statusEl.textContent = `Fight! Players alive: ${s.players.filter(p=>p.alive).length}`;
  else if (phase === 'lobby') statusEl.textContent = 'Lobby… waiting for players';
});

socket.on('game:winner', ({ id, name }) => {
  statusEl.textContent = name ? `Winner: ${name}` : (id ? `Winner: ${id}` : 'No winner');
});

socket.on('game:eliminated', ({ id }) => {
  if (id === meId) statusEl.textContent = 'You were hit! 🥶';
});

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

function animate() {
  requestAnimationFrame(animate);

  const seenPlayers = new Set();
  for (const p of snapshot.players) {
    const label = p.name || p.id;
    let mesh = getPlayerMesh(p.id, p.color, label);
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
