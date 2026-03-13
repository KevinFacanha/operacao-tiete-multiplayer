const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 8080;
const TICK_RATE = 30;
const TICK_MS = 1000 / TICK_RATE;
const DT = 1 / TICK_RATE;

const LIMIT = 10;
const SPEED = 6;
const PLAYER_MAX_HP = 20;
const SENSOR_MAX_HP = 100;
const BOT_ATTACK_RANGE = 1.0;
const BOT_HIT_RADIUS = 1.1;
const PROJECTILE_SPEED = 12;
const PROJECTILE_TTL = 1.2;
const PROJECTILE_DAMAGE = 2;
const REPAIR_RANGE = 2.2;
const REPAIR_RATE = 12;
const REPAIR_SPEED_MULT = 0.6;
const INTERMISSION_MS = 2500;

const PHASE_CONFIGS = {
  1: {
    level: 1,
    mapId: 1,
    timeLimitSec: 90,
    spawnEverySec: 1.4,
    totalBots: 20,
    maxAlive: 10,
    botHp: 2,
    botDps: 4.5,
  },
  2: {
    level: 2,
    mapId: 2,
    timeLimitSec: 90,
    spawnEverySec: 1.1,
    totalBots: 40,
    maxAlive: 14,
    botHp: 4,
    botDps: 10,
  },
  3: {
    level: 3,
    mapId: 3,
    timeLimitSec: 75,
    spawnEverySec: 0.85,
    totalBots: 60,
    maxAlive: 18,
    botHp: 5,
    botDps: 12,
  },
};

const SENSOR_LAYOUTS = {
  1: [
    { id: "s1", x: -7.5, z: -7.5 },
    { id: "s2", x: -6.3, z: 1.2 },
    { id: "s3", x: -7.4, z: 7.4 },
    { id: "s4", x: 7.1, z: -5.2 },
    { id: "s5", x: 6.3, z: 5.8 },
  ],
  2: [
    { id: "s1", x: -8.0, z: -8.5 },
    { id: "s2", x: -6.4, z: -0.4 },
    { id: "s3", x: -7.2, z: 8.2 },
    { id: "s4", x: 7.0, z: -7.2 },
    { id: "s5", x: 6.0, z: 6.8 },
  ],
  3: [
    { id: "s1", x: -8.3, z: -6.3 },
    { id: "s2", x: -6.0, z: -1.3 },
    { id: "s3", x: -7.5, z: 6.3 },
    { id: "s4", x: 7.7, z: -3.8 },
    { id: "s5", x: 6.3, z: 4.9 },
  ],
};

const rooms = new Map();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalize2D(x, z) {
  const length = Math.hypot(x, z);
  if (length <= 0.00001) {
    return null;
  }
  return { x: x / length, z: z / length };
}

function parsePhaseLevel(rawPhase) {
  const parsed = Number(rawPhase);
  if (parsed === 2 || parsed === 3) {
    return parsed;
  }
  return 1;
}

function getPhaseConfig(level) {
  return { ...PHASE_CONFIGS[level] };
}

function createSensorsForMap(mapId) {
  const layout = SENSOR_LAYOUTS[mapId] || SENSOR_LAYOUTS[1];
  const sensors = {};

  for (const sensor of layout) {
    sensors[sensor.id] = {
      x: sensor.x,
      z: sensor.z,
      hp: SENSOR_MAX_HP,
      maxHp: SENSOR_MAX_HP,
    };
  }

  return sensors;
}

function getSpawnForPlayer(playerId) {
  if (playerId === "1") {
    return { x: -5.0, z: 0 };
  }
  if (playerId === "2") {
    return { x: 5.0, z: 0 };
  }
  return { x: 0, z: 0 };
}

