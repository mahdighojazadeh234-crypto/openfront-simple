const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, '../public')));

const PORT = process.env.PORT || 3000;

// ==================== GAME CONSTANTS ====================
const TICK_RATE = 500; // ms
const TROOP_GROWTH_BASE = 2;
const CITY_GROWTH_BONUS = 8;
const FACTORY_GOLD_PER_TICK = 3;
const CITY_COST = 50;
const FACTORY_COST = 80;
const MAX_PLAYERS = 10;
const MAX_BOTS = 18;
const ATTACK_RATIO_DEFAULT = 0.5;

// Simple color palette for players
const PLAYER_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#34495e', '#e91e63', '#00bcd4',
  '#8bc34a', '#ff5722', '#607d8b', '#795548', '#ff9800',
  '#3f51b5', '#009688', '#cddc39', '#ffc107', '#673ab7'
];

// ==================== MAPS ====================
// 0 = water, 1 = land
const MAPS = {
  islands: {
    name: 'جزایر',
    width: 40,
    height: 30,
    data: null // will generate
  },
  iran: {
    name: 'ایران',
    width: 36,
    height: 28,
    data: null
  },
  world: {
    name: 'جهان ساده',
    width: 48,
    height: 28,
    data: null
  }
};

// Generate simple island cluster map
function generateIslandsMap(w, h) {
  const map = Array(h).fill(null).map(() => Array(w).fill(0));
  
  // Create 5-6 islands
  const islands = [
    {cx: 8, cy: 8, r: 5},
    {cx: 20, cy: 7, r: 4},
    {cx: 32, cy: 10, r: 5},
    {cx: 12, cy: 20, r: 4},
    {cx: 26, cy: 22, r: 5},
    {cx: 38, cy: 20, r: 3}
  ];
  
  for (const isl of islands) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dist = Math.sqrt((x - isl.cx)**2 + (y - isl.cy)**2);
        if (dist < isl.r + (Math.random() * 1.5 - 0.5)) {
          map[y][x] = 1;
        }
      }
    }
  }
  return map;
}

// Very simplified Iran-ish shape (rough rectangle with some cuts)
function generateIranMap(w, h) {
  const map = Array(h).fill(null).map(() => Array(w).fill(0));
  for (let y = 4; y < h - 3; y++) {
    for (let x = 4; x < w - 3; x++) {
      // Rough shape
      if (y > 6 && y < h - 5 && x > 5 && x < w - 4) {
        map[y][x] = 1;
      }
      // Add some noise / mountains feel by removing some
      if (Math.random() < 0.08) map[y][x] = 0;
    }
  }
  // Make borders more organic
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (map[y][x] === 1) {
        const edge = (x < 6 || x > w-6 || y < 6 || y > h-6);
        if (edge && Math.random() < 0.4) map[y][x] = 0;
      }
    }
  }
  return map;
}

// Super simplified world (continents blobs)
function generateWorldMap(w, h) {
  const map = Array(h).fill(null).map(() => Array(w).fill(0));
  const continents = [
    {cx: 10, cy: 10, r: 7},   // Americas-ish
    {cx: 12, cy: 20, r: 5},
    {cx: 28, cy: 8, r: 6},    // Europe/Africa
    {cx: 30, cy: 18, r: 7},
    {cx: 42, cy: 12, r: 6},   // Asia
    {cx: 40, cy: 22, r: 4}
  ];
  for (const c of continents) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dist = Math.sqrt((x - c.cx)**2 + (y - c.cy)**2);
        if (dist < c.r + (Math.random()*1.2 - 0.3)) {
          map[y][x] = 1;
        }
      }
    }
  }
  return map;
}

MAPS.islands.data = generateIslandsMap(MAPS.islands.width, MAPS.islands.height);
MAPS.iran.data = generateIranMap(MAPS.iran.width, MAPS.iran.height);
MAPS.world.data = generateWorldMap(MAPS.world.width, MAPS.world.height);

// ==================== GAME STATE ====================
const rooms = new Map(); // roomCode -> GameRoom

