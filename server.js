const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8000;
const clients = new Map();
const parties = new Map();
let nextId = 1;

const server = http.createServer((req, res) => {
  const file = req.url === '/' ? 'index.html' : req.url.slice(1);
  const safe = path.basename(file);
  const fullPath = path.join(__dirname, safe);
  fs.readFile(fullPath, (error, data) => {
    if (error) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const type = safe.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const send = (ws, data) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(data));

function publicParties() {
  return [...parties.values()]
    .filter(party => party.phase === 'lobby')
    .map(party => ({ id: party.id, name: party.name, difficulty: party.difficulty, count: party.members.size }));
}

function broadcastParties() {
  const message = JSON.stringify({ type: 'parties', parties: publicParties() });
  for (const ws of clients.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(message);
}

function partyMessage(party) {
  return {
    type: 'party',
    id: party.id,
    name: party.name,
    difficulty: party.difficulty,
    hostId: party.hostId,
    phase: party.phase,
    members: [...party.members.values()].map(member => ({ id: member.id, name: member.name }))
  };
}

function broadcast(party, data) {
  for (const member of party.members.values()) send(member.ws, data);
}

function leaveParty(client) {
  if (!client.partyId) return;
  const party = parties.get(client.partyId);
  client.partyId = null;
  if (!party) return;
  party.members.delete(client.id);
  if (!party.members.size) {
    parties.delete(party.id);
  } else {
    if (party.hostId === client.id) party.hostId = party.members.keys().next().value;
    if (party.phase === 'game') endGame(party, 'A player disconnected');
    broadcast(party, partyMessage(party));
  }
  broadcastParties();
}

function createParty(client, name, playerName, difficulty) {
  leaveParty(client);
  const cleanName = String(name || '').trim().slice(0, 24);
  const cleanPlayer = String(playerName || '').trim().slice(0, 16);
  if (!cleanName || !cleanPlayer) return send(client.ws, { type: 'error', message: 'Enter both names.' });
  const id = Math.random().toString(36).slice(2, 8).toUpperCase();
  const party = {
    id,
    name: cleanName,
    difficulty: difficulty === 'hard' ? 'hard' : 'normal',
    hostId: client.id,
    phase: 'lobby',
    members: new Map(),
    game: null
  };
  client.name = cleanPlayer;
  client.partyId = id;
  party.members.set(client.id, client);
  parties.set(id, party);
  send(client.ws, partyMessage(party));
  broadcastParties();
}

function joinParty(client, id, playerName) {
  const party = parties.get(String(id));
  const cleanPlayer = String(playerName || '').trim().slice(0, 16);
  if (!party || party.phase !== 'lobby') return send(client.ws, { type: 'error', message: 'That party is unavailable.' });
  if (!cleanPlayer) return send(client.ws, { type: 'error', message: 'Enter your player name.' });
  leaveParty(client);
  client.name = cleanPlayer;
  client.partyId = party.id;
  party.members.set(client.id, client);
  broadcast(party, partyMessage(party));
  broadcastParties();
}

function startGame(party) {
  const ids = [...party.members.keys()];
  if (ids.length < 3) return send(party.members.get(party.hostId).ws, { type: 'error', message: 'At least three players are required: one llama and two dodgers.' });
  const llamaId = ids[Math.floor(Math.random() * ids.length)];
  const jumpers = {};
  ids.filter(id => id !== llamaId).forEach((id, index, all) => {
    jumpers[id] = {
      id,
      name: party.members.get(id).name,
      x: 610 + (index - (all.length - 1) / 2) * 42,
      y: 306,
      vy: 0,
      alive: true,
      crouching: false,
      cooldown: 0,
      holdUntil: 0
    };
  });
  party.phase = 'game';
  party.game = {
    llamaId,
    jumpers,
    spits: [],
    aimY: 330,
    shootCooldown: 0,
    started: Date.now(),
    difficulty: party.difficulty,
    over: false
  };
  broadcast(party, {
    type: 'started',
    llamaId,
    roles: Object.fromEntries(ids.map(id => [id, id === llamaId ? 'llama' : 'jumper']))
  });
  broadcastParties();
}

function endGame(party, reason) {
  if (!party.game || party.game.over) return;
  party.game.over = true;
  const alive = Object.values(party.game.jumpers).filter(player => player.alive);
  const winner = alive.length === 1 ? alive[0].name : null;
  broadcast(party, { type: 'gameover', winner, reason });
  setTimeout(() => {
    if (!parties.has(party.id)) return;
    party.phase = 'lobby';
    party.game = null;
    broadcast(party, partyMessage(party));
    broadcastParties();
  }, 3000);
}

function action(client, data) {
  const party = parties.get(client.partyId);
  const game = party?.game;
  if (!game || game.over) return;
  const time = Date.now();
  if (client.id === game.llamaId) {
    if (data.action === 'aim') game.aimY = Math.max(255, Math.min(345, game.aimY + Number(data.amount || 0)));
    if (data.action === 'shoot' && time >= game.shootCooldown) {
      const startX = 185;
      const startY = 215;
      const vx = 400;
      const travel = (650 - startX) / vx;
      game.spits.push({ x: startX, y: startY, vx, vy: (game.aimY - startY) / travel, w: 15, h: 10 });
      game.shootCooldown = time + (game.difficulty === 'hard' ? 1100 : 2000);
    }
  } else {
    const player = game.jumpers[client.id];
    if (player?.alive && data.action === 'jump' && time >= player.cooldown && player.y >= 306) {
      player.vy = -310;
      player.crouching = false;
      player.cooldown = time + 2000;
      player.holdUntil = time + 320;
    }
    if (player && data.action === 'release') player.holdUntil = 0;
    if (player?.alive && data.action === 'crouch') player.crouching = Boolean(data.active) && player.y >= 306;
  }
}

wss.on('connection', ws => {
  const client = { id: String(nextId++), ws, name: '', partyId: null };
  clients.set(ws, client);
  send(ws, { type: 'welcome', id: client.id, parties: publicParties() });
  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (data.type === 'create') createParty(client, data.partyName, data.playerName, data.difficulty);
    if (data.type === 'join') joinParty(client, data.partyId, data.playerName);
    if (data.type === 'start') {
      const party = parties.get(client.partyId);
      if (party && party.hostId === client.id && party.phase === 'lobby') startGame(party);
    }
    if (data.type === 'action') action(client, data);
  });
  ws.on('close', () => {
    leaveParty(client);
    clients.delete(ws);
  });
});

let previous = Date.now();
setInterval(() => {
  const time = Date.now();
  const dt = Math.min(0.05, (time - previous) / 1000);
  previous = time;
  for (const party of parties.values()) {
    const game = party.game;
    if (party.phase !== 'game' || !game || game.over) continue;
    for (const player of Object.values(game.jumpers)) {
      if (!player.alive) continue;
      if (time < player.holdUntil && player.vy < 0) player.vy -= 520 * dt;
      player.vy += 900 * dt;
      player.y += player.vy * dt;
      if (player.y > 306) { player.y = 306; player.vy = 0; }
      if (player.y < 306) player.crouching = false;
    }
    for (const spit of game.spits) {
      spit.x += spit.vx * dt;
      spit.y += spit.vy * dt;
      for (const player of Object.values(game.jumpers)) {
        if (!player.alive) continue;
        const hitY = player.crouching ? 336 : player.y;
        const hitHeight = player.crouching ? 34 : 64;
        if (spit.x < player.x + 38 && spit.x + spit.w > player.x && spit.y < hitY + hitHeight && spit.y + spit.h > hitY) {
          player.alive = false;
          const survivors = Object.values(game.jumpers).filter(jumper => jumper.alive);
          if (survivors.length === 1) {
            endGame(party, 'Last dodger alive');
            break;
          }
        }
      }
      if (game.over) break;
    }
    game.spits = game.spits.filter(spit => spit.x < 830);
    if (game.over) continue;
    broadcast(party, {
      type: 'snapshot',
      llamaId: game.llamaId,
      llamaName: party.members.get(game.llamaId)?.name || 'Llama',
      jumpers: Object.values(game.jumpers),
      spits: game.spits,
      aimY: game.aimY,
      llamaCooldown: Math.max(0, game.shootCooldown - time)
    });
  }
}, 1000 / 30);

server.listen(PORT, () => console.log(`Llama Spit Dodge: http://localhost:${PORT}`));
