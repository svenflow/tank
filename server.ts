/**
 * Tank Wars — Multiplayer Artillery Battle Server
 *
 * Bun WebSocket server that:
 * 1. Serves static files (index.html)
 * 2. Manages game lobbies with 2-6 players
 * 3. Runs server-authoritative physics, damage, and AI
 * 4. Turn-based: players adjust angle + power, fire projectiles
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { ServerWebSocket } from "bun";

const PORT = parseInt(process.env.PORT || "8776");
const CANVAS_W = 1000;
const CANVAS_H = 750;
const MAX_PLAYERS = 6;
const TURN_TIMEOUT = 30_000;
const AI_DELAY = 1200;
const GRAVITY = 400;
const STARTING_HP = 100;
const MAX_ROUNDS = 3;

// --- Weapon Definitions ---
interface WeaponDef {
  name: string;
  radius: number;
  damage: number;
  projectiles: number;
  spreadAngle: number; // degrees offset per sub-projectile
}

const WEAPONS: Record<string, WeaponDef> = {
  standard: { name: 'standard', radius: 30, damage: 50, projectiles: 1, spreadAngle: 0 },
  big:      { name: 'big',      radius: 55, damage: 70, projectiles: 1, spreadAngle: 0 },
  spread:   { name: 'spread',   radius: 20, damage: 30, projectiles: 3, spreadAngle: 10 },
};

// --- Types ---

interface Player {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  hp: number;
  angle: number;
  power: number;
  isAI: boolean;
  facingRight: boolean;
  weapon: string;
}

interface Lobby {
  id: string;
  code: string;
  players: Map<string, Player>;
  sockets: Map<string, ServerWebSocket<UserData>>;
  terrain: number[];
  wind: number;
  turnOrder: string[];
  currentTurnIndex: number;
  phase: "waiting" | "playing" | "gameover";
  hostId: string;
  turnTimer: ReturnType<typeof setTimeout> | null;
  round: number;
  maxRounds: number;
  scores: Map<string, number>;
}

interface UserData {
  id: string;
  name: string;
  lobbyId: string;
}

// --- State ---
const lobbies = new Map<string, Lobby>();
let nextUserId = 1;

const TANK_COLORS = [
  "#4ade80", "#60a5fa", "#f472b6", "#facc15", "#a855f7", "#22d3ee",
];

const AI_NAMES = ["Sarge", "Blitz", "Gunner", "Bomber", "Scout", "Tank-AI"];

// --- Static files ---
const indexHtml = readFileSync(join(import.meta.dir, "public", "index.html"), "utf-8");

// --- Room Code Generation ---
function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  // Ensure uniqueness
  if (lobbies.has(code)) return generateRoomCode();
  return code;
}

// --- Terrain Generation (Midpoint Displacement) ---
function generateTerrain(): number[] {
  const t = new Float64Array(CANVAS_W);
  t[0] = 350 + Math.random() * 100;
  t[CANVAS_W - 1] = 350 + Math.random() * 100;

  function subdivide(l: number, r: number, roughness: number) {
    if (r - l < 2) return;
    const mid = Math.floor((l + r) / 2);
    t[mid] = (t[l] + t[r]) / 2 + (Math.random() - 0.5) * roughness;
    subdivide(l, mid, roughness * 0.6);
    subdivide(mid, r, roughness * 0.6);
  }

  subdivide(0, CANVAS_W - 1, 200);

  // Smooth with moving average
  const smoothed = new Float64Array(CANVAS_W);
  for (let i = 0; i < CANVAS_W; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(CANVAS_W - 1, i + 3); j++) {
      sum += t[j]; count++;
    }
    smoothed[i] = sum / count;
  }

  // Clamp and convert to regular array
  const result: number[] = [];
  for (let i = 0; i < CANVAS_W; i++) {
    result.push(Math.max(200, Math.min(520, smoothed[i])));
  }
  return result;
}

// --- Physics ---
function computeTrajectory(
  startX: number, startY: number,
  angle: number, power: number,
  wind: number, terrain: number[],
  facingRight: boolean
): { points: number[][]; impactX: number; impactY: number } {
  const rad = (angle * Math.PI) / 180;
  const dir = facingRight ? 1 : -1;
  const speed = power * 8;
  let vx = speed * Math.cos(rad) * dir;
  let vy = -speed * Math.sin(rad); // canvas y inverted
  let x = startX;
  let y = startY - 15; // barrel tip
  const windForce = wind * 20;
  const dt = 1 / 60;
  const points: number[][] = [];

  for (let i = 0; i < 3000; i++) {
    points.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);

    vx += windForce * dt;
    vy += GRAVITY * dt;
    x += vx * dt;
    y += vy * dt;

    // Off screen horizontally
    if (x < -50 || x > CANVAS_W + 50) break;
    // Way above screen (let it arc back)
    if (y < -800) break;

    // Hit terrain
    const col = Math.floor(x);
    if (col >= 0 && col < CANVAS_W && y >= terrain[col]) {
      points.push([x, terrain[col]]);
      return { points, impactX: x, impactY: terrain[col] };
    }
  }

  // Missed — went off screen
  return { points, impactX: -1, impactY: -1 };
}

// --- Terrain Destruction ---
function destroyTerrain(terrain: number[], ix: number, iy: number, radius: number): void {
  for (let x = Math.max(0, Math.floor(ix - radius)); x < Math.min(CANVAS_W, Math.ceil(ix + radius)); x++) {
    const dx = x - ix;
    const depth = Math.sqrt(Math.max(0, radius * radius - dx * dx));
    const craterBottom = iy + depth;
    if (terrain[x] < craterBottom) {
      terrain[x] = Math.min(550, craterBottom);
    }
  }
}

// --- Damage ---
function calculateDamage(players: Map<string, Player>, ix: number, iy: number, shooterId: string, radius: number, maxDamage: number): Map<string, number> {
  const damages = new Map<string, number>();
  for (const [id, p] of players) {
    if (p.hp <= 0) continue;
    const dist = Math.sqrt((p.x - ix) ** 2 + (p.y - iy) ** 2);
    if (dist < radius) {
      const dmg = Math.floor(maxDamage * (1 - dist / radius));
      if (dmg > 0) {
        damages.set(id, (damages.get(id) || 0) + dmg);
        p.hp = Math.max(0, p.hp - dmg);
      }
    }
  }
  return damages;
}

// --- AI ---
function computeAIShot(ai: Player, lobby: Lobby): { angle: number; power: number } {
  // Find nearest living enemy
  let bestTarget: Player | null = null;
  let bestDist = Infinity;
  for (const [id, p] of lobby.players) {
    if (id === ai.id || p.hp <= 0) continue;
    const dist = Math.abs(p.x - ai.x);
    if (dist < bestDist) {
      bestDist = dist;
      bestTarget = p;
    }
  }

  if (!bestTarget) return { angle: 45, power: 50 };

  // Try several random shots, pick the best one
  let bestAngle = 45, bestPower = 50, bestImpactDist = Infinity;

  for (let attempt = 0; attempt < 40; attempt++) {
    const angle = 20 + Math.random() * 70;
    const power = 20 + Math.random() * 80;
    const { impactX, impactY } = computeTrajectory(
      ai.x, ai.y, angle, power, lobby.wind, lobby.terrain, ai.facingRight
    );
    if (impactX < 0) continue;
    const dist = Math.sqrt((impactX - bestTarget.x) ** 2 + (impactY - bestTarget.y) ** 2);
    if (dist < bestImpactDist) {
      bestImpactDist = dist;
      bestAngle = angle;
      bestPower = power;
    }
  }

  // Add some noise to make it imperfect
  bestAngle += (Math.random() - 0.5) * 8;
  bestPower += (Math.random() - 0.5) * 10;
  bestAngle = Math.max(5, Math.min(175, bestAngle));
  bestPower = Math.max(10, Math.min(100, bestPower));

  return { angle: Math.round(bestAngle), power: Math.round(bestPower) };
}

// --- Lobby Management ---
function findOrCreateLobby(roomCode?: string): Lobby {
  if (roomCode) {
    const existing = lobbies.get(roomCode);
    if (existing && existing.phase === "waiting" && existing.players.size < MAX_PLAYERS) {
      return existing;
    }
    // Create with this code if not found or not joinable
    if (!existing) {
      return createLobby(roomCode);
    }
  }
  // Create new with random code
  return createLobby(generateRoomCode());
}

function createLobby(code: string): Lobby {
  const lobby: Lobby = {
    id: code,
    code,
    players: new Map(),
    sockets: new Map(),
    terrain: [],
    wind: 0,
    turnOrder: [],
    currentTurnIndex: 0,
    phase: "waiting",
    hostId: "",
    turnTimer: null,
    round: 0,
    maxRounds: MAX_ROUNDS,
    scores: new Map(),
  };
  lobbies.set(code, lobby);
  return lobby;
}

function broadcast(lobby: Lobby, msg: object, excludeId?: string) {
  const json = JSON.stringify(msg);
  for (const [id, ws] of lobby.sockets) {
    if (id !== excludeId) {
      try { ws.send(json); } catch {}
    }
  }
}

function sendTo(lobby: Lobby, playerId: string, msg: object) {
  const ws = lobby.sockets.get(playerId);
  if (ws) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
}

function getPlayersArray(lobby: Lobby): object[] {
  return Array.from(lobby.players.values()).map(p => ({
    id: p.id, name: p.name, color: p.color,
    x: p.x, y: p.y, hp: p.hp,
    angle: p.angle, power: p.power,
    isAI: p.isAI, facingRight: p.facingRight,
    weapon: p.weapon,
  }));
}

function getScoresObject(lobby: Lobby): Record<string, number> {
  return Object.fromEntries(lobby.scores);
}

// --- Game Flow ---
function startGame(lobby: Lobby) {
  // Fill empty slots with AI
  const humanCount = lobby.players.size;
  if (humanCount < 2) {
    const aiCount = 2 - humanCount; // At least 2 players
    for (let i = 0; i < aiCount; i++) {
      const aiId = `ai_${Date.now()}_${i}`;
      const colorIdx = lobby.players.size % TANK_COLORS.length;
      const ai: Player = {
        id: aiId,
        name: AI_NAMES[i % AI_NAMES.length],
        color: TANK_COLORS[colorIdx],
        x: 0, y: 0,
        hp: STARTING_HP,
        angle: 45, power: 50,
        isAI: true,
        facingRight: true,
        weapon: 'standard',
      };
      lobby.players.set(aiId, ai);
    }
  }

  // Initialize scores for all players if first round
  if (lobby.round === 0) {
    lobby.scores.clear();
    for (const [id] of lobby.players) {
      lobby.scores.set(id, 0);
    }
  }

  lobby.round++;

  // Generate terrain
  lobby.terrain = generateTerrain();

  // Place tanks evenly across terrain
  const playerIds = Array.from(lobby.players.keys());
  const spacing = CANVAS_W / (playerIds.length + 1);
  const centerX = CANVAS_W / 2;

  for (let i = 0; i < playerIds.length; i++) {
    const p = lobby.players.get(playerIds[i])!;
    p.x = Math.round(spacing * (i + 1));
    p.y = lobby.terrain[Math.floor(p.x)];
    p.facingRight = p.x < centerX;
    p.hp = STARTING_HP;
    p.weapon = 'standard';
  }

  // Set turn order (left to right)
  lobby.turnOrder = playerIds.sort((a, b) => {
    return lobby.players.get(a)!.x - lobby.players.get(b)!.x;
  });

  lobby.currentTurnIndex = 0;
  lobby.wind = Math.round((Math.random() - 0.5) * 20);
  lobby.phase = "playing";

  broadcast(lobby, {
    type: "game_start",
    terrain: lobby.terrain,
    players: getPlayersArray(lobby),
    wind: lobby.wind,
    currentTurn: lobby.turnOrder[0],
    round: lobby.round,
    maxRounds: lobby.maxRounds,
    scores: getScoresObject(lobby),
  });

  startTurn(lobby);
}

function startTurn(lobby: Lobby) {
  if (lobby.phase !== "playing") return;

  // Check for game over
  const alive = Array.from(lobby.players.values()).filter(p => p.hp > 0);
  if (alive.length <= 1) {
    lobby.phase = "gameover";
    if (lobby.turnTimer) clearTimeout(lobby.turnTimer);

    // Increment winner's score
    const winner = alive.length === 1 ? alive[0] : null;
    if (winner) {
      lobby.scores.set(winner.id, (lobby.scores.get(winner.id) || 0) + 1);
    }

    const isFinalRound = lobby.round >= lobby.maxRounds;

    // Determine match winner if final round
    let matchWinner: { id: string; name: string; color: string } | null = null;
    if (isFinalRound) {
      let bestScore = -1;
      let bestId = '';
      for (const [id, score] of lobby.scores) {
        if (score > bestScore) {
          bestScore = score;
          bestId = id;
        }
      }
      if (bestId) {
        const p = lobby.players.get(bestId);
        if (p) {
          matchWinner = { id: p.id, name: p.name, color: p.color };
        }
      }
    }

    broadcast(lobby, {
      type: "game_over",
      winner: winner ? {
        id: winner.id, name: winner.name, color: winner.color,
      } : null,
      players: getPlayersArray(lobby),
      round: lobby.round,
      maxRounds: lobby.maxRounds,
      scores: getScoresObject(lobby),
      isFinalRound,
      matchWinner,
    });

    if (!isFinalRound) {
      // Auto-start next round after delay
      setTimeout(() => {
        if (lobby.sockets.size === 0) {
          lobbies.delete(lobby.code);
          return;
        }
        startGame(lobby);
      }, 3000);
    } else {
      // Reset to lobby after all rounds
      setTimeout(() => {
        resetLobby(lobby);
      }, 5000);
    }
    return;
  }

  // Find next living player
  let attempts = 0;
  while (attempts < lobby.turnOrder.length) {
    const currentId = lobby.turnOrder[lobby.currentTurnIndex];
    const currentPlayer = lobby.players.get(currentId);
    if (currentPlayer && currentPlayer.hp > 0) break;
    lobby.currentTurnIndex = (lobby.currentTurnIndex + 1) % lobby.turnOrder.length;
    attempts++;
  }

  // New wind each turn
  lobby.wind = Math.round((Math.random() - 0.5) * 20);

  const currentId = lobby.turnOrder[lobby.currentTurnIndex];
  const currentPlayer = lobby.players.get(currentId)!;

  broadcast(lobby, {
    type: "turn_start",
    currentTurn: currentId,
    wind: lobby.wind,
  });

  // If AI, compute and fire after delay
  if (currentPlayer.isAI) {
    setTimeout(() => {
      if (lobby.phase !== "playing") return;
      const shot = computeAIShot(currentPlayer, lobby);
      currentPlayer.angle = shot.angle;
      currentPlayer.power = shot.power;

      // Broadcast AI aiming
      broadcast(lobby, {
        type: "aim_update",
        playerId: currentId,
        angle: shot.angle,
        power: shot.power,
      });

      setTimeout(() => {
        if (lobby.phase !== "playing") return;
        executeFire(lobby, currentId);
      }, 600);
    }, AI_DELAY);
  } else {
    // Human turn — set timeout
    if (lobby.turnTimer) clearTimeout(lobby.turnTimer);
    lobby.turnTimer = setTimeout(() => {
      if (lobby.phase !== "playing") return;
      // Auto-fire with current aim
      executeFire(lobby, currentId);
    }, TURN_TIMEOUT);
  }
}

function executeFire(lobby: Lobby, playerId: string) {
  if (lobby.turnTimer) clearTimeout(lobby.turnTimer);

  const player = lobby.players.get(playerId);
  if (!player || player.hp <= 0) {
    advanceTurn(lobby);
    return;
  }

  const weaponDef = WEAPONS[player.weapon] || WEAPONS.standard;
  const allTrajectories: { points: number[][]; impactX: number; impactY: number }[] = [];
  const totalDamages = new Map<string, number>();

  if (weaponDef.projectiles === 1) {
    // Single projectile
    const traj = computeTrajectory(
      player.x, player.y, player.angle, player.power,
      lobby.wind, lobby.terrain, player.facingRight
    );
    allTrajectories.push(traj);

    if (traj.impactX >= 0) {
      destroyTerrain(lobby.terrain, traj.impactX, traj.impactY, weaponDef.radius);
      const damages = calculateDamage(lobby.players, traj.impactX, traj.impactY, playerId, weaponDef.radius, weaponDef.damage);
      for (const [id, dmg] of damages) {
        totalDamages.set(id, (totalDamages.get(id) || 0) + dmg);
      }
    }
  } else {
    // Multi-projectile (spread)
    const offsets = [];
    for (let i = 0; i < weaponDef.projectiles; i++) {
      offsets.push((i - Math.floor(weaponDef.projectiles / 2)) * weaponDef.spreadAngle);
    }

    for (const offset of offsets) {
      const adjustedAngle = player.angle + offset * 0.5;
      const traj = computeTrajectory(
        player.x, player.y, adjustedAngle, player.power,
        lobby.wind, lobby.terrain, player.facingRight
      );
      allTrajectories.push(traj);

      if (traj.impactX >= 0) {
        destroyTerrain(lobby.terrain, traj.impactX, traj.impactY, weaponDef.radius);
        const damages = calculateDamage(lobby.players, traj.impactX, traj.impactY, playerId, weaponDef.radius, weaponDef.damage);
        for (const [id, dmg] of damages) {
          totalDamages.set(id, (totalDamages.get(id) || 0) + dmg);
        }
      }
    }
  }

  // Update tank y positions (they may have fallen into craters)
  for (const [, p] of lobby.players) {
    if (p.hp > 0) {
      const col = Math.min(CANVAS_W - 1, Math.max(0, Math.floor(p.x)));
      p.y = lobby.terrain[col];
    }
  }

  broadcast(lobby, {
    type: "fire",
    playerId,
    angle: player.angle,
    power: player.power,
    weapon: player.weapon,
    trajectories: allTrajectories.map(t => ({
      points: t.points,
      impactX: t.impactX,
      impactY: t.impactY,
    })),
    explosionRadius: weaponDef.radius,
    damages: Object.fromEntries(totalDamages),
    terrain: lobby.terrain,
    players: getPlayersArray(lobby),
  });

  // Wait for animation before next turn
  const longestTraj = Math.max(...allTrajectories.map(t => t.points.length));
  const animTime = Math.min(longestTraj * 16, 4000) + 800;
  setTimeout(() => advanceTurn(lobby), animTime);
}

function advanceTurn(lobby: Lobby) {
  lobby.currentTurnIndex = (lobby.currentTurnIndex + 1) % lobby.turnOrder.length;
  startTurn(lobby);
}

function resetLobby(lobby: Lobby) {
  // Remove AI players
  for (const [id, p] of lobby.players) {
    if (p.isAI) lobby.players.delete(id);
  }
  // Reset remaining humans
  for (const [, p] of lobby.players) {
    p.hp = STARTING_HP;
    p.angle = 45;
    p.power = 50;
    p.weapon = 'standard';
  }
  lobby.phase = "waiting";
  lobby.terrain = [];
  lobby.turnOrder = [];
  lobby.currentTurnIndex = 0;
  lobby.round = 0;
  lobby.scores.clear();
  if (lobby.turnTimer) clearTimeout(lobby.turnTimer);
  lobby.turnTimer = null;

  if (lobby.sockets.size === 0) {
    lobbies.delete(lobby.code);
  } else {
    broadcast(lobby, {
      type: "lobby_state",
      players: getPlayersArray(lobby),
      phase: "waiting",
      roomCode: lobby.code,
    });
  }
}

function removePlayer(lobby: Lobby, playerId: string) {
  lobby.players.delete(playerId);
  lobby.sockets.delete(playerId);

  if (lobby.phase === "waiting") {
    if (lobby.sockets.size === 0) {
      lobbies.delete(lobby.code);
      return;
    }
    // Reassign host
    if (lobby.hostId === playerId) {
      lobby.hostId = lobby.sockets.keys().next().value!;
    }
    broadcast(lobby, {
      type: "lobby_state",
      players: getPlayersArray(lobby),
      phase: "waiting",
      hostId: lobby.hostId,
      roomCode: lobby.code,
    });
  } else if (lobby.phase === "playing") {
    broadcast(lobby, {
      type: "player_left",
      playerId,
      players: getPlayersArray(lobby),
    });
    // Check if current turn player left
    const currentId = lobby.turnOrder[lobby.currentTurnIndex];
    if (currentId === playerId) {
      if (lobby.turnTimer) clearTimeout(lobby.turnTimer);
      advanceTurn(lobby);
    }
    // Check if game should end
    const aliveHumans = Array.from(lobby.players.values()).filter(p => p.hp > 0 && !p.isAI);
    if (aliveHumans.length === 0 && lobby.sockets.size === 0) {
      if (lobby.turnTimer) clearTimeout(lobby.turnTimer);
      lobbies.delete(lobby.code);
    }
  }
}

// --- HTTP + WebSocket Server ---
const server = Bun.serve({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const id = `player_${nextUserId++}`;
      const upgraded = server.upgrade(req, {
        data: { id, name: "", lobbyId: "" } as UserData,
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(indexHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      const data = ws.data as UserData;
      console.log(`${data.id} connected`);
    },

    message(ws, message) {
      const data = ws.data as UserData;
      try {
        const msg = JSON.parse(message as string);

        if (msg.type === "join") {
          const name = (msg.name || "Player").slice(0, 16);
          data.name = name;

          const roomCode = msg.roomCode ? String(msg.roomCode).toUpperCase().slice(0, 4) : undefined;
          const lobby = findOrCreateLobby(roomCode);
          data.lobbyId = lobby.code;

          const colorIdx = lobby.players.size % TANK_COLORS.length;
          const player: Player = {
            id: data.id,
            name,
            color: TANK_COLORS[colorIdx],
            x: 0, y: 0,
            hp: STARTING_HP,
            angle: 45, power: 50,
            isAI: false,
            facingRight: true,
            weapon: 'standard',
          };

          lobby.players.set(data.id, player);
          lobby.sockets.set(data.id, ws);

          if (!lobby.hostId) lobby.hostId = data.id;

          ws.send(JSON.stringify({
            type: "welcome",
            playerId: data.id,
            lobbyId: lobby.code,
            isHost: lobby.hostId === data.id,
            players: getPlayersArray(lobby),
            roomCode: lobby.code,
          }));

          broadcast(lobby, {
            type: "lobby_state",
            players: getPlayersArray(lobby),
            phase: "waiting",
            hostId: lobby.hostId,
            roomCode: lobby.code,
          }, data.id);
        }

        else if (msg.type === "start_game") {
          const lobby = lobbies.get(data.lobbyId);
          if (!lobby || lobby.phase !== "waiting") return;
          if (data.id !== lobby.hostId) return; // Only host can start
          startGame(lobby);
        }

        else if (msg.type === "set_aim") {
          const lobby = lobbies.get(data.lobbyId);
          if (!lobby || lobby.phase !== "playing") return;
          const currentId = lobby.turnOrder[lobby.currentTurnIndex];
          if (currentId !== data.id) return; // Not your turn

          const player = lobby.players.get(data.id);
          if (!player) return;
          player.angle = Math.max(5, Math.min(175, msg.angle || 45));
          player.power = Math.max(10, Math.min(100, msg.power || 50));

          broadcast(lobby, {
            type: "aim_update",
            playerId: data.id,
            angle: player.angle,
            power: player.power,
          }, data.id);
        }

        else if (msg.type === "set_weapon") {
          const lobby = lobbies.get(data.lobbyId);
          if (!lobby || lobby.phase !== "playing") return;
          const currentId = lobby.turnOrder[lobby.currentTurnIndex];
          if (currentId !== data.id) return;

          const player = lobby.players.get(data.id);
          if (!player) return;
          const weaponName = String(msg.weapon || 'standard');
          if (WEAPONS[weaponName]) {
            player.weapon = weaponName;
            broadcast(lobby, {
              type: "weapon_update",
              playerId: data.id,
              weapon: weaponName,
            });
          }
        }

        else if (msg.type === "fire") {
          const lobby = lobbies.get(data.lobbyId);
          if (!lobby || lobby.phase !== "playing") return;
          const currentId = lobby.turnOrder[lobby.currentTurnIndex];
          if (currentId !== data.id) return;
          executeFire(lobby, data.id);
        }

        else if (msg.type === "chat") {
          const lobby = lobbies.get(data.lobbyId);
          if (!lobby) return;
          broadcast(lobby, {
            type: "chat",
            playerId: data.id,
            name: data.name,
            text: (msg.text || "").slice(0, 200),
          });
        }

      } catch (e) {
        console.error("Invalid message:", e);
      }
    },

    close(ws) {
      const data = ws.data as UserData;
      console.log(`${data.id} (${data.name}) disconnected`);
      const lobby = lobbies.get(data.lobbyId);
      if (lobby) removePlayer(lobby, data.id);
    },
  },
});

console.log(`Tank Wars server running on http://localhost:${PORT}`);