function createRoom(level) {
  const phaseConfig = getPhaseConfig(level);
  return {
    players: new Map(),
    clients: new Map(),
    sensors: createSensorsForMap(phaseConfig.mapId),
    bots: {},
    projectiles: {},
    phaseConfig,
    campaign: {
      phaseLevel: phaseConfig.level,
      mode: "campaign",
      state: "playing",
      intermissionEndsAt: null,
    },
    wave: {
      totalToSpawn: phaseConfig.totalBots,
      spawnedCount: 0,
      killedCount: 0,
    },
    startedAt: Date.now(),
    spawnTimer: 0,
    nextBotId: 1,
    nextProjectileId: 1,
    stats: {
      kills: {
        "1": 0,
        "2": 0,
      },
    },
    gameOver: null,
    gameOverSummary: null,
  };
}

function getOrCreateRoom(roomName, phaseLevel) {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, createRoom(phaseLevel));
  }
  return rooms.get(roomName);
}

function pruneClosedClients(room) {
  for (const [playerId, client] of room.clients) {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      continue;
    }
    room.clients.delete(playerId);
    room.players.delete(playerId);
  }
}

function getNextPlayerId(room) {
  if (!room.clients.has("1")) return "1";
  if (!room.clients.has("2")) return "2";
  return null;
}

function getTimeLeftSec(room, nowMs = Date.now()) {
  const elapsedSec = Math.floor((nowMs - room.startedAt) / 1000);
  return Math.max(0, room.phaseConfig.timeLimitSec - elapsedSec);
}

function getAliveSensorEntries(room) {
  return Object.entries(room.sensors).filter(([, sensor]) => sensor.hp > 0);
}

function getAlivePlayerEntries(room) {
  return [...room.players.entries()].filter(([, player]) => player.hp > 0);
}

function getBaseHealth(room) {
  let max = 0;
  let now = 0;

  for (const sensor of Object.values(room.sensors)) {
    max += sensor.maxHp;
    now += Math.max(0, sensor.hp);
  }

  const pct = max > 0 ? Math.round((now / max) * 100) : 0;
  return { now, max, pct };
}

function canRepair(room, player, sensorId) {
  if (!sensorId || typeof sensorId !== "string") {
    return false;
  }

  const sensor = room.sensors[sensorId];
  if (!sensor || sensor.hp <= 0) {
    return false;
  }

  if (player.hp <= 0) {
    return false;
  }

  const dist = Math.hypot(player.x - sensor.x, player.z - sensor.z);
  return dist <= REPAIR_RANGE;
}

function getRepairingMap(room) {
  const repairing = {};
  for (const player of room.players.values()) {
    if (!player.repairingSensorId) {
      continue;
    }
    if (canRepair(room, player, player.repairingSensorId)) {
      repairing[player.repairingSensorId] = true;
    }
  }
  return repairing;
}

function toPlayersPayload(players) {
  const payload = {};
  for (const [id, player] of players) {
    payload[id] = {
      x: player.x,
      z: player.z,
      vx: player.vx,
      vz: player.vz,
      hp: player.hp,
      maxHp: player.maxHp,
      repairingSensorId: player.repairingSensorId || null,
    };
  }
  return payload;
}

function toSensorsPayload(sensors) {
  const payload = {};
  for (const [id, sensor] of Object.entries(sensors)) {
    payload[id] = {
      x: sensor.x,
      z: sensor.z,
      hp: sensor.hp,
      maxHp: sensor.maxHp,
    };
  }
  return payload;
}

function toBotsPayload(bots) {
  const payload = {};
  for (const [id, bot] of Object.entries(bots)) {
    payload[id] = {
      x: bot.x,
      z: bot.z,
      hp: bot.hp,
      speed: bot.speed,
      attackCooldown: bot.attackCooldown,
    };
  }
  return payload;
}

function toProjectilesPayload(projectiles) {
  const payload = {};
  for (const [id, projectile] of Object.entries(projectiles)) {
    payload[id] = {
      x: projectile.x,
      z: projectile.z,
      vx: projectile.vx,
      vz: projectile.vz,
      owner: projectile.owner,
      ttl: projectile.ttl,
    };
  }
  return payload;
}

