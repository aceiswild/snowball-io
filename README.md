
# Snowball‑IO (starter)

Minimal Socket.IO + Three.js snowball battle:
- Scan a QR → join a match.
- WASD to move, click to throw.
- One hit = out; last player wins.

## Quick start
1) `cp .env.example .env` and set `JWT_SECRET` (and optionally `PUBLIC_BASE_URL`).
2) `npm install`
3) `npm run dev`
4) Open http://localhost:3000 — enter an Employee ID and (optional) Display Name to generate a QR.
5) Scan the QR to join from a phone/tab.

## Deploy on Render
- Start command: `node server.js`
- Env: `JWT_SECRET`, `PUBLIC_BASE_URL=https://snowball.yourdomain.com`
- (Optional) `CORS_ORIGINS=https://snowball.yourdomain.com`

## Files
- server.js : Node/Express/Socket.IO game server + QR issuer
- public/index.html : host page to generate QRs
- public/play.html  : game client
- public/client.js  : Three.js client (procedural 3D player + name labels)