function createRoom(mapKey = 'islands') {
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const map = MAPS[mapKey] || MAPS.islands;
  
  const room = {
    code,
    mapKey,
    width: map.width,
    height: map.height,
    landMap: map.data, // 0 water 1 land
    tiles: [], // ownership and troops: {owner: null|playerId, troops: 0, building: null|'city'|'factory'}
    players: new Map(), // socketId -> player
    bots: [],
    started: false,
    tick: 0,
    hostId: null,
    maxPlayers: MAX_PLAYERS,
    botCount: 8
  };
  
  // Init tiles
  for (let y = 0; y < room.height; y++) {
    room.tiles[y] = [];
    for (let x = 0; x < room.width; x++) {
      room.tiles[y][x] = {
        owner: null,
        troops: 0,
        building: null
      };
    }
  }
  
  rooms.set(code, room);
  return room;
}

function getLandTiles(room) {
  const lands = [];
  for (let y = 0; y < room.height; y++) {
    for (let x = 0; x < room.width; x++) {
      if (room.landMap[y][x] === 1) {
        lands.push({x, y});
      }
    }
  }
  return lands;
}

function spawnPlayer(room, playerId, isBot = false, name = null) {
  const lands = getLandTiles(room).filter(t => room.tiles[t.y][t.x].owner === null);
  if (lands.length === 0) return false;
  
  // Pick random empty land
  const spawn = lands[Math.floor(Math.random() * lands.length)];
  const colorIndex = room.players.size + room.bots.length;
  
  const player = {
    id: playerId,
    name: name || (isBot ? `ربات ${room.bots.length + 1}` : `بازیکن`),
    color: PLAYER_COLORS[colorIndex % PLAYER_COLORS.length],
    gold: 30,
    isBot,
    alive: true,
    troops: 20,
    cities: 0,
    factories: 0
  };
  
  room.tiles[spawn.y][spawn.x].owner = playerId;
  room.tiles[spawn.y][spawn.x].troops = 20;
  
  if (isBot) {
    room.bots.push(player);
  } else {
    room.players.set(playerId, player);
  }
  return true;
}

function getPlayer(room, id) {
  if (room.players.has(id)) return room.players.get(id);
  return room.bots.find(b => b.id === id) || null;
}

function countPlayerTiles(room, playerId) {
  let count = 0;
  let troops = 0;
  for (let y = 0; y < room.height; y++) {
    for (let x = 0; x < room.width; x++) {
      if (room.tiles[y][x].owner === playerId) {
        count++;
        troops += room.tiles[y][x].troops;
      }
    }
  }
  return {tiles: count, troops};
}

function isAdjacent(x1, y1, x2, y2) {
  return Math.abs(x1 - x2) + Math.abs(y1 - y2) === 1;
}

function getAdjacentEnemyOrEmpty(room, x, y, myId) {
  const dirs = [[0,1],[0,-1],[1,0],[-1,0]];
  const result = [];
  for (const [dx, dy] of dirs) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= room.width || ny >= room.height) continue;
    if (room.landMap[ny][nx] !== 1) continue;
    const tile = room.tiles[ny][nx];
    if (tile.owner !== myId) {
      result.push({x: nx, y: ny, owner: tile.owner, troops: tile.troops});
    }
  }
  return result;
}

// ==================== GAME LOGIC ====================
function processAttack(room, playerId, fromX, fromY, toX, toY, ratio = ATTACK_RATIO_DEFAULT) {
  const player = getPlayer(room, playerId);
  if (!player || !player.alive) return {ok: false, msg: 'بازیکن معتبر نیست'};
  
  const from = room.tiles[fromY]?.[fromX];
  const to = room.tiles[toY]?.[toX];
  if (!from || !to) return {ok: false, msg: 'کاشی نامعتبر'};
  if (from.owner !== playerId) return {ok: false, msg: 'این سرزمین مال شما نیست'};
  if (room.landMap[toY][toX] !== 1) return {ok: false, msg: 'آب است'};
  if (!isAdjacent(fromX, fromY, toX, toY)) return {ok: false, msg: 'مجاور نیست'};
  
  const attackTroops = Math.floor(from.troops * ratio);
  if (attackTroops < 1) return {ok: false, msg: 'نیروی کافی ندارید'};
  
  from.troops -= attackTroops;
  
  if (to.owner === null) {
    // Claim empty
    to.owner = playerId;
    to.troops = attackTroops;
    return {ok: true};
  }
  
  if (to.owner === playerId) {
    // Reinforce
    to.troops += attackTroops;
    return {ok: true};
  }
  
  // Combat: simple
  const defense = to.troops;
  if (attackTroops > defense) {
    // Conquer
    const remaining = attackTroops - defense;
    const oldOwner = to.owner;
    to.owner = playerId;
    to.troops = remaining;
    
    // Check if old owner is eliminated
    const stats = countPlayerTiles(room, oldOwner);
    if (stats.tiles === 0) {
      const loser = getPlayer(room, oldOwner);
      if (loser) loser.alive = false;
    }
  } else {
    // Fail, reduce defense
    to.troops = Math.max(0, defense - Math.floor(attackTroops * 0.7));
    // Attackers mostly die
  }
  return {ok: true};
}