function buildMeta(room, nowMs = Date.now()) {
  const inIntermission = room.campaign.state !== "playing";
  const intermissionLeftMs =
    inIntermission && room.campaign.intermissionEndsAt
      ? Math.max(0, room.campaign.intermissionEndsAt - nowMs)
      : 0;

  return {
    phaseLevel: room.campaign.phaseLevel,
    phaseState: inIntermission ? "intermission" : "playing",
    intermissionLeftMs,
    mapId: room.phaseConfig.mapId,
    timeLeftSec: getTimeLeftSec(room, nowMs),
    kills: {
      ...room.stats.kills,
    },
    wave: {
      totalToSpawn: room.wave.totalToSpawn,
      spawnedCount: room.wave.spawnedCount,
      killedCount: room.wave.killedCount,
      aliveCount: Object.keys(room.bots).length,
    },
    base: getBaseHealth(room),
    repairing: getRepairingMap(room),
  };
}

function safeSend(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastToRoom(room, payload) {
  const serialized = JSON.stringify(payload);
  for (const client of room.clients.values()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  }
}

function broadcastState(roomName, room, nowMs = Date.now()) {
  broadcastToRoom(room, {
    type: "state",
    room: roomName,
    players: toPlayersPayload(room.players),
    sensors: toSensorsPayload(room.sensors),
    bots: toBotsPayload(room.bots),
    projectiles: toProjectilesPayload(room.projectiles),
    meta: buildMeta(room, nowMs),
  });
}

function broadcastEvent(room, kind, payload = {}) {
  broadcastToRoom(room, {
    type: "event",
    kind,
    ...payload,
  });
}

function broadcastPhase(room, kind, phase) {
  broadcastToRoom(room, {
    type: "phase",
    kind,
    phase,
  });
}

function buildGameOverSummary(room) {
  const killsByPlayer = {
    "1": room.stats.kills["1"] || 0,
    "2": room.stats.kills["2"] || 0,
  };

  for (const [playerId, kills] of Object.entries(room.stats.kills)) {
    if (!(playerId in killsByPlayer)) {
      killsByPlayer[playerId] = kills || 0;
    }
  }

  const totalKills = Object.values(killsByPlayer).reduce((sum, kills) => sum + kills, 0);
  return {
    killsByPlayer,
    totalKills,
    phaseReached: room.campaign.phaseLevel,
  };
}

function setGameOver(room, result) {
  if (room.gameOver) {
    return;
  }

  room.gameOver = result;
  room.campaign.state = "finished";
  room.campaign.intermissionEndsAt = null;
  room.bots = {};
  room.projectiles = {};
  room.gameOverSummary = buildGameOverSummary(room);

  if (result === "win") {
    console.log("[GAMEOVER] win at phase", room.campaign.phaseLevel);
  }

  broadcastToRoom(room, {
    type: "gameover",
    result,
    summary: room.gameOverSummary,
  });
}

function resetPlayersForPhase(room) {
  for (const [playerId, player] of room.players) {
    const spawn = getSpawnForPlayer(playerId);
    player.x = spawn.x;
    player.z = spawn.z;
    player.vx = 0;
    player.vz = 0;
    player.hp = player.maxHp;
    player.repairingSensorId = null;
    player.keys = {
      up: false,
      down: false,
      left: false,
      right: false,
    };
  }
}

function applyPhase(room, level, resetKills) {
  const phaseConfig = getPhaseConfig(level);

  room.phaseConfig = phaseConfig;
  room.campaign.phaseLevel = phaseConfig.level;
  room.campaign.state = "playing";
  room.campaign.intermissionEndsAt = null;
  room.startedAt = Date.now();
  room.spawnTimer = 0;
  room.sensors = createSensorsForMap(phaseConfig.mapId);
  room.bots = {};
  room.projectiles = {};
  room.wave.totalToSpawn = phaseConfig.totalBots;
  room.wave.spawnedCount = 0;
  room.wave.killedCount = 0;
  room.nextBotId = 1;
  room.nextProjectileId = 1;

  if (resetKills) {
    for (const key of Object.keys(room.stats.kills)) {
      room.stats.kills[key] = 0;
    }
    room.stats.kills["1"] = room.stats.kills["1"] || 0;
    room.stats.kills["2"] = room.stats.kills["2"] || 0;
  }

  resetPlayersForPhase(room);
}

function enterIntermission(room) {
  room.campaign.state = "intermission";
  room.campaign.intermissionEndsAt = Date.now() + INTERMISSION_MS;
  room.spawnTimer = 0;
  room.bots = {};
  room.projectiles = {};
  for (const player of room.players.values()) {
    player.vx = 0;
    player.vz = 0;
    player.repairingSensorId = null;
  }
  console.log("[PHASE] complete", room.campaign.phaseLevel);
  broadcastPhase(room, "complete", room.campaign.phaseLevel);
}

function checkPhaseFlow(room) {
  if (room.gameOver || room.campaign.state !== "playing") {
    return;
  }

  const aliveSensors = getAliveSensorEntries(room);
  if (aliveSensors.length === 0) {
    setGameOver(room, "lose");
    return;
  }

  const alivePlayers = getAlivePlayerEntries(room);
  if (room.players.size > 0 && alivePlayers.length === 0) {
    setGameOver(room, "lose");
    return;
  }

  const waveComplete = room.wave.killedCount >= room.wave.totalToSpawn;
  const survivedTime = getTimeLeftSec(room) <= 0 && aliveSensors.length > 0;
  if (!waveComplete && !survivedTime) {
    return;
  }

  if (room.campaign.phaseLevel < 3) {
    enterIntermission(room);
    return;
  }

  setGameOver(room, "win");
}

function startNextPhase(room) {
  const nextLevel = clamp(room.campaign.phaseLevel + 1, 1, 3);
  applyPhase(room, nextLevel, false);
  console.log("[PHASE] start", nextLevel);
  broadcastPhase(room, "start", nextLevel);
}

function updateIntermission(room, nowMs) {
  if (room.gameOver || room.campaign.state !== "intermission") {
    return;
  }

  if (!room.campaign.intermissionEndsAt || nowMs < room.campaign.intermissionEndsAt) {
    return;
  }

  startNextPhase(room);
}

function spawnBot(room) {
  if (room.wave.spawnedCount >= room.wave.totalToSpawn) {
    return;
  }

  const botCount = Object.keys(room.bots).length;
  if (botCount >= room.phaseConfig.maxAlive) {
    return;
  }

  const side = Math.random() < 0.5 ? -1 : 1;
  const spawnZ = -9 + Math.random() * 18;
  const speed = 2.4 + (room.campaign.phaseLevel - 1) * 0.2;
  const botId = `b${room.nextBotId++}`;

  room.bots[botId] = {
    x: side * 9,
    z: spawnZ,
    hp: room.phaseConfig.botHp,
    speed,
    attackCooldown: 0,
  };
  room.wave.spawnedCount += 1;
}

function findClosestTarget(sourceX, sourceZ, entries) {
  let closest = null;

  for (const [id, target] of entries) {
    const dx = target.x - sourceX;
    const dz = target.z - sourceZ;
    const dist = Math.hypot(dx, dz);

    if (!closest || dist < closest.dist) {
      closest = { id, target, dist, dx, dz };
    }
  }

  return closest;
}

function updateRepairs(room) {
  for (const player of room.players.values()) {
    if (!player.repairingSensorId) {
      continue;
    }

    if (!canRepair(room, player, player.repairingSensorId)) {
      player.repairingSensorId = null;
      continue;
    }

    const sensor = room.sensors[player.repairingSensorId];
    sensor.hp = Math.min(sensor.maxHp, sensor.hp + REPAIR_RATE * DT);
  }
}

function updateBots(room) {
  for (const bot of Object.values(room.bots)) {
    bot.attackCooldown = Math.max(0, bot.attackCooldown - DT);

    const sensorTargets = getAliveSensorEntries(room);
    const playerTargets = getAlivePlayerEntries(room);
    const targets = sensorTargets.length > 0 ? sensorTargets : playerTargets;
    if (targets.length === 0) {
      continue;
    }

    const closest = findClosestTarget(bot.x, bot.z, targets);
    if (!closest) {
      continue;
    }

    const direction = normalize2D(closest.dx, closest.dz);
    if (!direction) {
      continue;
    }

    if (closest.dist > BOT_ATTACK_RANGE) {
      bot.x = clamp(bot.x + direction.x * bot.speed * DT, -LIMIT, LIMIT);
      bot.z = clamp(bot.z + direction.z * bot.speed * DT, -LIMIT, LIMIT);
      continue;
    }

    const damage = room.phaseConfig.botDps * DT;
    closest.target.hp = Math.max(0, closest.target.hp - damage);
  }
}

function updateProjectiles(room) {
  for (const [projectileId, projectile] of Object.entries(room.projectiles)) {
    projectile.ttl -= DT;
    if (projectile.ttl <= 0) {
      delete room.projectiles[projectileId];
      continue;
    }

    projectile.x += projectile.vx * DT;
    projectile.z += projectile.vz * DT;

    if (Math.abs(projectile.x) > LIMIT + 3 || Math.abs(projectile.z) > LIMIT + 3) {
      delete room.projectiles[projectileId];
      continue;
    }

    let consumed = false;

    for (const [botId, bot] of Object.entries(room.bots)) {
      const dist = Math.hypot(projectile.x - bot.x, projectile.z - bot.z);
      if (dist > BOT_HIT_RADIUS) {
        continue;
      }

      bot.hp -= PROJECTILE_DAMAGE;
      delete room.projectiles[projectileId];
      consumed = true;

      if (bot.hp <= 0) {
        delete room.bots[botId];
        room.wave.killedCount = Math.min(room.wave.totalToSpawn, room.wave.killedCount + 1);

        if (projectile.owner === "1" || projectile.owner === "2") {
          room.stats.kills[projectile.owner] = (room.stats.kills[projectile.owner] || 0) + 1;
          broadcastEvent(room, "bot_neutralized", { by: projectile.owner });
        }
      }

      break;
    }

    if (consumed) {
      continue;
    }
  }
}

function createProjectile(room, playerId, dir) {
  if (room.gameOver || room.campaign.state !== "playing") {
    return;
  }

  const player = room.players.get(playerId);
  if (!player || player.hp <= 0) {
    return;
  }

  if (!dir || typeof dir.x !== "number" || typeof dir.z !== "number") {
    return;
  }

  if (!Number.isFinite(dir.x) || !Number.isFinite(dir.z)) {
    return;
  }

  const direction = normalize2D(dir.x, dir.z);
  if (!direction) {
    return;
  }

  const projectileId = `pr${room.nextProjectileId++}`;
  room.projectiles[projectileId] = {
    x: player.x,
    z: player.z,
    vx: direction.x * PROJECTILE_SPEED,
    vz: direction.z * PROJECTILE_SPEED,
    owner: playerId,
    ttl: PROJECTILE_TTL,
  };
}

function resetRoomForRestart(room) {
  room.gameOver = null;
  room.gameOverSummary = null;
  applyPhase(room, 1, true);
}

const wss = new WebSocket.Server({ port: PORT });

wss.on("connection", (ws, req) => {
  let roomName = "default";
  let phaseLevel = 1;

  try {
    const url = new URL(req.url || "/", `ws://${req.headers.host || "localhost"}`);
    roomName = url.searchParams.get("room")?.trim() || "default";
    phaseLevel = parsePhaseLevel(url.searchParams.get("phase"));
  } catch {
    roomName = "default";
    phaseLevel = 1;
  }

  let room = getOrCreateRoom(roomName, phaseLevel);
  pruneClosedClients(room);
  if (room.players.size === 0 && (room.campaign.phaseLevel !== phaseLevel || room.gameOver)) {
    rooms.set(roomName, createRoom(phaseLevel));
    room = rooms.get(roomName);
  }
  const playerId = getNextPlayerId(room);

  if (!playerId) {
    safeSend(ws, { type: "full" });
    ws.close();
    return;
  }

  const spawn = getSpawnForPlayer(playerId);
  room.players.set(playerId, {
    x: spawn.x,
    z: spawn.z,
    vx: 0,
    vz: 0,
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    repairingSensorId: null,
    keys: {
      up: false,
      down: false,
      left: false,
      right: false,
    },
  });
  room.stats.kills[playerId] = room.stats.kills[playerId] || 0;
  room.clients.set(playerId, ws);

  safeSend(ws, { type: "welcome", id: playerId, room: roomName });
  broadcastState(roomName, room);
  if (room.gameOver) {
    safeSend(ws, {
      type: "gameover",
      result: room.gameOver,
      summary: room.gameOverSummary || buildGameOverSummary(room),
    });
  }

  ws.on("message", (rawData) => {
    let message;

    try {
      message = JSON.parse(rawData.toString());
    } catch {
      return;
    }

    if (!message || typeof message.type !== "string") {
      return;
    }

    const player = room.players.get(playerId);

    if (message.type === "input") {
      if (!player || typeof message.keys !== "object" || !message.keys) {
        return;
      }
      if (room.gameOver || room.campaign.state !== "playing") {
        return;
      }

      player.keys = {
        up: Boolean(message.keys.up),
        down: Boolean(message.keys.down),
        left: Boolean(message.keys.left),
        right: Boolean(message.keys.right),
      };
      return;
    }

    if (message.type === "shoot") {
      createProjectile(room, playerId, message.dir);
      return;
    }

    if (message.type === "repair") {
      if (!player || room.gameOver || room.campaign.state !== "playing") {
        return;
      }

      if (typeof message.sensorId !== "string") {
        player.repairingSensorId = null;
        return;
      }

      if (canRepair(room, player, message.sensorId)) {
        player.repairingSensorId = message.sensorId;
      } else {
        player.repairingSensorId = null;
      }
      return;
    }

    if (message.type === "repairStop") {
      if (player) {
        player.repairingSensorId = null;
      }
      return;
    }

    if (message.type === "restart") {
      if (!room.gameOver) {
        return;
      }

      resetRoomForRestart(room);
      broadcastEvent(room, "restarted");
      broadcastPhase(room, "start", 1);
      broadcastState(roomName, room);
      return;
    }

    if (message.type === "collect") {
      return;
    }
  });

  ws.on("close", () => {
    room.players.delete(playerId);
    room.clients.delete(playerId);

    if (room.players.size === 0) {
      rooms.delete(roomName);
    }
  });

  ws.on("error", () => {});
});

setInterval(() => {
  for (const [roomName, room] of rooms) {
    const now = Date.now();
    const dt = DT;
    const gameplayActive = !room.gameOver && room.campaign.state === "playing";

    for (const player of room.players.values()) {
      if (player.hp <= 0) {
        player.vx = 0;
        player.vz = 0;
        player.repairingSensorId = null;
        continue;
      }

      if (!gameplayActive) {
        player.vx = 0;
        player.vz = 0;
        player.repairingSensorId = null;
        continue;
      }

      if (player.repairingSensorId && !canRepair(room, player, player.repairingSensorId)) {
        player.repairingSensorId = null;
      }

      const speedMul = player.repairingSensorId ? REPAIR_SPEED_MULT : 1;
      const horizontal = Number(player.keys.right) - Number(player.keys.left);
      const vertical = Number(player.keys.down) - Number(player.keys.up);

      player.vx = horizontal * SPEED * speedMul;
      player.vz = vertical * SPEED * speedMul;
      player.x = clamp(player.x + player.vx * dt, -LIMIT, LIMIT);
      player.z = clamp(player.z + player.vz * dt, -LIMIT, LIMIT);
    }

    if (!room.gameOver && room.campaign.state === "intermission") {
      updateIntermission(room, now);
      broadcastState(roomName, room, now);
      continue;
    }

    if (!room.gameOver && room.campaign.state === "playing") {
      room.spawnTimer += dt;
      while (room.spawnTimer >= room.phaseConfig.spawnEverySec) {
        room.spawnTimer -= room.phaseConfig.spawnEverySec;
        spawnBot(room);
      }

      updateRepairs(room);
      updateBots(room);
      updateProjectiles(room);
      checkPhaseFlow(room);
    }

    broadcastState(roomName, room, now);
  }
}, TICK_MS);

console.log(`WS server on ws://localhost:${PORT}`);
