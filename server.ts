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
const CANVAS_W = 800;
const CANVAS_H = 600;
const MAX_PLAYERS = 6;
const TURN_TIMEOUT = 30_000;
const AI_DELAY = 1200;
const GRAVITY = 400;
const EXPLOSION_RADIUS = 30;
const MAX_DAMAGE = 50;
const STARTING_HP = 100;

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
}

interface Lobby {
  id: string;
  players: Map<string, Player>;
  sockets: Map<string, ServerWebSocket<UserData>>;
  terrain: number[];
  wind: number;
  turnOrder: string[];
  currentTurnIndex: number;
  phase: "waiting" | "playing" | "gameover";
  hostId: string;
  turnTimer: ReturnType<typeof setTimeout> | null;
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
function calculateDamage(players: Map<string, Player>, ix: number, iy: number, shooterId: string): Map<string, number> {
  const damages = new Map<string, number>();
  for (const [id, p] of players) {
    if (p.hp <= 0) continue;
    const dist = Math.sqrt((p.x - ix) ** 2 + (p.y - iy) ** 2);
    if (dist < EXPLOSION_RADIUS) {
      const dmg = Math.floor(MAX_DAMAGE * (1 - dist / EXPLOSION_RADIUS));
      if (dmg > 0) {
        damages.set(id, dmg);
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
function findOrCreateLobby(): Lobby {
  // Find a lobby in waiting phase with room
  for (const [, lobby] of lobbies) {
    if (lobby.phase === "waiting" && lobby.players.size < MAX_PLAYERS) {
      return lobby;
    }
  }
  // Create new
  const id = `lobby_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const lobby: Lobby = {
    id,
    players: new Map(),
    sockets: new Map(),
    terrain: [],
    wind: 0,
    turnOrder: [],
    currentTurnIndex: 0,
    phase: "waiting",
    hostId: "",
    turnTimer: null,
  };
  lobbies.set(id, lobby);
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
  }));
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
      };
      lobby.players.set(aiId, ai);
    }
  }

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
    broadcast(lobby, {
      type: "game_over",
      winner: alive.length === 1 ? {
        id: alive[0].id, name: alive[0].name, color: alive[0].color,
      } : null,
      players: getPlayersArray(lobby),
    });
    // Clean up lobby after a delay
    setTimeout(() => {
      resetLobby(lobby);
    }, 5000);
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

  const { points, impactX, impactY } = computeTrajectory(
    player.x, player.y, player.angle, player.power,
    lobby.wind, lobby.terrain, player.facingRight
  );

  let damages: Map<string, number> = new Map();
  if (impactX >= 0) {
    // Destroy terrain
    destroyTerrain(lobby.terrain, impactX, impactY, EXPLOSION_RADIUS);
    // Calculate damage
    damages = calculateDamage(lobby.players, impactX, impactY, playerId);
    // Update tank y positions (they may have fallen into craters)
    for (const [, p] of lobby.players) {
      if (p.hp > 0) {
        const col = Math.min(CANVAS_W - 1, Math.max(0, Math.floor(p.x)));
        p.y = lobby.terrain[col];
      }
    }
  }

  broadcast(lobby, {
    type: "fire",
    playerId,
    angle: player.angle,
    power: player.power,
    trajectory: points,
    impactX,
    impactY,
    explosionRadius: EXPLOSION_RADIUS,
    damages: Object.fromEntries(damages),
    terrain: lobby.terrain,
    players: getPlayersArray(lobby),
  });

  // Wait for animation before next turn
  const animTime = Math.min(points.length * 16, 4000) + 800;
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
  }
  lobby.phase = "waiting";
  lobby.terrain = [];
  lobby.turnOrder = [];
  lobby.currentTurnIndex = 0;
  if (lobby.turnTimer) clearTimeout(lobby.turnTimer);
  lobby.turnTimer = null;

  if (lobby.sockets.size === 0) {
    lobbies.delete(lobby.id);
  } else {
    broadcast(lobby, {
      type: "lobby_state",
      players: getPlayersArray(lobby),
      phase: "waiting",
    });
  }
}

function removePlayer(lobby: Lobby, playerId: string) {
  lobby.players.delete(playerId);
  lobby.sockets.delete(playerId);

  if (lobby.phase === "waiting") {
    if (lobby.sockets.size === 0) {
      lobbies.delete(lobby.id);
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
      lobbies.delete(lobby.id);
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

          const lobby = findOrCreateLobby();
          data.lobbyId = lobby.id;

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
          };

          lobby.players.set(data.id, player);
          lobby.sockets.set(data.id, ws);

          if (!lobby.hostId) lobby.hostId = data.id;

          ws.send(JSON.stringify({
            type: "welcome",
            playerId: data.id,
            lobbyId: lobby.id,
            isHost: lobby.hostId === data.id,
            players: getPlayersArray(lobby),
          }));

          broadcast(lobby, {
            type: "lobby_state",
            players: getPlayersArray(lobby),
            phase: "waiting",
            hostId: lobby.hostId,
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