function processBuild(room, playerId, x, y, type) {
  const player = getPlayer(room, playerId);
  if (!player || !player.alive) return {ok: false, msg: 'بازیکن معتبر نیست'};
  
  const tile = room.tiles[y]?.[x];
  if (!tile || tile.owner !== playerId) return {ok: false, msg: 'این سرزمین مال شما نیست'};
  if (tile.building) return {ok: false, msg: 'قبلاً ساختمان دارد'};
  
  const cost = type === 'city' ? CITY_COST : FACTORY_COST;
  if (player.gold < cost) return {ok: false, msg: 'طلای کافی ندارید'};
  
  player.gold -= cost;
  tile.building = type;
  if (type === 'city') player.cities++;
  if (type === 'factory') player.factories++;
  
  return {ok: true};
}

function gameTick(room) {
  room.tick++;
  
  // Growth and income
  for (let y = 0; y < room.height; y++) {
    for (let x = 0; x < room.width; x++) {
      const tile = room.tiles[y][x];
      if (!tile.owner) continue;
      
      const player = getPlayer(room, tile.owner);
      if (!player || !player.alive) continue;
      
      // Troop growth
      let growth = TROOP_GROWTH_BASE;
      if (tile.building === 'city') growth += CITY_GROWTH_BONUS;
      tile.troops += growth;
      
      // Cap troops roughly
      const maxTroops = 200 + (player.cities * 80);
      if (tile.troops > maxTroops) tile.troops = maxTroops;
      
      // Factory gold
      if (tile.building === 'factory') {
        player.gold += FACTORY_GOLD_PER_TICK;
      }
    }
  }
  
  // Small passive gold
  for (const p of room.players.values()) {
    if (p.alive) p.gold += 1;
  }
  for (const b of room.bots) {
    if (b.alive) b.gold += 1;
  }
  
  // Bot AI (simple)
  if (room.tick % 3 === 0) {
    for (const bot of room.bots) {
      if (!bot.alive) continue;
      botAI(room, bot);
    }
  }
  
  // Win check (optional simple: most land after long time, or last standing)
  // For now just keep going
}

function botAI(room, bot) {
  // Find owned tiles
  const myTiles = [];
  for (let y = 0; y < room.height; y++) {
    for (let x = 0; x < room.width; x++) {
      if (room.tiles[y][x].owner === bot.id) {
        myTiles.push({x, y, troops: room.tiles[y][x].troops, building: room.tiles[y][x].building});
      }
    }
  }
  if (myTiles.length === 0) {
    bot.alive = false;
    return;
  }
  
  // Try build if rich
  if (bot.gold >= CITY_COST && Math.random() < 0.3) {
    const candidates = myTiles.filter(t => !t.building && t.troops > 15);
    if (candidates.length > 0) {
      const t = candidates[Math.floor(Math.random() * candidates.length)];
      const type = bot.gold >= FACTORY_COST && Math.random() < 0.4 ? 'factory' : 'city';
      processBuild(room, bot.id, t.x, t.y, type);
    }
  }
  
  // Attack
  for (const t of myTiles) {
    if (t.troops < 8) continue;
    const targets = getAdjacentEnemyOrEmpty(room, t.x, t.y, bot.id);
    if (targets.length === 0) continue;
    
    // Prefer empty or weak
    targets.sort((a, b) => (a.troops || 0) - (b.troops || 0));
    const target = targets[0];
    if (target.troops < t.troops * 0.8 || target.owner === null) {
      processAttack(room, bot.id, t.x, t.y, target.x, target.y, 0.6);
      break; // one attack per bot per AI tick
    }
  }
}

function getPublicState(room) {
  // Compact state for clients
  const players = [];
  for (const p of room.players.values()) {
    const stats = countPlayerTiles(room, p.id);
    players.push({
      id: p.id,
      name: p.name,
      color: p.color,
      gold: p.gold,
      alive: p.alive,
      tiles: stats.tiles,
      troops: stats.troops,
      cities: p.cities,
      factories: p.factories,
      isBot: false
    });
  }
  for (const b of room.bots) {
    const stats = countPlayerTiles(room, b.id);
    players.push({
      id: b.id,
      name: b.name,
      color: b.color,
      gold: b.gold,
      alive: b.alive,
      tiles: stats.tiles,
      troops: stats.troops,
      cities: b.cities,
      factories: b.factories,
      isBot: true
    });
  }
  
  // Tiles as flat array for efficiency: ownerIndex or -1, troops, building
  // To keep small, send only owned or we send full for small maps
  const tileData = [];
  for (let y = 0; y < room.height; y++) {
    for (let x = 0; x < room.width; x++) {
      const t = room.tiles[y][x];
      tileData.push({
        o: t.owner, // null or id
        t: t.troops,
        b: t.building
      });
    }
  }
  
  return {
    code: room.code,
    mapKey: room.mapKey,
    width: room.width,
    height: room.height,
    landMap: room.landMap,
    tiles: tileData,
    players,
    started: room.started,
    tick: room.tick
  };
}

// ==================== SOCKET HANDLERS ====================
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  
  socket.on('createRoom', ({name, mapKey, botCount}) => {
    const room = createRoom(mapKey || 'islands');
    room.hostId = socket.id;
    room.botCount = Math.min(MAX_BOTS, Math.max(0, botCount || 8));
    
    const playerName = name || 'میزبان';
    spawnPlayer(room, socket.id, false, playerName);
    socket.join(room.code);
    socket.roomCode = room.code;
    
    socket.emit('roomCreated', {code: room.code, state: getPublicState(room)});
  });
  
  socket.on('joinRoom', ({code, name}) => {
    code = (code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      socket.emit('error', {msg: 'اتاق پیدا نشد'});
      return;
    }
    if (room.started) {
      socket.emit('error', {msg: 'بازی شروع شده'});
      return;
    }
    if (room.players.size >= MAX_PLAYERS) {
      socket.emit('error', {msg: 'اتاق پر است'});
      return;
    }
    
    const playerName = name || `بازیکن ${room.players.size + 1}`;
    const ok = spawnPlayer(room, socket.id, false, playerName);
    if (!ok) {
      socket.emit('error', {msg: 'جا برای اسپان نیست'});
      return;
    }
    
    socket.join(code);
    socket.roomCode = code;
    
    io.to(code).emit('stateUpdate', getPublicState(room));
    socket.emit('joined', {code, state: getPublicState(room)});
  });
  
  socket.on('startGame', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id || room.started) return;
    
    // Spawn bots
    for (let i = 0; i < room.botCount; i++) {
      const botId = 'bot_' + uuidv4().slice(0, 8);
      spawnPlayer(room, botId, true);
    }
    
    room.started = true;
    io.to(room.code).emit('gameStarted', getPublicState(room));
    
    // Start tick loop
    room.interval = setInterval(() => {
      if (!rooms.has(room.code)) {
        clearInterval(room.interval);
        return;
      }
      gameTick(room);
      io.to(room.code).emit('stateUpdate', getPublicState(room));
    }, TICK_RATE);
  });
  
  socket.on('attack', ({fromX, fromY, toX, toY, ratio}) => {
    const room = rooms.get(socket.roomCode);
    if (!room || !room.started) return;
    const res = processAttack(room, socket.id, fromX, fromY, toX, toY, ratio || 0.5);
    if (res.ok) {
      io.to(room.code).emit('stateUpdate', getPublicState(room));
    } else {
      socket.emit('error', {msg: res.msg});
    }
  });
  
  socket.on('build', ({x, y, type}) => {
    const room = rooms.get(socket.roomCode);
    if (!room || !room.started) return;
    const res = processBuild(room, socket.id, x, y, type);
    if (res.ok) {
      io.to(room.code).emit('stateUpdate', getPublicState(room));
    } else {
      socket.emit('error', {msg: res.msg});
    }
  });
  
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    
    const player = room.players.get(socket.id);
    if (player) {
      // Mark tiles as neutral or leave them (simple: leave owned but player gone)
      player.alive = false;
      room.players.delete(socket.id);
    }
    
    if (room.players.size === 0) {
      // Cleanup
      if (room.interval) clearInterval(room.interval);
      rooms.delete(code);
    } else {
      io.to(code).emit('stateUpdate', getPublicState(room));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});