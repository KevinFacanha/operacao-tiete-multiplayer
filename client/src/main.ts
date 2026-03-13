import * as THREE from "three";

type PhaseLevel = 1 | 2 | 3;

type KeysState = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
};

type PlayerState = {
  x: number;
  z: number;
  vx: number;
  vz: number;
  hp: number;
  maxHp: number;
  repairingSensorId: string | null;
};

type SensorState = {
  x: number;
  z: number;
  hp: number;
  maxHp: number;
};

type BotState = {
  x: number;
  z: number;
  hp: number;
  speed: number;
  attackCooldown: number;
};

type ProjectileState = {
  x: number;
  z: number;
  vx: number;
  vz: number;
  owner: string;
  ttl: number;
};

type BaseMeta = {
  now: number;
  max: number;
  pct: number;
};

type WaveMeta = {
  totalToSpawn: number;
  spawnedCount: number;
  killedCount: number;
  aliveCount: number;
};

type StateMeta = {
  phaseLevel: number;
  phaseState: "playing" | "intermission";
  intermissionLeftMs?: number;
  mapId: number;
  timeLeftSec: number;
  kills: Record<string, number>;
  wave: WaveMeta;
  base: BaseMeta;
  repairing: Record<string, boolean>;
};

type StateMessage = {
  type: "state";
  room: string;
  players: Record<string, PlayerState>;
  sensors: Record<string, SensorState>;
  bots: Record<string, BotState>;
  projectiles: Record<string, ProjectileState>;
  meta: StateMeta;
};

type WelcomeMessage = {
  type: "welcome";
  id: string;
  room: string;
};

type GameOverMessage = {
  type: "gameover";
  result: "win" | "lose";
  summary?: {
    killsByPlayer: Record<string, number>;
    totalKills: number;
    phaseReached: number;
  };
};

type ServerEventMessage = {
  type: "event";
  kind?: string;
  by?: string;
};

type PhaseMessage = {
  type: "phase";
  kind?: "complete" | "start";
  phase?: number;
};

const INPUT_INTERVAL_MS = 50;
const SHOT_COOLDOWN_MS = 120;
const AIM_ASSIST_RADIUS = 8;
const REPAIR_RANGE = 2.2;
const REPAIR_SEND_INTERVAL_MS = 140;
const JOYSTICK_TOUCH_BREAKPOINT = 900;
const JOYSTICK_AXIS_THRESHOLD_RATIO = 0.35;
const JOYSTICK_DEADZONE_RATIO = 0.2;
const REPAIR_HINT_COOLDOWN_MS = 1300;
const PROJECTILE_BEAM_RADIUS = 0.04;
const PROJECTILE_BEAM_LENGTH = 1.0;
const PROJECTILE_BEAM_UPDATE_FADE_MS = 120;
const PROJECTILE_BEAM_STALE_FADE_MS = 90;
const SKY_BANNER_FOLLOW_Y_OFFSET = -2.5;
const SKY_BANNER_FOLLOW_Z_OFFSET = -10;
const SKY_BANNER_LOOP_LIMIT_X = 28;
const SKY_BANNER_SPEED = 3.1;
const SKY_BANNER_SCALE = 1.8;
const BOT_EXPLOSION_MAX_ACTIVE_FX = 16;
const BOT_EXPLOSION_FLASH_TTL = 0.12;
const BOT_EXPLOSION_SHOCKWAVE_TTL = 0.25;
const BOT_EXPLOSION_FRAGMENT_TTL = 0.6;
const BOT_EXPLOSION_SMOKE_TTL = 0.7;
const CAMERA_OFFSET = new THREE.Vector3(0, 10, 14);
const CAMERA_LERP_ALPHA = 0.08;
const SENSOR_DAMAGE_EVENT_COOLDOWN_MS = 1200;
const WS_SERVER_STORAGE_KEY = "wsServer";
const WS_SERVER_PLACEHOLDER = "192.168.0.10:8080";
const GAME_FONT_FAMILY = '"Pixelify Sans", monospace';
const SKY_BANNER_TITLE_FONT = `700 84px ${GAME_FONT_FAMILY}`;
const SKY_BANNER_SUBTITLE_FONT = `600 34px ${GAME_FONT_FAMILY}`;
const SENSOR_LABEL_FONT = `700 28px ${GAME_FONT_FAMILY}`;

async function initGameFonts() {
  if (!("fonts" in document)) {
    return;
  }

  try {
    await Promise.all([
      document.fonts.load(`400 16px ${GAME_FONT_FAMILY}`),
      document.fonts.load(`600 16px ${GAME_FONT_FAMILY}`),
      document.fonts.load(`700 16px ${GAME_FONT_FAMILY}`),
    ]);
  } catch {
    // noop
  }

  refreshBannerTexture();
  markSensorLabelsDirty();
}

function normalizeWsServerValue(value: string) {
  const withoutProtocol = value.trim().replace(/^wss?:\/\//i, "");
  return withoutProtocol.split("/")[0] ?? "";
}

function getHostnameDefaultWsServer() {
  const hostname = window.location.hostname.trim();
  return hostname ? `${hostname}:8080` : "";
}

function readStoredWsServer() {
  try {
    return normalizeWsServerValue(window.localStorage.getItem(WS_SERVER_STORAGE_KEY) ?? "");
  } catch {
    return "";
  }
}

function resolveInitialWsServer() {
  const stored = readStoredWsServer();
  if (stored) {
    return stored;
  }
  return getHostnameDefaultWsServer();
}

function parsePhaseFromUrl(): PhaseLevel | null {
  const raw = Number(new URLSearchParams(window.location.search).get("phase"));
  if (raw === 1 || raw === 2 || raw === 3) {
    return raw;
  }
  return null;
}

function parseRoomFromUrl() {
  const raw = new URLSearchParams(window.location.search).get("room")?.trim();
  return raw ? raw : "default";
}

function toPhaseLevel(value: number): PhaseLevel | null {
  if (value === 1 || value === 2 || value === 3) {
    return value;
  }
  return null;
}

function setUrlForSession(room: string, phase: PhaseLevel | null) {
  const params = new URLSearchParams(window.location.search);

  if (room && room !== "default") {
    params.set("room", room);
  } else {
    params.delete("room");
  }

  if (phase) {
    params.set("phase", String(phase));
  } else {
    params.delete("phase");
  }

  const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
  window.history.replaceState({}, "", next);
}

let currentRoom = parseRoomFromUrl();
let currentPhase: PhaseLevel | null = parsePhaseFromUrl();
let activeMapId = 0;
let configuredWsServer = resolveInitialWsServer();

const statusEl = document.getElementById("status") as HTMLSpanElement;
const myIdEl = document.getElementById("my-id") as HTMLSpanElement;
const roomEl = document.getElementById("room") as HTMLSpanElement;
const fullMessageEl = document.getElementById("full-message") as HTMLDivElement;
const hudEl = document.getElementById("hud") as HTMLDivElement;
const shootBtnEl = document.getElementById("btn-shoot") as HTMLButtonElement;
const healBtnEl = document.getElementById("btn-heal") as HTMLButtonElement;
const joystickEl = document.getElementById("joystick") as HTMLDivElement;
const joystickThumbEl = document.getElementById("joystick-thumb") as HTMLDivElement;

const hudTopRowEl = document.createElement("div");
const hudLeftEl = document.createElement("div");
const hudCenterEl = document.createElement("div");
const hudRightEl = document.createElement("div");
const phaseTimeEl = document.createElement("div");
const baseEl = document.createElement("div");
const baseBarWrapEl = document.createElement("div");
const baseBarFillEl = document.createElement("div");
const killsEl = document.createElement("div");
const botsEl = document.createElement("div");
const eventsEl = document.createElement("div");

statusEl.textContent = "idle";
myIdEl.textContent = "-";
roomEl.textContent = currentRoom;
hudTopRowEl.className = "hud-top-row";
hudLeftEl.className = "hud-cell hud-left";
hudCenterEl.className = "hud-cell hud-center";
hudRightEl.className = "hud-cell hud-right";
phaseTimeEl.className = "hud-value";
phaseTimeEl.textContent = "Fase - | Tempo: -";
baseEl.className = "hud-value";
baseEl.textContent = "BASE -";
baseBarWrapEl.className = "base-bar";
baseBarFillEl.className = "base-bar-fill";
baseBarFillEl.style.width = "0%";
baseBarWrapEl.appendChild(baseBarFillEl);
botsEl.className = "hud-value";
botsEl.textContent = "Bots: -/-";
killsEl.className = "hud-value";
killsEl.textContent = "Kills P1: - | P2: -";
eventsEl.id = "hud-event";
eventsEl.textContent = "Ultimo evento: -";
fullMessageEl.textContent = "";

hudLeftEl.appendChild(phaseTimeEl);
hudCenterEl.append(baseEl, baseBarWrapEl);
hudRightEl.append(botsEl, killsEl);
hudTopRowEl.append(hudLeftEl, hudCenterEl, hudRightEl);
hudEl.append(hudTopRowEl, eventsEl, fullMessageEl);

const themeBannerEl = document.createElement("div");
themeBannerEl.id = "theme-banner";
themeBannerEl.textContent = "RIO TIETÊ – SETOR DE MONITORAMENTO / Secretaria do Meio Ambiente – SP";
document.body.appendChild(themeBannerEl);

const menuOverlay = document.createElement("div");
menuOverlay.id = "phase-menu-overlay";
menuOverlay.className = "hidden";

const menuCard = document.createElement("div");
menuCard.className = "briefing-card";
const briefingContent = document.createElement("div");
briefingContent.className = "briefing-content";
const menuLabel = document.createElement("div");
menuLabel.className = "briefing-label";
menuLabel.textContent = "BRIEFING";
const menuTitle = document.createElement("h2");
menuTitle.textContent = "OPERAÇÃO TIETÊ: DEFESA DA ESTAÇÃO";
const menuSubtitle = document.createElement("p");
menuSubtitle.className = "briefing-subtitle";
menuSubtitle.textContent = "Secretaria do Meio Ambiente – SP";

const objectiveTitle = document.createElement("h3");
objectiveTitle.className = "briefing-section-title";
objectiveTitle.textContent = "Objetivo do jogo";
const objectiveText = document.createElement("p");
objectiveText.className = "briefing-text";
objectiveText.textContent =
  "Você faz parte da equipe de inspetores da Secretaria do Meio Ambiente (SP). Proteja os sensores de monitoramento no Rio Tietê contra drones sabotadores e transmita o relatório. Conclua as 3 fases (Salesópolis → Zona Industrial → Grande SP) mantendo a base ativa.";

const controlsTitle = document.createElement("h3");
controlsTitle.className = "briefing-section-title";
controlsTitle.textContent = "Controles";
const controlsText = document.createElement("p");
controlsText.className = "briefing-text";
controlsText.textContent = "WASD/Setas: mover | SPACE/ATIRAR: disparar | R: reparar sensor (perto)";

const networkTitle = document.createElement("h3");
networkTitle.className = "briefing-section-title";
networkTitle.textContent = "Servidor (Rede)";
const serverConfigRow = document.createElement("div");
serverConfigRow.className = "briefing-server-row";
const serverInput = document.createElement("input");
serverInput.type = "text";
serverInput.className = "briefing-server-input";
serverInput.placeholder = WS_SERVER_PLACEHOLDER;
serverInput.value = configuredWsServer;
serverInput.autocapitalize = "off";
serverInput.autocomplete = "off";
serverInput.spellcheck = false;
const serverSaveButton = document.createElement("button");
serverSaveButton.type = "button";
serverSaveButton.className = "briefing-server-save";
serverSaveButton.textContent = "SALVAR";
serverConfigRow.append(serverInput, serverSaveButton);

const serverHelpText = document.createElement("p");
serverHelpText.className = "briefing-help";
serverHelpText.textContent = "Dica: use o IP do notebook na mesma rede/hotspot. Ex: 192.168.43.120:8080";
const serverCurrentText = document.createElement("p");
serverCurrentText.className = "briefing-server-current";

const playButton = document.createElement("button");
playButton.type = "button";
playButton.className = "overlay-btn briefing-play-btn";
playButton.textContent = "JOGAR";

briefingContent.append(
  menuLabel,
  menuTitle,
  menuSubtitle,
  objectiveTitle,
  objectiveText,
  controlsTitle,
  controlsText,
  networkTitle,
  serverConfigRow,
  serverHelpText,
  serverCurrentText
);
menuCard.append(briefingContent, playButton);
menuOverlay.appendChild(menuCard);
document.body.appendChild(menuOverlay);
refreshCurrentServerText();

const gameOverOverlay = document.createElement("div");
gameOverOverlay.id = "gameover-overlay";
gameOverOverlay.className = "hidden";

const gameOverCard = document.createElement("div");
gameOverCard.className = "gameover-card";
const gameOverTitle = document.createElement("h2");
gameOverTitle.id = "gameover-title";
const gameOverSummaryEl = document.createElement("div");
gameOverSummaryEl.id = "gameover-summary";

const restartButton = document.createElement("button");
restartButton.type = "button";
restartButton.className = "overlay-btn";
restartButton.textContent = "RESTARTAR MISSAO";

const backToMenuButton = document.createElement("button");
backToMenuButton.type = "button";
backToMenuButton.className = "overlay-btn secondary";
backToMenuButton.textContent = "VOLTAR AO BRIEFING";

gameOverCard.append(gameOverTitle, gameOverSummaryEl, restartButton, backToMenuButton);
gameOverOverlay.appendChild(gameOverCard);
document.body.appendChild(gameOverOverlay);

const phaseTransitionOverlay = document.createElement("div");
phaseTransitionOverlay.id = "phase-transition-overlay";
phaseTransitionOverlay.className = "hidden";

const phaseTransitionCard = document.createElement("div");
phaseTransitionCard.className = "phase-transition-card";
const phaseTransitionTitle = document.createElement("h2");
phaseTransitionTitle.id = "phase-transition-title";
const phaseTransitionSubtitle = document.createElement("p");
phaseTransitionSubtitle.id = "phase-transition-subtitle";

phaseTransitionCard.append(phaseTransitionTitle, phaseTransitionSubtitle);
phaseTransitionOverlay.appendChild(phaseTransitionCard);
document.body.appendChild(phaseTransitionOverlay);

const trechoToastEl = document.createElement("div");
trechoToastEl.id = "trecho-toast";
trechoToastEl.className = "hidden";
const trechoToastMainEl = document.createElement("div");
trechoToastMainEl.className = "trecho-main";
const trechoToastBriefEl = document.createElement("div");
trechoToastBriefEl.className = "trecho-brief";
trechoToastEl.append(trechoToastMainEl, trechoToastBriefEl);
document.body.appendChild(trechoToastEl);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x5b6f7f);
scene.fog = new THREE.Fog(0x5b6f7f, 18, 58);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 10, 16);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const ambientLight = new THREE.AmbientLight(0xf1f5ff, 0.55);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xfff8e5, 0.95);
dirLight.position.set(14, 20, 8);
scene.add(dirLight);

let environmentGroup: THREE.Group | null = null;

type SkyBannerRig = {
  group: THREE.Group;
  plane: THREE.Group;
  propeller: THREE.Group;
  bannerPivot: THREE.Group;
  bannerMesh: THREE.Mesh;
  rope: THREE.Line;
  ropePositions: Float32Array;
  ropeStart: THREE.Vector3;
  ropeEndBase: THREE.Vector3;
  speed: number;
  loopLimitX: number;
  loopOffsetX: number;
};

type BotExplosionParticle = {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  spinX: number;
  spinY: number;
  ttl: number;
  age: number;
  startScale: number;
  scaleGrow: number;
};

type BotExplosionFx = {
  group: THREE.Group;
  age: number;
  ttl: number;
  flash: THREE.Mesh;
  shockwave: THREE.Mesh;
  fragments: BotExplosionParticle[];
  smoke: BotExplosionParticle[];
};

type InspectorRig = {
  locomotionRoot: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  scannerTip: THREE.Mesh;
  baseY: number;
  armBasePitch: number;
  legBasePitch: number;
  moveBlend: number;
  stepPhase: number;
  dead: boolean;
};

const playerMeshes = new Map<string, THREE.Group>();
type SensorVisual = {
  group: THREE.Group;
  base: THREE.Mesh;
  mast: THREE.Mesh;
  antenna: THREE.Mesh;
  panel: THREE.Mesh;
  led: THREE.Mesh;
  attackRing: THREE.Mesh;
  alertMarker: THREE.Mesh;
  repairParticles: THREE.Mesh[];
  pulseOffset: number;
};
const sensorMeshes = new Map<string, SensorVisual>();
type ProjectileVisual = {
  mesh: THREE.Mesh;
  isPlayerBeam: boolean;
  baseOpacity: number;
  baseEmissiveIntensity: number;
  lastUpdateAtMs: number;
  fadeStartedAtMs: number | null;
  lastX: number;
  lastZ: number;
  dirX: number;
  dirZ: number;
};
const projectileMeshes = new Map<string, ProjectileVisual>();
type DroneVisual = {
  group: THREE.Group;
  rotors: THREE.Group[];
  baseY: number;
  bobPhase: number;
};
const botMeshes = new Map<string, DroneVisual>();
type SensorLabelRef = {
  sprite: THREE.Sprite;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  lastSignature: string;
};
const sensorLabels = new Map<string, SensorLabelRef>();

const cameraLookTarget = new THREE.Vector3(0, 0, 0);
const ring = new THREE.Mesh(
  new THREE.TorusGeometry(0.75, 0.08, 12, 24),
  new THREE.MeshStandardMaterial({ color: 0xf8fafc, emissive: 0x334155 })
);
ring.rotation.x = Math.PI / 2;
ring.position.y = 0.05;
ring.visible = false;
scene.add(ring);

const aimArrow = new THREE.ArrowHelper(
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(0, 0.8, 0),
  2.1,
  0xe2e8f0,
  0.7,
  0.45
);
aimArrow.visible = false;
scene.add(aimArrow);

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let myId: string | null = null;
let gameOverResult: "win" | "lose" | null = null;
let isSpaceHeld = false;
let isShootButtonHeld = false;
let isRepairHeld = false;
let isHealButtonHeld = false;
let isRepairRequestActive = false;
let currentRepairRequestSensorId: string | null = null;
let lastShotAtMs = 0;
let lastRepairSendAtMs = 0;
let lastRepairHintAtMs = 0;
let localShotFlashTimer = 0;
let phaseTransitionHideTimer: number | null = null;
let trechoToastHideTimer: number | null = null;
let lastTrechoToastPhase: number | null = null;
let lastTrechoToastAtMs = 0;

let latestPlayers: Record<string, PlayerState> = {};
let latestSensors: Record<string, SensorState> = {};
let latestBots: Record<string, BotState> = {};
let latestMeta: StateMeta | null = null;
let lastServerPhaseLevel: number | null = null;

let previousBotCount = 0;
const previousSensorHp = new Map<string, number>();
const sensorDamageLogAt = new Map<string, number>();

const eventFeed: string[] = [];
const keys: KeysState = {
  up: false,
  down: false,
  left: false,
  right: false,
};
const touchKeys: KeysState = {
  up: false,
  down: false,
  left: false,
  right: false,
};
let joystickPointerId: number | null = null;

function isTouchControlMode() {
  return window.matchMedia("(pointer: coarse)").matches || window.innerWidth <= JOYSTICK_TOUCH_BREAKPOINT;
}

function getCombinedKeysSnapshot(): KeysState {
  return {
    up: keys.up || touchKeys.up,
    down: keys.down || touchKeys.down,
    left: keys.left || touchKeys.left,
    right: keys.right || touchKeys.right,
  };
}

function setTouchMovement(up: boolean, down: boolean, left: boolean, right: boolean) {
  if (touchKeys.up === up && touchKeys.down === down && touchKeys.left === left && touchKeys.right === right) {
    return;
  }
  touchKeys.up = up;
  touchKeys.down = down;
  touchKeys.left = left;
  touchKeys.right = right;
  refreshLastMoveDir();
}

function clearTouchMovementInput() {
  setTouchMovement(false, false, false, false);
}

const lastMoveDir = new THREE.Vector2(0, -1);
const clock = new THREE.Clock();
const projectileBeamUp = new THREE.Vector3(0, 1, 0);
const projectileBeamDir = new THREE.Vector3();
const projectileBeamQuat = new THREE.Quaternion();
const botExplosionFxList: BotExplosionFx[] = [];
const prevBotIds = new Set<string>();
const lastBotPos = new Map<string, { x: number; z: number }>();
let suppressBotDeathFx = true;

const RIVER_MIN_X = -3.95;
const RIVER_MAX_X = 3.95;
const RIVER_BLOCK_MARGIN = 0.14;
const BRIDGE_Z = -2.8;
const BRIDGE_DEPTH = 2.2;
const BRIDGE_HALF_DEPTH = BRIDGE_DEPTH * 0.5;

let riverBoatGroup: THREE.Group | null = null;
let riverBoatBaseY = 0;
let riverBoatPhase = 0;
let riverBoatNavLights: Array<{ mesh: THREE.Mesh; baseIntensity: number; phaseOffset: number }> = [];
let skyBannerTexture: THREE.CanvasTexture | null = null;
let skyBannerRig: SkyBannerRig | null = null;

function markSharedGeometry<T extends THREE.BufferGeometry>(geometry: T) {
  geometry.userData.skipDispose = true;
  return geometry;
}

function markSharedMaterial<T extends THREE.Material>(material: T) {
  material.userData.skipDispose = true;
  return material;
}

function createBoatHullShape() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.64, 0.92);
  shape.lineTo(0.64, 0.92);
  shape.lineTo(0.56, -0.05);
  shape.lineTo(0.36, -0.62);
  shape.lineTo(0, -1.18);
  shape.lineTo(-0.36, -0.62);
  shape.lineTo(-0.56, -0.05);
  shape.closePath();
  return shape;
}

const boatGeometryCache = (() => {
  const hullShape = createBoatHullShape();
  const hull = markSharedGeometry(
    new THREE.ExtrudeGeometry(hullShape, {
      depth: 0.34,
      bevelEnabled: false,
      steps: 1,
      curveSegments: 1,
    })
  );
  hull.rotateX(-Math.PI / 2);

  const deck = markSharedGeometry(new THREE.ShapeGeometry(hullShape, 1));
  deck.rotateX(-Math.PI / 2);

  return {
    hull,
    deck,
    hullRim: markSharedGeometry(new THREE.BoxGeometry(1.18, 0.06, 1.74)),
    cabin: markSharedGeometry(new THREE.BoxGeometry(0.72, 0.34, 0.52)),
    windowPlane: markSharedGeometry(new THREE.PlaneGeometry(0.54, 0.2)),
    sideWindow: markSharedGeometry(new THREE.PlaneGeometry(0.35, 0.16)),
    motor: markSharedGeometry(new THREE.BoxGeometry(0.34, 0.22, 0.26)),
    buoy: markSharedGeometry(new THREE.TorusGeometry(0.12, 0.03, 8, 14)),
    mast: markSharedGeometry(new THREE.CylinderGeometry(0.018, 0.018, 0.36, 8)),
    light: markSharedGeometry(new THREE.SphereGeometry(0.045, 10, 10)),
  };
})();

const boatMaterialCache = {
  hull: markSharedMaterial(new THREE.MeshStandardMaterial({ color: 0x4b2e1a, roughness: 0.78, metalness: 0.08 })),
  hullAccent: markSharedMaterial(new THREE.MeshStandardMaterial({ color: 0x6b3d20, roughness: 0.74, metalness: 0.1 })),
  deck: markSharedMaterial(new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.72, metalness: 0.1 })),
  cabin: markSharedMaterial(new THREE.MeshStandardMaterial({ color: 0xdbe2ea, roughness: 0.5, metalness: 0.18 })),
  metal: markSharedMaterial(new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.46, metalness: 0.34 })),
  glass: markSharedMaterial(
    new THREE.MeshStandardMaterial({
      color: 0x9ed2ef,
      transparent: true,
      opacity: 0.5,
      roughness: 0.12,
      metalness: 0.1,
      side: THREE.DoubleSide,
    })
  ),
  lightRed: markSharedMaterial(
    new THREE.MeshStandardMaterial({
      color: 0xf87171,
      emissive: 0xb91c1c,
      emissiveIntensity: 0.8,
      roughness: 0.18,
      metalness: 0.08,
    })
  ),
  lightGreen: markSharedMaterial(
    new THREE.MeshStandardMaterial({
      color: 0x4ade80,
      emissive: 0x166534,
      emissiveIntensity: 0.8,
      roughness: 0.18,
      metalness: 0.08,
    })
  ),
};

function createBox(
  target: THREE.Group,
  width: number,
  height: number,
  depth: number,
  x: number,
  z: number,
  color: number,
  yBase = 0,
  roughness = 0.9
) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    new THREE.MeshStandardMaterial({ color, roughness })
  );
  mesh.position.set(x, yBase + height / 2, z);
  target.add(mesh);
  return mesh;
}

const INDUSTRY_LARGE_WIDTH_THRESHOLD = 2.2;
const INDUSTRY_LARGE_HEIGHT_THRESHOLD = 3.1;
const INDUSTRY_LARGE_VOLUME_THRESHOLD = 14.5;

const industryGeometryCache = {
  unitBox: markSharedGeometry(new THREE.BoxGeometry(1, 1, 1)),
  chimney: markSharedGeometry(new THREE.CylinderGeometry(0.2, 0.24, 1, 8)),
  pipe: markSharedGeometry(new THREE.CylinderGeometry(0.08, 0.08, 1, 8)),
  tank: markSharedGeometry(new THREE.CylinderGeometry(0.22, 0.22, 1, 10)),
};

const industryMaterialCache = {
  main: markSharedMaterial(new THREE.MeshStandardMaterial({ color: 0x8b929b, roughness: 0.9, metalness: 0.08 })),
  annex: markSharedMaterial(new THREE.MeshStandardMaterial({ color: 0x767d86, roughness: 0.9, metalness: 0.08 })),
  metal: markSharedMaterial(new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.84, metalness: 0.22 })),
  stripe: markSharedMaterial(new THREE.MeshStandardMaterial({ color: 0xa3adb8, roughness: 0.8, metalness: 0.1 })),
};

function createIndustrySmall(target: THREE.Group, x: number, z: number, w: number, h: number, d: number) {
  const industry = new THREE.Group();
  industry.position.set(x, 0, z);

  const block = new THREE.Mesh(industryGeometryCache.unitBox, industryMaterialCache.main);
  block.scale.set(w, h, d);
  block.position.set(0, h / 2, 0);
  industry.add(block);

  const chimneyHeight = Math.max(1.8, h * 0.62);
  const chimneyRadius = Math.max(0.12, Math.min(w, d) * 0.1);
  const chimneyScale = chimneyRadius / 0.24;
  const chimney = new THREE.Mesh(industryGeometryCache.chimney, industryMaterialCache.metal);
  chimney.scale.set(chimneyScale, chimneyHeight, chimneyScale);
  chimney.position.set(w * 0.28, h + chimneyHeight / 2, -d * 0.22);
  industry.add(chimney);

  target.add(industry);
}

function createIndustryLarge(target: THREE.Group, x: number, z: number, w: number, h: number, d: number, addTank: boolean) {
  const industry = new THREE.Group();
  industry.position.set(x, 0, z);

  const mainWidth = w * 0.64;
  const mainHeight = h;
  const mainDepth = d * 0.9;
  const main = new THREE.Mesh(industryGeometryCache.unitBox, industryMaterialCache.main);
  main.scale.set(mainWidth, mainHeight, mainDepth);
  main.position.set(w * 0.12, mainHeight / 2, 0);
  industry.add(main);

  const annexWidth = w * 0.38;
  const annexHeight = h * 0.56;
  const annexDepth = d * 0.6;
  const annex = new THREE.Mesh(industryGeometryCache.unitBox, industryMaterialCache.annex);
  annex.scale.set(annexWidth, annexHeight, annexDepth);
  annex.position.set(-w * 0.28, annexHeight / 2, d * 0.18);
  industry.add(annex);

  const stripe = new THREE.Mesh(industryGeometryCache.unitBox, industryMaterialCache.stripe);
  stripe.scale.set(mainWidth * 0.88, Math.max(0.08, h * 0.045), 0.06);
  stripe.position.set(main.position.x, h * 0.64, mainDepth * 0.5 + 0.04);
  industry.add(stripe);

  const chimneyPrimaryHeight = Math.max(2.6, h * 0.75);
  const chimneySecondaryHeight = chimneyPrimaryHeight * 0.82;
  const chimneyPrimaryScale = Math.max(0.55, Math.min(w, d) * 0.24);
  const chimneySecondaryScale = chimneyPrimaryScale * 0.86;

  const chimneyA = new THREE.Mesh(industryGeometryCache.chimney, industryMaterialCache.metal);
  chimneyA.scale.set(chimneyPrimaryScale, chimneyPrimaryHeight, chimneyPrimaryScale);
  chimneyA.position.set(main.position.x + mainWidth * 0.24, h + chimneyPrimaryHeight / 2, -mainDepth * 0.2);
  industry.add(chimneyA);

  const chimneyB = new THREE.Mesh(industryGeometryCache.chimney, industryMaterialCache.metal);
  chimneyB.scale.set(chimneySecondaryScale, chimneySecondaryHeight, chimneySecondaryScale);
  chimneyB.position.set(main.position.x - mainWidth * 0.3, h + chimneySecondaryHeight / 2, mainDepth * 0.18);
  industry.add(chimneyB);

  const pipeLength = Math.max(0.42, Math.abs(main.position.x - annex.position.x) - mainWidth * 0.2);
  const pipe = new THREE.Mesh(industryGeometryCache.pipe, industryMaterialCache.metal);
  pipe.scale.set(1, pipeLength, 1);
  pipe.rotation.z = Math.PI / 2;
  pipe.position.set((main.position.x + annex.position.x) * 0.5, annexHeight * 0.74, d * 0.1);
  industry.add(pipe);

  const secondaryPipe = new THREE.Mesh(industryGeometryCache.pipe, industryMaterialCache.metal);
  secondaryPipe.scale.set(1, pipeLength * 0.88, 1);
  secondaryPipe.rotation.z = Math.PI / 2;
  secondaryPipe.position.set((main.position.x + annex.position.x) * 0.5, annexHeight * 0.52, -d * 0.04);
  industry.add(secondaryPipe);

  if (addTank) {
    const tankLength = Math.max(0.5, d * 0.5);
    const tank = new THREE.Mesh(industryGeometryCache.tank, industryMaterialCache.metal);
    tank.scale.set(1, tankLength, 1);
    tank.rotation.x = Math.PI / 2;
    tank.position.set(annex.position.x - annexWidth * 0.08, annexHeight * 0.62, d * 0.42);
    industry.add(tank);
  }

  target.add(industry);
}

function isLargeIndustry(width: number, height: number, depth: number) {
  const volume = width * height * depth;
  return (
    width >= INDUSTRY_LARGE_WIDTH_THRESHOLD ||
    height >= INDUSTRY_LARGE_HEIGHT_THRESHOLD ||
    volume >= INDUSTRY_LARGE_VOLUME_THRESHOLD
  );
}

function createIndustry(target: THREE.Group, x: number, z: number, w: number, h: number, d: number, chimney = false) {
  if (isLargeIndustry(w, h, d)) {
    createIndustryLarge(target, x, z, w, h, d, chimney || w * h * d >= 17);
    return;
  }
  createIndustrySmall(target, x, z, w, h, d);
}

function addRiver(target: THREE.Group) {
  createBox(target, 8, 0.3, 44, 0, 0, 0x1e3a8a, -0.3, 0.45);
  createBox(target, 6, 0.2, 44, -7, 0, 0x607f45, -0.2, 0.95);
  createBox(target, 6, 0.2, 44, 7, 0, 0x6e8451, -0.2, 0.95);
}

function createBridge(target: THREE.Group) {
  const bridgeGroup = new THREE.Group();

  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(8.8, 0.24, BRIDGE_DEPTH),
    new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.72, metalness: 0.08 })
  );
  deck.position.set(0, 0.13, BRIDGE_Z);
  bridgeGroup.add(deck);

  const railMaterial = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.55, metalness: 0.35 });
  const leftRail = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 8.8, 10), railMaterial);
  leftRail.rotation.z = Math.PI / 2;
  leftRail.position.set(0, 0.56, BRIDGE_Z - BRIDGE_HALF_DEPTH + 0.12);
  bridgeGroup.add(leftRail);

  const rightRail = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 8.8, 10), railMaterial);
  rightRail.rotation.z = Math.PI / 2;
  rightRail.position.set(0, 0.56, BRIDGE_Z + BRIDGE_HALF_DEPTH - 0.12);
  bridgeGroup.add(rightRail);

  const supportMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.68, metalness: 0.2 });
  const supportZ = [BRIDGE_Z - 0.75, BRIDGE_Z + 0.75];
  const supportX = [-3.8, -1.5, 1.5, 3.8];
  for (const sx of supportX) {
    for (const sz of supportZ) {
      const support = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.38, 0.22), supportMat);
      support.position.set(sx, -0.02, sz);
      bridgeGroup.add(support);
    }
  }

  target.add(bridgeGroup);
}

function createBoat(target: THREE.Group) {
  const boat = new THREE.Group();

  const hull = new THREE.Mesh(boatGeometryCache.hull, boatMaterialCache.hull);
  hull.position.y = 0.02;
  boat.add(hull);

  const deck = new THREE.Mesh(boatGeometryCache.deck, boatMaterialCache.deck);
  deck.position.y = 0.352;
  boat.add(deck);

  const hullRim = new THREE.Mesh(boatGeometryCache.hullRim, boatMaterialCache.hullAccent);
  hullRim.position.set(0, 0.335, 0.08);
  boat.add(hullRim);

  const cabin = new THREE.Mesh(boatGeometryCache.cabin, boatMaterialCache.cabin);
  cabin.position.set(-0.04, 0.54, -0.08);
  boat.add(cabin);

  const windshield = new THREE.Mesh(boatGeometryCache.windowPlane, boatMaterialCache.glass);
  windshield.position.set(-0.04, 0.62, 0.2);
  windshield.rotation.x = -0.42;
  boat.add(windshield);

  const leftWindow = new THREE.Mesh(boatGeometryCache.sideWindow, boatMaterialCache.glass);
  leftWindow.position.set(-0.41, 0.58, -0.08);
  leftWindow.rotation.y = Math.PI / 2;
  boat.add(leftWindow);

  const rightWindow = new THREE.Mesh(boatGeometryCache.sideWindow, boatMaterialCache.glass);
  rightWindow.position.set(0.33, 0.58, -0.08);
  rightWindow.rotation.y = -Math.PI / 2;
  boat.add(rightWindow);

  const motor = new THREE.Mesh(boatGeometryCache.motor, boatMaterialCache.metal);
  motor.position.set(0, 0.45, -0.9);
  boat.add(motor);

  const mast = new THREE.Mesh(boatGeometryCache.mast, boatMaterialCache.metal);
  mast.position.set(0.45, 0.56, -0.02);
  boat.add(mast);

  const buoy = new THREE.Mesh(boatGeometryCache.buoy, boatMaterialCache.hullAccent);
  buoy.position.set(0.78, 0.38, -0.2);
  buoy.rotation.y = Math.PI / 2;
  boat.add(buoy);

  const redLight = new THREE.Mesh(boatGeometryCache.light, boatMaterialCache.lightRed);
  redLight.position.set(-0.2, 0.41, 1.02);
  boat.add(redLight);

  const greenLight = new THREE.Mesh(boatGeometryCache.light, boatMaterialCache.lightGreen);
  greenLight.position.set(0.2, 0.41, 1.02);
  boat.add(greenLight);

  riverBoatBaseY = 0.03;
  riverBoatPhase = 1.25;
  boat.position.set(0, riverBoatBaseY, 5.2);

  riverBoatNavLights = [
    { mesh: redLight, baseIntensity: 0.78, phaseOffset: 0 },
    { mesh: greenLight, baseIntensity: 0.78, phaseOffset: 1.7 },
  ];

  target.add(boat);
  riverBoatGroup = boat;
}

function createBannerTexture() {
  if (skyBannerTexture) {
    return skyBannerTexture;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }

  drawBannerTexture(ctx, canvas);

  skyBannerTexture = new THREE.CanvasTexture(canvas);
  skyBannerTexture.needsUpdate = true;
  skyBannerTexture.minFilter = THREE.LinearFilter;
  skyBannerTexture.magFilter = THREE.LinearFilter;
  return skyBannerTexture;
}

function createPlane() {
  const group = new THREE.Group();

  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.45, metalness: 0.3 });
  const trimMaterial = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.5, metalness: 0.2 });
  const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.4, metalness: 0.4 });
  bodyMaterial.fog = false;
  trimMaterial.fog = false;
  darkMaterial.fog = false;

  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.09, 1.5, 8), bodyMaterial);
  fuselage.rotation.z = -Math.PI / 2;
  group.add(fuselage);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.36, 8), trimMaterial);
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 0.92;
  group.add(nose);

  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.15, 0.24), darkMaterial);
  cockpit.position.set(0.15, 0.16, 0);
  group.add(cockpit);

  const wing = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.04, 1.65), trimMaterial);
  wing.position.set(-0.06, 0, 0);
  group.add(wing);

  const tailWing = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.03, 0.72), trimMaterial);
  tailWing.position.set(-0.66, 0.04, 0);
  group.add(tailWing);

  const tailFin = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.04), trimMaterial);
  tailFin.position.set(-0.7, 0.2, 0);
  group.add(tailFin);

  const propeller = new THREE.Group();
  const bladeA = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.64, 0.07), darkMaterial);
  const bladeB = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.07, 0.64), darkMaterial);
  propeller.add(bladeA);
  propeller.add(bladeB);
  propeller.position.set(1.04, 0, 0);
  group.add(propeller);

  group.scale.set(1.05, 1.05, 1.05);
  return { group, propeller };
}

function createSkyBannerRig() {
  const rigGroup = new THREE.Group();

  const { group: plane, propeller } = createPlane();
  rigGroup.add(plane);

  const bannerPivot = new THREE.Group();
  bannerPivot.position.set(-3.95, -0.12, 0);

  const bannerTexture = createBannerTexture();
  const bannerMaterial = new THREE.MeshBasicMaterial({
    color: 0xf8fafc,
    map: bannerTexture ?? undefined,
    transparent: true,
    side: THREE.DoubleSide,
  });
  bannerMaterial.fog = false;
  const bannerMesh = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 1.28), bannerMaterial);
  bannerPivot.add(bannerMesh);
  rigGroup.add(bannerPivot);

  const ropeStart = new THREE.Vector3(-0.84, -0.03, 0);
  const ropeEndBase = new THREE.Vector3(-1.3, -0.1, 0);
  const ropePositions = new Float32Array([
    ropeStart.x,
    ropeStart.y,
    ropeStart.z,
    ropeEndBase.x,
    ropeEndBase.y,
    ropeEndBase.z,
  ]);
  const ropeGeometry = new THREE.BufferGeometry();
  ropeGeometry.setAttribute("position", new THREE.BufferAttribute(ropePositions, 3));
  const rope = new THREE.Line(
    ropeGeometry,
    new THREE.LineBasicMaterial({ color: 0xcbd5e1, transparent: true, opacity: 0.92 })
  );
  (rope.material as THREE.LineBasicMaterial).fog = false;
  rigGroup.add(rope);

  rigGroup.scale.setScalar(SKY_BANNER_SCALE);
  rigGroup.position.set(-SKY_BANNER_LOOP_LIMIT_X, camera.position.y + SKY_BANNER_FOLLOW_Y_OFFSET, camera.position.z + SKY_BANNER_FOLLOW_Z_OFFSET);

  return {
    group: rigGroup,
    plane,
    propeller,
    bannerPivot,
    bannerMesh,
    rope,
    ropePositions,
    ropeStart,
    ropeEndBase,
    speed: SKY_BANNER_SPEED,
    loopLimitX: SKY_BANNER_LOOP_LIMIT_X,
    loopOffsetX: -SKY_BANNER_LOOP_LIMIT_X,
  } satisfies SkyBannerRig;
}

function ensureSkyBannerRig() {
  if (skyBannerRig) {
    return;
  }

  skyBannerRig = createSkyBannerRig();
  scene.add(skyBannerRig.group);
  console.log("skyRig created", skyBannerRig.group.position);
}

function drawBannerTexture(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(15,23,42,0.9)";
  ctx.fillRect(12, 12, canvas.width - 24, canvas.height - 24);
  ctx.strokeStyle = "rgba(186,230,253,0.95)";
  ctx.lineWidth = 8;
  ctx.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f8fafc";
  ctx.font = SKY_BANNER_TITLE_FONT;
  ctx.fillText("RIO TIETÊ", canvas.width / 2, 98);
  ctx.fillStyle = "#bae6fd";
  ctx.font = SKY_BANNER_SUBTITLE_FONT;
  ctx.fillText("Monitoramento – Secretaria do Meio Ambiente (SP)", canvas.width / 2, 186);
}

function refreshBannerTexture() {
  if (!skyBannerTexture) {
    const created = createBannerTexture();
    if (created && skyBannerRig) {
      const bannerMaterial = skyBannerRig.bannerMesh.material as THREE.MeshBasicMaterial;
      bannerMaterial.map = created;
      bannerMaterial.needsUpdate = true;
    }
    return;
  }

  const canvas = skyBannerTexture.image;
  if (!(canvas instanceof HTMLCanvasElement)) {
    return;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  drawBannerTexture(ctx, canvas);
  skyBannerTexture.needsUpdate = true;

  if (skyBannerRig) {
    const bannerMaterial = skyBannerRig.bannerMesh.material as THREE.MeshBasicMaterial;
    bannerMaterial.map = skyBannerTexture;
    bannerMaterial.needsUpdate = true;
  }
}

function updateSkyBannerRope(rig: SkyBannerRig, swayY: number, swayZ: number, bob: number) {
  const ropeEndX = rig.ropeEndBase.x + swayY * 1.5;
  const ropeEndY = rig.ropeEndBase.y + bob * 0.85;
  const ropeEndZ = rig.ropeEndBase.z + swayZ * 1.8;

  rig.ropePositions[0] = rig.ropeStart.x;
  rig.ropePositions[1] = rig.ropeStart.y;
  rig.ropePositions[2] = rig.ropeStart.z;
  rig.ropePositions[3] = ropeEndX;
  rig.ropePositions[4] = ropeEndY;
  rig.ropePositions[5] = ropeEndZ;
  const positionAttr = rig.rope.geometry.getAttribute("position") as THREE.BufferAttribute;
  positionAttr.needsUpdate = true;
}

function animateSkyBanner(deltaSec: number, nowMs: number) {
  if (!skyBannerRig) {
    return;
  }

  const timeSec = nowMs / 1000;
  skyBannerRig.loopOffsetX += skyBannerRig.speed * deltaSec;
  if (skyBannerRig.loopOffsetX > skyBannerRig.loopLimitX) {
    skyBannerRig.loopOffsetX = -skyBannerRig.loopLimitX;
  }

  skyBannerRig.group.position.x = camera.position.x + skyBannerRig.loopOffsetX;
  skyBannerRig.group.position.y = camera.position.y + SKY_BANNER_FOLLOW_Y_OFFSET + Math.sin(timeSec * 0.5) * 0.16;
  skyBannerRig.group.position.z = camera.position.z + SKY_BANNER_FOLLOW_Z_OFFSET;
  skyBannerRig.propeller.rotation.x += deltaSec * 22;

  const swayZ = Math.sin(timeSec * 2) * 0.08;
  const swayY = Math.sin(timeSec * 1.3) * 0.05;
  const bob = Math.sin(timeSec * 2.1 + 0.55) * 0.05;
  skyBannerRig.bannerPivot.rotation.z = swayZ;
  skyBannerRig.bannerPivot.rotation.y = swayY;
  skyBannerRig.bannerPivot.position.y = -0.12 + bob;
  updateSkyBannerRope(skyBannerRig, swayY, swayZ, bob);
}

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  if (Array.isArray(material)) {
    for (const item of material) {
      item.dispose();
    }
    return;
  }
  material.dispose();
}

function clearEnvironment() {
  if (!environmentGroup) {
    riverBoatGroup = null;
    riverBoatNavLights = [];
    return;
  }

  environmentGroup.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry && !mesh.geometry.userData?.skipDispose) {
      mesh.geometry.dispose();
    }
    if (mesh.material) {
      if (Array.isArray(mesh.material)) {
        for (const item of mesh.material) {
          if (!item.userData?.skipDispose) {
            item.dispose();
          }
        }
      } else if (!(mesh.material as THREE.Material).userData?.skipDispose) {
        (mesh.material as THREE.Material).dispose();
      }
    }
  });

  scene.remove(environmentGroup);
  environmentGroup.clear();
  environmentGroup = null;
  riverBoatGroup = null;
  riverBoatNavLights = [];
}

function buildEnvironmentForPhase(phase: PhaseLevel) {
  clearEnvironment();
  activeMapId = phase;
  environmentGroup = new THREE.Group();
  scene.add(environmentGroup);

  const target = environmentGroup;

  addRiver(target);
  createBridge(target);
  createBoat(target);

  if (phase === 1) {
    const industry = [
      { x: -8.0, z: -11, w: 2.1, h: 2.9, d: 2.1, c: true },
      { x: -6.2, z: 2, w: 1.7, h: 2.4, d: 1.8, c: false },
      { x: 8.2, z: -8, w: 2.2, h: 3.2, d: 2.1, c: true },
      { x: 6.2, z: 6, w: 1.9, h: 2.6, d: 2.0, c: false },
      { x: 7.9, z: 13, w: 2.0, h: 2.8, d: 2.0, c: false },
    ];
    for (const i of industry) {
      createIndustry(target, i.x, i.z, i.w, i.h, i.d, i.c);
    }
  }

  if (phase === 2) {
    const industry = [
      { x: -8.3, z: -13, w: 2.4, h: 3.2, d: 2.3, c: true },
      { x: -6.2, z: -5, w: 1.9, h: 2.6, d: 2.0, c: false },
      { x: -8.5, z: 3, w: 2.5, h: 3.8, d: 2.6, c: false },
      { x: -6.5, z: 10, w: 2.0, h: 2.7, d: 1.9, c: false },
      { x: 8.4, z: -12, w: 2.4, h: 3.6, d: 2.2, c: true },
      { x: 6.1, z: -2, w: 1.9, h: 2.5, d: 1.8, c: false },
      { x: 8.7, z: 7, w: 2.6, h: 3.8, d: 2.4, c: false },
      { x: 6.2, z: 13, w: 1.8, h: 2.4, d: 1.9, c: false },
    ];

    for (const i of industry) {
      createIndustry(target, i.x, i.z, i.w, i.h, i.d, i.c);
    }

    createBox(target, 1.8, 1.2, 3.2, -6.7, -1.0, 0x475569);
    createBox(target, 1.8, 1.2, 3.2, 6.7, 1.0, 0x475569);
    createBox(target, 2.4, 0.9, 1.2, -7.8, 5.2, 0x334155);
    createBox(target, 2.4, 0.9, 1.2, 7.8, -6.2, 0x334155);
  }

  if (phase === 3) {
    const industry = [
      { x: -8.4, z: -13, w: 2.5, h: 3.8, d: 2.4, c: true },
      { x: -6.2, z: -8, w: 2.0, h: 2.8, d: 2.0, c: false },
      { x: -8.6, z: -2, w: 2.4, h: 3.4, d: 2.4, c: true },
      { x: -6.3, z: 4, w: 1.9, h: 2.5, d: 1.8, c: false },
      { x: -8.0, z: 10, w: 2.2, h: 3.2, d: 2.1, c: false },
      { x: 8.3, z: -13, w: 2.4, h: 3.7, d: 2.3, c: true },
      { x: 6.2, z: -7, w: 1.9, h: 2.6, d: 1.8, c: false },
      { x: 8.8, z: -1, w: 2.7, h: 4.1, d: 2.5, c: false },
      { x: 6.1, z: 5, w: 2.0, h: 2.7, d: 1.8, c: false },
      { x: 8.0, z: 11, w: 2.2, h: 3.3, d: 2.0, c: false },
    ];

    for (const i of industry) {
      createIndustry(target, i.x, i.z, i.w, i.h, i.d, i.c);
    }

    createBox(target, 1.2, 1.2, 6.0, -5.8, 0, 0x334155);
    createBox(target, 1.2, 1.2, 6.0, 5.8, 0, 0x334155);
    createBox(target, 2.8, 1.0, 1.0, -7.2, -4.2, 0x475569);
    createBox(target, 2.8, 1.0, 1.0, 7.2, 4.2, 0x475569);
    createBox(target, 2.2, 1.0, 1.0, -7.8, 7.2, 0x475569);
    createBox(target, 2.2, 1.0, 1.0, 7.8, -7.2, 0x475569);
  }
}

type InspectorTheme = {
  accent: number;
  accentDark: number;
  accentSoft: number;
};

type InspectorMaterialSet = {
  suit: THREE.MeshStandardMaterial;
  suitAccent: THREE.MeshStandardMaterial;
  helmet: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
  vest: THREE.MeshStandardMaterial;
  vestStripe: THREE.MeshStandardMaterial;
  limb: THREE.MeshStandardMaterial;
  boot: THREE.MeshStandardMaterial;
  gear: THREE.MeshStandardMaterial;
  emitter: THREE.MeshStandardMaterial;
};

const inspectorGeometryCache = {
  torso: new THREE.CapsuleGeometry(0.2, 0.52, 4, 8),
  head: new THREE.SphereGeometry(0.16, 10, 10),
  helmet: new THREE.SphereGeometry(0.18, 10, 10),
  chestPlate: new THREE.BoxGeometry(0.34, 0.26, 0.06),
  vestStripe: new THREE.BoxGeometry(0.25, 0.05, 0.064),
  arm: new THREE.CylinderGeometry(0.06, 0.055, 0.42, 8),
  forearm: new THREE.CylinderGeometry(0.05, 0.045, 0.32, 8),
  leg: new THREE.CylinderGeometry(0.07, 0.06, 0.5, 8),
  boot: new THREE.BoxGeometry(0.12, 0.08, 0.22),
  backpack: new THREE.BoxGeometry(0.26, 0.32, 0.16),
  scannerBody: new THREE.BoxGeometry(0.16, 0.1, 0.32),
  scannerBarrel: new THREE.CylinderGeometry(0.035, 0.03, 0.2, 8),
  scannerTip: new THREE.SphereGeometry(0.042, 10, 10),
};

const inspectorMaterialCache = new Map<string, InspectorMaterialSet>();

function getInspectorTheme(playerId: string): InspectorTheme {
  if (playerId === "1") {
    return { accent: 0x16a34a, accentDark: 0x166534, accentSoft: 0x86efac };
  }
  if (playerId === "2") {
    return { accent: 0xea580c, accentDark: 0x9a3412, accentSoft: 0xfdba74 };
  }
  return { accent: 0x0ea5e9, accentDark: 0x0c4a6e, accentSoft: 0x7dd3fc };
}

function getInspectorMaterials(playerId: string): InspectorMaterialSet {
  const key = playerId === "1" ? "p1" : playerId === "2" ? "p2" : "fallback";
  const cached = inspectorMaterialCache.get(key);
  if (cached) {
    return cached;
  }

  const theme = getInspectorTheme(playerId);
  const created: InspectorMaterialSet = {
    suit: new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.6, metalness: 0.08 }),
    suitAccent: new THREE.MeshStandardMaterial({ color: theme.accentDark, roughness: 0.55, metalness: 0.12 }),
    helmet: new THREE.MeshStandardMaterial({ color: theme.accent, roughness: 0.5, metalness: 0.25 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xf1c27d, roughness: 0.75, metalness: 0.05 }),
    vest: new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.52, metalness: 0.08 }),
    vestStripe: new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.45, metalness: 0.1 }),
    limb: new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.6, metalness: 0.15 }),
    boot: new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7, metalness: 0.02 }),
    gear: new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.45, metalness: 0.35 }),
    emitter: new THREE.MeshStandardMaterial({
      color: theme.accentSoft,
      emissive: theme.accent,
      emissiveIntensity: 0.55,
      roughness: 0.18,
      metalness: 0.24,
    }),
  };

  inspectorMaterialCache.set(key, created);
  return created;
}

function getInspectorRig(group: THREE.Group): InspectorRig | undefined {
  return group.userData.inspectorRig as InspectorRig | undefined;
}

function createInspectorMesh(playerId: string, isLocal: boolean): THREE.Group {
  const materials = getInspectorMaterials(playerId);
  const theme = getInspectorTheme(playerId);

  const root = new THREE.Group();
  const locomotionRoot = new THREE.Group();
  root.add(locomotionRoot);
  root.position.y = 0;

  const torso = new THREE.Mesh(inspectorGeometryCache.torso, materials.suit);
  torso.position.set(0, 1.2, 0);
  locomotionRoot.add(torso);

  const sidePlate = new THREE.Mesh(inspectorGeometryCache.chestPlate, materials.suitAccent);
  sidePlate.scale.set(0.55, 0.8, 1);
  sidePlate.position.set(-0.14, 1.2, 0.02);
  sidePlate.rotation.y = 0.28;
  locomotionRoot.add(sidePlate);

  const vest = new THREE.Mesh(inspectorGeometryCache.chestPlate, materials.vest);
  vest.position.set(0, 1.2, -0.18);
  locomotionRoot.add(vest);

  const vestStripe = new THREE.Mesh(inspectorGeometryCache.vestStripe, materials.vestStripe);
  vestStripe.position.set(0, 1.2, -0.214);
  locomotionRoot.add(vestStripe);

  const backpack = new THREE.Mesh(inspectorGeometryCache.backpack, materials.gear);
  backpack.position.set(0, 1.2, 0.2);
  locomotionRoot.add(backpack);

  const batteryTag = new THREE.Mesh(inspectorGeometryCache.vestStripe, materials.suitAccent);
  batteryTag.scale.set(0.8, 0.9, 1);
  batteryTag.position.set(0, 1.22, 0.285);
  locomotionRoot.add(batteryTag);

  const head = new THREE.Mesh(inspectorGeometryCache.head, materials.skin);
  head.position.set(0, 1.66, -0.02);
  locomotionRoot.add(head);

  const helmet = new THREE.Mesh(inspectorGeometryCache.helmet, materials.helmet);
  helmet.scale.set(1.05, 0.68, 1.05);
  helmet.position.set(0, 1.77, -0.01);
  locomotionRoot.add(helmet);

  const helmetBand = new THREE.Mesh(inspectorGeometryCache.vestStripe, materials.suitAccent);
  helmetBand.scale.set(1.05, 0.58, 0.8);
  helmetBand.position.set(0, 1.73, -0.13);
  locomotionRoot.add(helmetBand);

  const leftArm = new THREE.Group();
  leftArm.position.set(-0.3, 1.43, 0);
  locomotionRoot.add(leftArm);

  const leftUpperArm = new THREE.Mesh(inspectorGeometryCache.arm, materials.limb);
  leftUpperArm.position.y = -0.2;
  leftArm.add(leftUpperArm);

  const leftForearm = new THREE.Mesh(inspectorGeometryCache.forearm, materials.limb);
  leftForearm.position.y = -0.52;
  leftArm.add(leftForearm);

  const rightArm = new THREE.Group();
  rightArm.position.set(0.3, 1.43, 0);
  locomotionRoot.add(rightArm);

  const rightUpperArm = new THREE.Mesh(inspectorGeometryCache.arm, materials.limb);
  rightUpperArm.position.y = -0.2;
  rightArm.add(rightUpperArm);

  const rightForearm = new THREE.Mesh(inspectorGeometryCache.forearm, materials.limb);
  rightForearm.position.y = -0.52;
  rightArm.add(rightForearm);

  const scanner = new THREE.Group();
  scanner.position.set(0.17, -0.52, -0.05);
  rightArm.add(scanner);

  const scannerBody = new THREE.Mesh(inspectorGeometryCache.scannerBody, materials.gear);
  scanner.add(scannerBody);

  const scannerBarrel = new THREE.Mesh(inspectorGeometryCache.scannerBarrel, materials.suitAccent);
  scannerBarrel.rotation.x = Math.PI / 2;
  scannerBarrel.position.z = -0.22;
  scanner.add(scannerBarrel);

  const scannerTipMaterial = materials.emitter.clone();
  scannerTipMaterial.emissive = new THREE.Color(theme.accent);
  scannerTipMaterial.emissiveIntensity = isLocal ? 0.75 : 0.58;
  const scannerTip = new THREE.Mesh(inspectorGeometryCache.scannerTip, scannerTipMaterial);
  scannerTip.position.set(0, 0, -0.33);
  scanner.add(scannerTip);

  const leftLeg = new THREE.Group();
  leftLeg.position.set(-0.13, 0.94, 0);
  locomotionRoot.add(leftLeg);

  const leftThigh = new THREE.Mesh(inspectorGeometryCache.leg, materials.limb);
  leftThigh.position.y = -0.24;
  leftLeg.add(leftThigh);

  const leftBoot = new THREE.Mesh(inspectorGeometryCache.boot, materials.boot);
  leftBoot.position.set(0, -0.53, -0.05);
  leftLeg.add(leftBoot);

  const rightLeg = new THREE.Group();
  rightLeg.position.set(0.13, 0.94, 0);
  locomotionRoot.add(rightLeg);

  const rightThigh = new THREE.Mesh(inspectorGeometryCache.leg, materials.limb);
  rightThigh.position.y = -0.24;
  rightLeg.add(rightThigh);

  const rightBoot = new THREE.Mesh(inspectorGeometryCache.boot, materials.boot);
  rightBoot.position.set(0, -0.53, -0.05);
  rightLeg.add(rightBoot);

  root.userData.inspectorRig = {
    locomotionRoot,
    leftArm,
    rightArm,
    leftLeg,
    rightLeg,
    scannerTip,
    baseY: 0,
    armBasePitch: -0.15,
    legBasePitch: 0,
    moveBlend: 0,
    stepPhase: Array.from(playerId).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) * 0.2,
    dead: false,
  } satisfies InspectorRig;

  return root;
}

function addEvent(text: string) {
  eventFeed.unshift(text);
  if (eventFeed.length > 3) {
    eventFeed.length = 3;
  }
  eventsEl.textContent = eventFeed.length > 0 ? `Ultimo evento: ${eventFeed[0]}` : "Ultimo evento: -";
}

function clearEvents() {
  eventFeed.length = 0;
  eventsEl.textContent = "Ultimo evento: -";
}

function showConnectionFailureMessage() {
  fullMessageEl.textContent = "Falha ao conectar. Verifique IP e se o server está rodando.";
}

function showMenuOverlay() {
  menuOverlay.classList.remove("hidden");
}

function hideMenuOverlay() {
  menuOverlay.classList.add("hidden");
}

function hideGameOverOverlay() {
  gameOverOverlay.classList.add("hidden");
  gameOverOverlay.classList.remove("win", "lose");
  gameOverSummaryEl.textContent = "";
}

function hidePhaseTransitionOverlay() {
  phaseTransitionOverlay.classList.add("hidden");
  if (phaseTransitionHideTimer !== null) {
    window.clearTimeout(phaseTransitionHideTimer);
    phaseTransitionHideTimer = null;
  }
}

function showPhaseTransitionOverlay(title: string, subtitle: string, durationMs = 2000) {
  phaseTransitionTitle.textContent = title;
  phaseTransitionSubtitle.textContent = subtitle;
  phaseTransitionOverlay.classList.remove("hidden");

  if (phaseTransitionHideTimer !== null) {
    window.clearTimeout(phaseTransitionHideTimer);
  }
  phaseTransitionHideTimer = window.setTimeout(() => {
    phaseTransitionOverlay.classList.add("hidden");
    phaseTransitionHideTimer = null;
  }, durationMs);
}

function hideTrechoToast() {
  trechoToastEl.classList.add("hidden");
  if (trechoToastHideTimer !== null) {
    window.clearTimeout(trechoToastHideTimer);
    trechoToastHideTimer = null;
  }
}

function getTrechoToastContent(phase: number) {
  if (phase === 1) {
    return {
      trecho: "Trecho: Salesópolis (Fase 1)",
      briefing: "Objetivo: estabilizar os sensores na nascente e iniciar a transmissão.",
    };
  }
  if (phase === 2) {
    return {
      trecho: "Trecho: Zona Industrial (Fase 2)",
      briefing: "Objetivo: identificar sabotagem nas indústrias e manter a base operando.",
    };
  }
  if (phase === 3) {
    return {
      trecho: "Trecho: Grande SP (Fase 3)",
      briefing: "Objetivo: concluir o relatório final sob máxima pressão e enviar à Secretaria.",
    };
  }
  return null;
}

function showTrechoToastForPhase(phase: number, durationMs = 2000) {
  const content = getTrechoToastContent(phase);
  if (!content) {
    return;
  }

  const now = performance.now();
  if (lastTrechoToastPhase === phase && now - lastTrechoToastAtMs < 700) {
    return;
  }

  lastTrechoToastPhase = phase;
  lastTrechoToastAtMs = now;
  trechoToastMainEl.textContent = content.trecho;
  trechoToastBriefEl.textContent = content.briefing;
  trechoToastEl.classList.remove("hidden");

  if (trechoToastHideTimer !== null) {
    window.clearTimeout(trechoToastHideTimer);
  }
  trechoToastHideTimer = window.setTimeout(() => {
    trechoToastEl.classList.add("hidden");
    trechoToastHideTimer = null;
  }, durationMs);
}

function showGameOverOverlay(
  result: "win" | "lose",
  summary?: { killsByPlayer: Record<string, number>; totalKills: number; phaseReached: number }
) {
  hidePhaseTransitionOverlay();
  gameOverOverlay.classList.remove("hidden", "win", "lose");

  const p1Kills = summary?.killsByPlayer["1"] ?? 0;
  const p2Kills = summary?.killsByPlayer["2"] ?? 0;
  if (summary) {
    gameOverSummaryEl.textContent =
      `P1 Kills: ${p1Kills}\n` +
      `P2 Kills: ${p2Kills}\n` +
      `Total: ${summary.totalKills}\n` +
      `Fase alcancada: ${summary.phaseReached}`;
  } else {
    gameOverSummaryEl.textContent = "";
  }

  if (result === "win") {
    gameOverOverlay.classList.add("win");
    gameOverTitle.textContent =
      summary?.phaseReached === 3 ? "PARABENS! OBJETIVO CONCLUIDO" : "RELATORIO TRANSMITIDO (VITORIA)";
    if (summary?.phaseReached === 3) {
      addEvent("Relatorio final transmitido");
      if (gameOverSummaryEl.textContent) {
        gameOverSummaryEl.textContent = `RELATORIO FINAL TRANSMITIDO\n${gameOverSummaryEl.textContent}`;
      } else {
        gameOverSummaryEl.textContent = "RELATORIO FINAL TRANSMITIDO";
      }
    } else {
      addEvent("Relatorio transmitido");
    }
    return;
  }

  gameOverOverlay.classList.add("lose");
  gameOverTitle.textContent = "ESTACAO SABOTADA (DERROTA)";
  addEvent("Estacao sabotada");
}

function removeObjectMap<T extends THREE.Object3D>(map: Map<string, T>) {
  for (const obj of map.values()) {
    scene.remove(obj);
  }
  map.clear();
}

function removePlayerVisual(playerId: string) {
  const visual = playerMeshes.get(playerId);
  if (!visual) {
    return;
  }

  scene.remove(visual);
  const rig = getInspectorRig(visual);
  if (rig) {
    const tipMaterial = rig.scannerTip.material as THREE.Material;
    tipMaterial.dispose();
  }
  delete visual.userData.inspectorRig;
  playerMeshes.delete(playerId);
}

function removeAllPlayerVisuals() {
  for (const playerId of [...playerMeshes.keys()]) {
    removePlayerVisual(playerId);
  }
}

function disposeObject3D(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    if (mesh.material) {
      disposeMaterial(mesh.material as THREE.Material | THREE.Material[]);
    }
  });
}

function removeBotVisual(botId: string) {
  const visual = botMeshes.get(botId);
  if (!visual) {
    return;
  }

  scene.remove(visual.group);
  disposeObject3D(visual.group);
  botMeshes.delete(botId);
}

function removeAllBotVisuals() {
  for (const botId of [...botMeshes.keys()]) {
    removeBotVisual(botId);
  }
}

function resetSessionState(clearFeed: boolean) {
  removeAllPlayerVisuals();
  removeAllSensorVisuals();
  removeAllBotVisuals();
  removeAllProjectileVisuals();
  clearBotExplosionFx();
  removeSensorLabels();

  latestPlayers = {};
  latestSensors = {};
  latestBots = {};
  latestMeta = null;

  previousBotCount = 0;
  previousSensorHp.clear();
  sensorDamageLogAt.clear();
  prevBotIds.clear();
  lastBotPos.clear();
  suppressBotDeathFx = true;

  myId = null;
  myIdEl.textContent = "-";
  gameOverResult = null;
  isSpaceHeld = false;
  isRepairHeld = false;
  isHealButtonHeld = false;
  isRepairRequestActive = false;
  currentRepairRequestSensorId = null;
  setShootHoldState(false);
  setHealHoldState(false);
  releaseJoystick();
  localShotFlashTimer = 0;
  hideGameOverOverlay();
  hidePhaseTransitionOverlay();
  hideTrechoToast();
  lastTrechoToastPhase = null;
  lastTrechoToastAtMs = 0;

  if (clearFeed) {
    clearEvents();
  }

  phaseTimeEl.textContent = currentPhase ? `Fase ${currentPhase} | Tempo: -` : "Fase - | Tempo: -";
  baseEl.textContent = "BASE -";
  baseBarFillEl.style.width = "0%";
  baseBarWrapEl.classList.remove("low", "repairing", "low-repair");
  killsEl.textContent = "Kills P1: - | P2: -";
  botsEl.textContent = "Bots: -/-";
  fullMessageEl.textContent = "";

  ring.visible = false;
  aimArrow.visible = false;
}

function setShootHoldState(held: boolean) {
  isShootButtonHeld = held;
  shootBtnEl.classList.toggle("active", held);
}

function setHealHoldState(held: boolean) {
  isHealButtonHeld = held;
  healBtnEl.classList.toggle("active", held);
}

function resetJoystickVisual() {
  joystickEl.classList.remove("active");
  joystickThumbEl.style.transform = "translate(-50%, -50%)";
}

function releaseJoystick() {
  joystickPointerId = null;
  clearTouchMovementInput();
  resetJoystickVisual();
}

function updateJoystickFromPointer(clientX: number, clientY: number) {
  const rect = joystickEl.getBoundingClientRect();
  const centerX = rect.left + rect.width * 0.5;
  const centerY = rect.top + rect.height * 0.5;
  let dx = clientX - centerX;
  let dy = clientY - centerY;
  const maxRadius = rect.width * 0.34;
  const dist = Math.hypot(dx, dy);
  if (dist > maxRadius && dist > 0.0001) {
    const scale = maxRadius / dist;
    dx *= scale;
    dy *= scale;
  }

  joystickThumbEl.style.transform = `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px))`;

  const deadzone = maxRadius * JOYSTICK_DEADZONE_RATIO;
  if (Math.hypot(dx, dy) <= deadzone) {
    clearTouchMovementInput();
    return;
  }

  const axisThreshold = maxRadius * JOYSTICK_AXIS_THRESHOLD_RATIO;
  setTouchMovement(dy < -axisThreshold, dy > axisThreshold, dx < -axisThreshold, dx > axisThreshold);
}

function disconnectSocket() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (!ws) {
    return;
  }

  try {
    ws.close();
  } catch {
    // noop
  }

  ws = null;
}

function extractWsHost(address: string) {
  if (address.startsWith("[")) {
    const closeBracketIndex = address.indexOf("]");
    return closeBracketIndex > 0 ? address.slice(1, closeBracketIndex).toLowerCase() : "";
  }
  const [host] = address.split(":");
  return (host ?? "").toLowerCase();
}

function shouldUseSecureWs(address: string) {
  if (window.location.protocol !== "https:") {
    return false;
  }
  const host = extractWsHost(address);
  if (!host) {
    return false;
  }
  const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
  const isIpv6 = host.includes(":");
  if (isIpv4 || isIpv6 || host === "localhost") {
    return false;
  }
  return /[a-z]/.test(host);
}

function buildWsBaseUrl(address: string) {
  const protocol = shouldUseSecureWs(address) ? "wss" : "ws";
  return `${protocol}://${address}`;
}

function persistWsServer(value: string) {
  const normalized = normalizeWsServerValue(value);
  configuredWsServer = normalized;

  try {
    if (normalized) {
      window.localStorage.setItem(WS_SERVER_STORAGE_KEY, normalized);
    } else {
      window.localStorage.removeItem(WS_SERVER_STORAGE_KEY);
    }
  } catch {
    // noop
  }

  serverInput.value = normalized;
  refreshCurrentServerText();
  return normalized;
}

function getConfiguredWsServer() {
  return normalizeWsServerValue(serverInput.value || configuredWsServer);
}

function getWsBaseUrl() {
  const configured = getConfiguredWsServer();
  if (configured) {
    return buildWsBaseUrl(configured);
  }

  const defaultServer = getHostnameDefaultWsServer();
  if (defaultServer) {
    return buildWsBaseUrl(defaultServer);
  }

  return "ws://localhost:8080";
}

function refreshCurrentServerText() {
  const configured = getConfiguredWsServer();
  if (configured) {
    serverCurrentText.textContent = `Servidor atual: ${buildWsBaseUrl(configured)}`;
    return;
  }

  const defaultServer = getHostnameDefaultWsServer();
  if (defaultServer) {
    serverCurrentText.textContent = `Servidor atual: ${buildWsBaseUrl(defaultServer)}`;
    return;
  }

  serverCurrentText.textContent = "Servidor atual: não configurado";
}

function isCapacitorRuntime() {
  const maybeWindow = window as Window & { Capacitor?: { isNativePlatform?: () => boolean } };
  const capacitor = maybeWindow.Capacitor;
  if (capacitor && typeof capacitor.isNativePlatform === "function") {
    try {
      if (capacitor.isNativePlatform()) {
        return true;
      }
    } catch {
      // noop
    }
  }

  const protocol = window.location.protocol;
  return protocol === "capacitor:" || protocol === "file:";
}

function isLikelyMobileUserAgent() {
  const ua = window.navigator.userAgent.toLowerCase();
  return ua.includes("android") || ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod");
}

function requiresManualWsServer() {
  if (isCapacitorRuntime()) {
    return true;
  }

  const hostname = window.location.hostname.trim().toLowerCase();
  if (!hostname) {
    return true;
  }

  if (hostname === "localhost" && isLikelyMobileUserAgent()) {
    return true;
  }

  return false;
}

function getWsUrl() {
  const phase = currentPhase ?? 1;
  const room = encodeURIComponent(currentRoom);
  return `${getWsBaseUrl()}/?room=${room}&phase=${phase}`;
}

const sensorStationGeometryCache = {
  base: new THREE.CylinderGeometry(0.42, 0.5, 0.3, 12),
  mast: new THREE.CylinderGeometry(0.07, 0.07, 0.75, 10),
  antenna: new THREE.ConeGeometry(0.12, 0.24, 10),
  led: new THREE.SphereGeometry(0.07, 10, 10),
  panel: new THREE.BoxGeometry(0.32, 0.22, 0.05),
  attackRing: new THREE.TorusGeometry(0.7, 0.06, 10, 24),
  alertMarker: new THREE.ConeGeometry(0.08, 0.2, 10),
  repairParticle: new THREE.SphereGeometry(0.035, 8, 8),
};

const sensorStationMaterialTemplates = {
  base: new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.56, metalness: 0.15 }),
  mast: new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.58, metalness: 0.25 }),
  antenna: new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.52, metalness: 0.32 }),
  panel: new THREE.MeshStandardMaterial({ color: 0xeab308, roughness: 0.45, metalness: 0.2 }),
  led: new THREE.MeshStandardMaterial({
    color: 0x86efac,
    emissive: 0x166534,
    emissiveIntensity: 0.35,
    roughness: 0.18,
    metalness: 0.2,
  }),
  attackRing: new THREE.MeshStandardMaterial({
    color: 0xef4444,
    emissive: 0x7f1d1d,
    emissiveIntensity: 0.8,
    transparent: true,
    opacity: 0.85,
    roughness: 0.35,
    metalness: 0.12,
  }),
  alertMarker: new THREE.MeshStandardMaterial({
    color: 0xf87171,
    emissive: 0x991b1b,
    emissiveIntensity: 0.85,
    roughness: 0.35,
    metalness: 0.08,
  }),
  repairParticle: new THREE.MeshStandardMaterial({
    color: 0x67e8f9,
    emissive: 0x0891b2,
    emissiveIntensity: 0.9,
    transparent: true,
    opacity: 0.7,
    roughness: 0.22,
    metalness: 0.1,
  }),
};

const botExplosionFxGeometryCache = {
  flash: markSharedGeometry(new THREE.SphereGeometry(0.24, 10, 10)),
  shockwave: markSharedGeometry(new THREE.TorusGeometry(0.35, 0.055, 8, 24)),
  fragment: markSharedGeometry(new THREE.BoxGeometry(0.11, 0.11, 0.11)),
  smoke: markSharedGeometry(new THREE.SphereGeometry(0.18, 8, 8)),
};

const botExplosionFxMaterialTemplates = {
  flash: markSharedMaterial(
    new THREE.MeshStandardMaterial({
      color: 0xfbbf24,
      emissive: 0xf97316,
      emissiveIntensity: 2.3,
      transparent: true,
      opacity: 1,
      roughness: 0.22,
      metalness: 0.06,
      depthWrite: false,
    })
  ),
  shockwave: markSharedMaterial(
    new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.88,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  ),
  fragment: markSharedMaterial(
    new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      emissive: 0x7c2d12,
      emissiveIntensity: 0.25,
      transparent: true,
      opacity: 1,
      roughness: 0.45,
      metalness: 0.18,
    })
  ),
  smoke: markSharedMaterial(
    new THREE.MeshStandardMaterial({
      color: 0x6b7280,
      transparent: true,
      opacity: 0.56,
      roughness: 0.95,
      metalness: 0.02,
      depthWrite: false,
    })
  ),
};

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function createSensorMesh(sensorId: string, sensor: SensorState) {
  const group = new THREE.Group();
  group.position.set(sensor.x, 0, sensor.z);

  const baseMaterial = sensorStationMaterialTemplates.base.clone();
  const mastMaterial = sensorStationMaterialTemplates.mast.clone();
  const antennaMaterial = sensorStationMaterialTemplates.antenna.clone();
  const panelMaterial = sensorStationMaterialTemplates.panel.clone();
  const ledMaterial = sensorStationMaterialTemplates.led.clone();
  const attackRingMaterial = sensorStationMaterialTemplates.attackRing.clone();
  const alertMarkerMaterial = sensorStationMaterialTemplates.alertMarker.clone();
  const particleMaterial = sensorStationMaterialTemplates.repairParticle.clone();

  const base = new THREE.Mesh(sensorStationGeometryCache.base, baseMaterial);
  base.position.y = 0.15;
  group.add(base);

  const mast = new THREE.Mesh(sensorStationGeometryCache.mast, mastMaterial);
  mast.position.y = 0.6;
  group.add(mast);

  const antenna = new THREE.Mesh(sensorStationGeometryCache.antenna, antennaMaterial);
  antenna.position.y = 1.08;
  group.add(antenna);

  const led = new THREE.Mesh(sensorStationGeometryCache.led, ledMaterial);
  led.position.y = 1.24;
  group.add(led);

  const panel = new THREE.Mesh(sensorStationGeometryCache.panel, panelMaterial);
  panel.position.set(0, 0.73, -0.27);
  group.add(panel);

  const attackRing = new THREE.Mesh(sensorStationGeometryCache.attackRing, attackRingMaterial);
  attackRing.rotation.x = Math.PI / 2;
  attackRing.position.y = 0.04;
  attackRing.visible = false;
  group.add(attackRing);

  const alertMarker = new THREE.Mesh(sensorStationGeometryCache.alertMarker, alertMarkerMaterial);
  alertMarker.position.set(0, 1.55, 0);
  alertMarker.visible = false;
  group.add(alertMarker);

  const repairParticles: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i += 1) {
    const particle = new THREE.Mesh(sensorStationGeometryCache.repairParticle, particleMaterial);
    particle.visible = false;
    group.add(particle);
    repairParticles.push(particle);
  }

  scene.add(group);
  sensorMeshes.set(sensorId, {
    group,
    base,
    mast,
    antenna,
    panel,
    led,
    attackRing,
    alertMarker,
    repairParticles,
    pulseOffset: Array.from(sensorId).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) * 0.31,
  });
}

function isSensorUnderAttack(sensor: SensorState, bots: Record<string, BotState>) {
  for (const bot of Object.values(bots)) {
    if (Math.hypot(bot.x - sensor.x, bot.z - sensor.z) <= 1.2) {
      return true;
    }
  }
  return false;
}

function updateSensorStationVisual(
  visual: SensorVisual,
  state: {
    isDestroyed: boolean;
    isCritical: boolean;
    isRepairing: boolean;
    underAttack: boolean;
  }
) {
  const timeSec = performance.now() / 1000;
  const pulseFast = 0.45 + 0.55 * Math.abs(Math.sin(timeSec * 9 + visual.pulseOffset));
  const pulseSlow = 0.55 + 0.45 * Math.abs(Math.sin(timeSec * 3.5 + visual.pulseOffset));

  const baseMat = visual.base.material as THREE.MeshStandardMaterial;
  const mastMat = visual.mast.material as THREE.MeshStandardMaterial;
  const antennaMat = visual.antenna.material as THREE.MeshStandardMaterial;
  const panelMat = visual.panel.material as THREE.MeshStandardMaterial;
  const ledMat = visual.led.material as THREE.MeshStandardMaterial;
  const ringMat = visual.attackRing.material as THREE.MeshStandardMaterial;
  const markerMat = visual.alertMarker.material as THREE.MeshStandardMaterial;
  const particleMat = visual.repairParticles[0].material as THREE.MeshStandardMaterial;

  if (state.isDestroyed) {
    baseMat.color.setHex(0x334155);
    baseMat.emissive.setHex(0x111827);
    mastMat.color.setHex(0x475569);
    antennaMat.color.setHex(0x475569);
    panelMat.color.setHex(0x374151);
    panelMat.emissive.setHex(0x111827);
    ledMat.color.setHex(0x1f2937);
    ledMat.emissive.setHex(0x000000);
    ledMat.emissiveIntensity = 0;
    visual.attackRing.visible = false;
    visual.alertMarker.visible = false;
    for (const particle of visual.repairParticles) {
      particle.visible = false;
    }
    return;
  }

  visual.attackRing.visible = state.underAttack;
  visual.alertMarker.visible = state.underAttack;

  if (state.underAttack) {
    baseMat.color.setHex(0xfb7185);
    baseMat.emissive.setHex(0x7f1d1d);
    panelMat.color.setHex(0xfda4af);
    panelMat.emissive.setHex(0x7f1d1d);
    ledMat.color.setHex(0xf87171);
    ledMat.emissive.setHex(0xb91c1c);
    ledMat.emissiveIntensity = 0.8 + pulseFast * 0.8;
    ringMat.emissiveIntensity = 0.9 + pulseFast * 1.2;
    ringMat.opacity = 0.35 + pulseFast * 0.55;
    markerMat.emissiveIntensity = 0.75 + pulseFast * 0.8;
  } else if (state.isRepairing) {
    baseMat.color.setHex(0x67e8f9);
    baseMat.emissive.setHex(0x0e7490);
    panelMat.color.setHex(0x22d3ee);
    panelMat.emissive.setHex(0x155e75);
    ledMat.color.setHex(0x67e8f9);
    ledMat.emissive.setHex(0x0891b2);
    ledMat.emissiveIntensity = 1.1 + pulseSlow * 0.45;
  } else if (state.isCritical) {
    baseMat.color.setHex(0xf59e0b);
    baseMat.emissive.setHex(0x7c2d12);
    panelMat.color.setHex(0xfb923c);
    panelMat.emissive.setHex(0x7c2d12);
    ledMat.color.setHex(0xfb7185);
    ledMat.emissive.setHex(0x991b1b);
    ledMat.emissiveIntensity = 0.65 + pulseFast * 0.8;
  } else {
    baseMat.color.setHex(0xfacc15);
    baseMat.emissive.setHex(0x422006);
    panelMat.color.setHex(0xeab308);
    panelMat.emissive.setHex(0x422006);
    ledMat.color.setHex(0x86efac);
    ledMat.emissive.setHex(0x166534);
    ledMat.emissiveIntensity = 0.45 + pulseSlow * 0.25;
  }

  mastMat.color.setHex(state.isRepairing ? 0x67e8f9 : 0x64748b);
  antennaMat.color.setHex(state.isRepairing ? 0xa5f3fc : 0x94a3b8);

  if (state.isRepairing && !state.underAttack) {
    for (let i = 0; i < visual.repairParticles.length; i += 1) {
      const particle = visual.repairParticles[i];
      const cycle = (timeSec * 0.8 + i * 0.33 + visual.pulseOffset * 0.15) % 1;
      const spread = i === 0 ? -0.12 : i === 1 ? 0.12 : 0;
      particle.visible = true;
      particle.position.set(spread, 0.38 + cycle * 0.72, -0.06);
      const scale = 0.7 + (1 - cycle) * 0.6;
      particle.scale.setScalar(scale);
      particleMat.opacity = 0.18 + (1 - cycle) * 0.6;
      particleMat.emissiveIntensity = 0.55 + (1 - cycle) * 0.65;
    }
  } else {
    for (const particle of visual.repairParticles) {
      particle.visible = false;
    }
  }
}

function createDroneMesh(botId: string) {
  removeBotVisual(botId);

  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.6, metalness: 0.2 });
  const frameMaterial = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.48, metalness: 0.3 });
  const propellerMaterial = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.35, metalness: 0.55 });
  const eyeMaterial = new THREE.MeshStandardMaterial({
    color: 0xf87171,
    emissive: 0xb91c1c,
    emissiveIntensity: 1.4,
    roughness: 0.2,
  });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 10), bodyMaterial);
  body.scale.set(1.08, 0.72, 1.12);
  body.position.y = 0.66;
  group.add(body);

  const topCap = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.16, 8), frameMaterial);
  topCap.position.set(0, 0.84, 0);
  group.add(topCap);

  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 10), eyeMaterial);
  eye.position.set(0, 0.63, -0.29);
  group.add(eye);

  const armLong = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.92, 8), frameMaterial);
  armLong.rotation.z = Math.PI / 2;
  armLong.position.y = 0.66;
  group.add(armLong);

  const armWide = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.92, 8), frameMaterial);
  armWide.rotation.x = Math.PI / 2;
  armWide.position.y = 0.66;
  group.add(armWide);

  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 8), frameMaterial);
  antenna.position.set(0, 0.98, 0.02);
  group.add(antenna);

  const antennaTip = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 8), eyeMaterial);
  antennaTip.position.set(0, 1.1, 0.02);
  group.add(antennaTip);

  const rotors: THREE.Group[] = [];
  const rotorPoints = [
    [0.42, -0.02],
    [-0.42, -0.02],
    [0, 0.42],
    [0, -0.42],
  ] as const;

  for (const [x, z] of rotorPoints) {
    const rotor = new THREE.Group();
    rotor.position.set(x, 0.77, z);

    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.03, 10), frameMaterial);
    rotor.add(hub);

    const bladeA = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.012, 0.05), propellerMaterial);
    bladeA.position.y = 0.015;
    rotor.add(bladeA);

    const bladeB = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.32), propellerMaterial);
    bladeB.position.y = 0.015;
    rotor.add(bladeB);

    group.add(rotor);
    rotors.push(rotor);
  }

  const visual: DroneVisual = {
    group,
    rotors,
    baseY: 0.6,
    bobPhase: Array.from(botId).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) * 0.19,
  };

  group.position.y = visual.baseY;
  scene.add(group);
  botMeshes.set(botId, visual);
}

function isPlayerProjectileOwner(owner: string) {
  if (owner === "p1" || owner === "p2") {
    return true;
  }
  return owner in latestPlayers;
}

function applyBeamTransform(visual: ProjectileVisual, x: number, z: number, dirX: number, dirZ: number) {
  projectileBeamDir.set(dirX, 0, dirZ);
  projectileBeamQuat.setFromUnitVectors(projectileBeamUp, projectileBeamDir);
  visual.mesh.setRotationFromQuaternion(projectileBeamQuat);
  visual.mesh.position.set(x - dirX * PROJECTILE_BEAM_LENGTH * 0.35, 0.6, z - dirZ * PROJECTILE_BEAM_LENGTH * 0.35);
}

function syncProjectileVisualFromState(visual: ProjectileVisual, projectile: ProjectileState, nowMs: number) {
  if (visual.isPlayerBeam) {
    let dirX = projectile.vx;
    let dirZ = projectile.vz;
    let length = Math.hypot(dirX, dirZ);

    if (length < 0.0001) {
      dirX = projectile.x - visual.lastX;
      dirZ = projectile.z - visual.lastZ;
      length = Math.hypot(dirX, dirZ);
    }

    if (length < 0.0001) {
      dirX = visual.dirX;
      dirZ = visual.dirZ;
      length = Math.hypot(dirX, dirZ);
    }

    if (length < 0.0001) {
      dirX = 0;
      dirZ = -1;
      length = 1;
    }

    dirX /= length;
    dirZ /= length;
    visual.dirX = dirX;
    visual.dirZ = dirZ;
    applyBeamTransform(visual, projectile.x, projectile.z, dirX, dirZ);
  } else {
    visual.mesh.position.set(projectile.x, 0.6, projectile.z);
  }

  visual.lastX = projectile.x;
  visual.lastZ = projectile.z;
  visual.lastUpdateAtMs = nowMs;
  visual.fadeStartedAtMs = null;
}

function createProjectileMesh(projectileId: string, projectile: ProjectileState, nowMs: number) {
  const isPlayerBeam = isPlayerProjectileOwner(projectile.owner);
  let mesh: THREE.Mesh;
  let baseOpacity = 1;
  let baseEmissiveIntensity = 0.35;

  if (isPlayerBeam) {
    const color = projectile.owner === myId ? 0x67e8f9 : 0x7dd3fc;
    baseOpacity = projectile.owner === myId ? 0.9 : 0.82;
    baseEmissiveIntensity = projectile.owner === myId ? 2.8 : 2.1;
    mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(PROJECTILE_BEAM_RADIUS, PROJECTILE_BEAM_RADIUS, PROJECTILE_BEAM_LENGTH, 10, 1, true),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: baseEmissiveIntensity,
        transparent: true,
        opacity: baseOpacity,
        roughness: 0.2,
        metalness: 0.05,
        depthWrite: false,
      })
    );
  } else {
    const color = 0xf87171;
    mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 8, 8),
      new THREE.MeshStandardMaterial({
        color,
        emissive: 0xdc2626,
        emissiveIntensity: 0.35,
        roughness: 0.28,
        metalness: 0.05,
      })
    );
  }

  const visual: ProjectileVisual = {
    mesh,
    isPlayerBeam,
    baseOpacity,
    baseEmissiveIntensity,
    lastUpdateAtMs: nowMs,
    fadeStartedAtMs: null,
    lastX: projectile.x,
    lastZ: projectile.z,
    dirX: 0,
    dirZ: -1,
  };

  scene.add(mesh);
  projectileMeshes.set(projectileId, visual);
  syncProjectileVisualFromState(visual, projectile, nowMs);
}

function removeProjectileVisual(projectileId: string) {
  const visual = projectileMeshes.get(projectileId);
  if (!visual) {
    return;
  }

  scene.remove(visual.mesh);
  visual.mesh.geometry.dispose();
  disposeMaterial(visual.mesh.material as THREE.Material | THREE.Material[]);
  projectileMeshes.delete(projectileId);
}

function removeAllProjectileVisuals() {
  for (const projectileId of [...projectileMeshes.keys()]) {
    removeProjectileVisual(projectileId);
  }
}

function animateProjectileVisuals(nowMs: number) {
  for (const [projectileId, visual] of projectileMeshes) {
    if (!visual.isPlayerBeam) {
      continue;
    }

    const material = visual.mesh.material as THREE.MeshStandardMaterial;
    const elapsedSinceUpdate = Math.max(0, nowMs - visual.lastUpdateAtMs);
    let fade = Math.max(0, 1 - elapsedSinceUpdate / PROJECTILE_BEAM_UPDATE_FADE_MS);

    if (visual.fadeStartedAtMs !== null) {
      const staleElapsed = Math.max(0, nowMs - visual.fadeStartedAtMs);
      fade *= Math.max(0, 1 - staleElapsed / PROJECTILE_BEAM_STALE_FADE_MS);
      if (staleElapsed >= PROJECTILE_BEAM_STALE_FADE_MS) {
        removeProjectileVisual(projectileId);
        continue;
      }
    } else if (elapsedSinceUpdate > PROJECTILE_BEAM_UPDATE_FADE_MS * 4) {
      removeProjectileVisual(projectileId);
      continue;
    }

    material.opacity = visual.baseOpacity * fade;
    material.emissiveIntensity = visual.baseEmissiveIntensity * (0.45 + fade * 0.75);
  }
}

function createSensorLabel(sensorId: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.9, 1.0, 1);
  sprite.position.set(0, 2.0, 0);
  scene.add(sprite);

  const label: SensorLabelRef = {
    sprite,
    texture,
    canvas,
    ctx,
    lastSignature: "",
  };

  sensorLabels.set(sensorId, label);
  return label;
}

function updateSensorLabelVisual(
  sensorId: string,
  sensor: SensorState,
  status: { underAttack: boolean; isRepairing: boolean; isDestroyed: boolean }
) {
  let label = sensorLabels.get(sensorId);
  if (!label) {
    label = createSensorLabel(sensorId) ?? undefined;
  }
  if (!label) {
    return;
  }

  const isDestroyed = status.isDestroyed;
  const hpText = isDestroyed
    ? `${sensorId.toUpperCase()} DESTRUIDO`
    : status.isRepairing
      ? `${sensorId.toUpperCase()} ${Math.max(0, Math.ceil(sensor.hp))}/${sensor.maxHp} (+12/s)`
      : `${sensorId.toUpperCase()} ${Math.max(0, Math.ceil(sensor.hp))}/${sensor.maxHp}`;
  const textColor = isDestroyed ? "#fee2e2" : status.isRepairing ? "#dcfce7" : status.underAttack ? "#fee2e2" : "#f8fafc";
  const bgColor = isDestroyed
    ? "rgba(31,41,55,0.9)"
    : status.underAttack
      ? "rgba(127,29,29,0.88)"
      : status.isRepairing
        ? "rgba(6,78,59,0.86)"
        : "rgba(15,23,42,0.82)";
  const borderColor = isDestroyed
    ? "rgba(107,114,128,0.9)"
    : status.underAttack
      ? "rgba(248,113,113,0.95)"
      : status.isRepairing
        ? "rgba(110,231,183,0.9)"
        : "rgba(203,213,225,0.75)";
  const signature = `${hpText}|${textColor}|${bgColor}|${borderColor}`;

  if (label.lastSignature !== signature) {
    const { ctx, canvas, texture } = label;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 10, canvas.width, canvas.height - 20);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 3;
    ctx.strokeRect(3, 13, canvas.width - 6, canvas.height - 26);
    ctx.font = SENSOR_LABEL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = textColor;
    ctx.fillText(hpText, canvas.width / 2, canvas.height / 2);
    texture.needsUpdate = true;
    label.lastSignature = signature;
  }

  label.sprite.position.set(sensor.x, 2.2, sensor.z);
}

function removeSensorLabel(sensorId: string) {
  const label = sensorLabels.get(sensorId);
  if (!label) {
    return;
  }

  scene.remove(label.sprite);
  label.texture.dispose();
  label.sprite.material.dispose();
  sensorLabels.delete(sensorId);
}

function removeSensorLabels() {
  for (const sensorId of [...sensorLabels.keys()]) {
    removeSensorLabel(sensorId);
  }
}

function markSensorLabelsDirty() {
  for (const label of sensorLabels.values()) {
    label.lastSignature = "";
  }
}

function removeSensorVisual(sensorId: string) {
  const visual = sensorMeshes.get(sensorId);
  if (!visual) {
    return;
  }

  scene.remove(visual.group);
  const materials = new Set<THREE.Material>();
  visual.group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.material) {
      return;
    }
    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) {
        materials.add(material);
      }
      return;
    }
    materials.add(mesh.material);
  });
  for (const material of materials) {
    material.dispose();
  }

  sensorMeshes.delete(sensorId);
}

function removeAllSensorVisuals() {
  for (const sensorId of [...sensorMeshes.keys()]) {
    removeSensorVisual(sensorId);
  }
}

function clampLocalPositionAwayFromRiver(playerId: string, x: number, z: number) {
  if (playerId !== myId) {
    return { x, z };
  }

  const inRiverBand = x >= RIVER_MIN_X && x <= RIVER_MAX_X;
  const inBridgeZone = Math.abs(z - BRIDGE_Z) <= BRIDGE_HALF_DEPTH;
  if (!inRiverBand || inBridgeZone) {
    return { x, z };
  }

  const lastX = playerMeshes.get(playerId)?.position.x ?? x;
  const goRight = lastX >= 0;
  return {
    x: goRight ? RIVER_MAX_X + RIVER_BLOCK_MARGIN : RIVER_MIN_X - RIVER_BLOCK_MARGIN,
    z,
  };
}

function syncPlayers(players: Record<string, PlayerState>) {
  for (const [id, player] of Object.entries(players)) {
    if (!playerMeshes.has(id)) {
      const inspector = createInspectorMesh(id, myId === id);
      scene.add(inspector);
      playerMeshes.set(id, inspector);
    }

    const inspector = playerMeshes.get(id);
    if (!inspector) {
      continue;
    }

    const clampedPos = clampLocalPositionAwayFromRiver(id, player.x, player.z);
    inspector.position.x = clampedPos.x;
    inspector.position.z = clampedPos.z;

    const rig = getInspectorRig(inspector);
    if (rig) {
      rig.dead = player.hp <= 0;
      const tipMaterial = rig.scannerTip.material as THREE.MeshStandardMaterial;
      if (id === myId) {
        if (rig.dead) {
          tipMaterial.emissiveIntensity = 0.12;
        } else if (localShotFlashTimer <= 0) {
          tipMaterial.emissiveIntensity = 0.75;
        }
      } else {
        tipMaterial.emissiveIntensity = rig.dead ? 0.1 : 0.58;
      }
    }
  }

  for (const [id] of playerMeshes) {
    if (!(id in players)) {
      removePlayerVisual(id);
    }
  }
}

function syncSensors(
  sensors: Record<string, SensorState>,
  repairing: Record<string, boolean>,
  bots: Record<string, BotState>
) {
  for (const [sensorId, sensor] of Object.entries(sensors)) {
    if (!sensorMeshes.has(sensorId)) {
      createSensorMesh(sensorId, sensor);
    }

    const visual = sensorMeshes.get(sensorId);
    if (!visual) {
      continue;
    }

    visual.group.position.x = sensor.x;
    visual.group.position.z = sensor.z;

    const isDestroyed = sensor.hp <= 0;
    const ratio = sensor.maxHp > 0 ? Math.max(0, sensor.hp / sensor.maxHp) : 0;
    const isRepairing = !isDestroyed && Boolean(repairing[sensorId]);
    const isCritical = !isDestroyed && ratio < 0.3;
    const underAttack = !isDestroyed && isSensorUnderAttack(sensor, bots);

    updateSensorStationVisual(visual, {
      isDestroyed,
      isCritical,
      isRepairing,
      underAttack,
    });
    updateSensorLabelVisual(sensorId, sensor, {
      underAttack,
      isRepairing,
      isDestroyed,
    });
  }

  for (const [sensorId] of sensorMeshes) {
    if (!(sensorId in sensors)) {
      removeSensorVisual(sensorId);
      removeSensorLabel(sensorId);
    }
  }
}

function removeBotExplosionFxAt(index: number) {
  const fx = botExplosionFxList[index];
  if (!fx) {
    return;
  }

  scene.remove(fx.group);
  disposeMaterial(fx.flash.material as THREE.Material);
  disposeMaterial(fx.shockwave.material as THREE.Material);
  for (const fragment of fx.fragments) {
    disposeMaterial(fragment.mesh.material as THREE.Material);
  }
  for (const smoke of fx.smoke) {
    disposeMaterial(smoke.mesh.material as THREE.Material);
  }

  botExplosionFxList.splice(index, 1);
}

function clearBotExplosionFx() {
  for (let i = botExplosionFxList.length - 1; i >= 0; i -= 1) {
    removeBotExplosionFxAt(i);
  }
}

function spawnExplosionFx(x: number, z: number) {
  if (botExplosionFxList.length >= BOT_EXPLOSION_MAX_ACTIVE_FX) {
    removeBotExplosionFxAt(0);
  }

  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const flashMaterial = botExplosionFxMaterialTemplates.flash.clone();
  const flash = new THREE.Mesh(botExplosionFxGeometryCache.flash, flashMaterial);
  flash.position.y = 0.62;
  flash.scale.setScalar(0.3);
  group.add(flash);

  const shockwaveMaterial = botExplosionFxMaterialTemplates.shockwave.clone();
  const shockwave = new THREE.Mesh(botExplosionFxGeometryCache.shockwave, shockwaveMaterial);
  shockwave.rotation.x = Math.PI / 2;
  shockwave.position.y = 0.05;
  shockwave.scale.setScalar(0.35);
  group.add(shockwave);

  const fragments: BotExplosionParticle[] = [];
  for (let i = 0; i < 8; i += 1) {
    const fragmentMaterial = botExplosionFxMaterialTemplates.fragment.clone();
    const mesh = new THREE.Mesh(botExplosionFxGeometryCache.fragment, fragmentMaterial);
    mesh.position.set(randomBetween(-0.06, 0.06), randomBetween(0.45, 0.62), randomBetween(-0.06, 0.06));
    mesh.rotation.set(randomBetween(0, Math.PI), randomBetween(0, Math.PI), randomBetween(0, Math.PI));
    group.add(mesh);

    const angle = randomBetween(0, Math.PI * 2);
    const speed = randomBetween(1.4, 2.9);
    fragments.push({
      mesh,
      vx: Math.cos(angle) * speed,
      vy: randomBetween(1.6, 3.1),
      vz: Math.sin(angle) * speed,
      spinX: randomBetween(-7, 7),
      spinY: randomBetween(-7, 7),
      ttl: BOT_EXPLOSION_FRAGMENT_TTL,
      age: 0,
      startScale: 1,
      scaleGrow: 0,
    });
  }

  const smoke: BotExplosionParticle[] = [];
  for (let i = 0; i < 3; i += 1) {
    const smokeMaterial = botExplosionFxMaterialTemplates.smoke.clone();
    const mesh = new THREE.Mesh(botExplosionFxGeometryCache.smoke, smokeMaterial);
    const startScale = randomBetween(0.8, 1.15);
    mesh.position.set(randomBetween(-0.12, 0.12), randomBetween(0.46, 0.66), randomBetween(-0.12, 0.12));
    mesh.scale.setScalar(startScale);
    group.add(mesh);

    smoke.push({
      mesh,
      vx: randomBetween(-0.12, 0.12),
      vy: randomBetween(0.5, 0.85),
      vz: randomBetween(-0.12, 0.12),
      spinX: randomBetween(-0.45, 0.45),
      spinY: randomBetween(-0.55, 0.55),
      ttl: BOT_EXPLOSION_SMOKE_TTL,
      age: 0,
      startScale,
      scaleGrow: randomBetween(0.8, 1.25),
    });
  }

  scene.add(group);
  botExplosionFxList.push({
    group,
    age: 0,
    ttl: BOT_EXPLOSION_SMOKE_TTL,
    flash,
    shockwave,
    fragments,
    smoke,
  });
}

function animateBotExplosionFx(deltaSec: number) {
  for (let i = botExplosionFxList.length - 1; i >= 0; i -= 1) {
    const fx = botExplosionFxList[i];
    fx.age += deltaSec;

    const flashT = Math.min(1, fx.age / BOT_EXPLOSION_FLASH_TTL);
    if (fx.age <= BOT_EXPLOSION_FLASH_TTL) {
      fx.flash.visible = true;
      fx.flash.scale.setScalar(0.3 + flashT * 1.55);
      const flashMaterial = fx.flash.material as THREE.MeshStandardMaterial;
      flashMaterial.opacity = 1 - flashT;
      flashMaterial.emissiveIntensity = 2.4 - flashT * 1.6;
    } else {
      fx.flash.visible = false;
    }

    const shockwaveT = Math.min(1, fx.age / BOT_EXPLOSION_SHOCKWAVE_TTL);
    if (fx.age <= BOT_EXPLOSION_SHOCKWAVE_TTL) {
      fx.shockwave.visible = true;
      fx.shockwave.scale.setScalar(0.35 + shockwaveT * 2.15);
      const shockwaveMaterial = fx.shockwave.material as THREE.MeshBasicMaterial;
      shockwaveMaterial.opacity = 0.88 * (1 - shockwaveT);
    } else {
      fx.shockwave.visible = false;
    }

    for (const fragment of fx.fragments) {
      fragment.age += deltaSec;
      if (fragment.age >= fragment.ttl) {
        fragment.mesh.visible = false;
        continue;
      }

      fragment.vy -= 8.8 * deltaSec;
      fragment.mesh.position.x += fragment.vx * deltaSec;
      fragment.mesh.position.y += fragment.vy * deltaSec;
      fragment.mesh.position.z += fragment.vz * deltaSec;
      fragment.mesh.rotation.x += fragment.spinX * deltaSec;
      fragment.mesh.rotation.y += fragment.spinY * deltaSec;

      if (fragment.mesh.position.y < 0.03) {
        fragment.mesh.position.y = 0.03;
        fragment.vy *= -0.32;
        fragment.vx *= 0.78;
        fragment.vz *= 0.78;
      }

      const life = fragment.age / fragment.ttl;
      const fragmentMaterial = fragment.mesh.material as THREE.MeshStandardMaterial;
      fragmentMaterial.opacity = 1 - life;
    }

    for (const smoke of fx.smoke) {
      smoke.age += deltaSec;
      if (smoke.age >= smoke.ttl) {
        smoke.mesh.visible = false;
        continue;
      }

      smoke.mesh.position.x += smoke.vx * deltaSec;
      smoke.mesh.position.y += smoke.vy * deltaSec;
      smoke.mesh.position.z += smoke.vz * deltaSec;
      smoke.mesh.rotation.x += smoke.spinX * deltaSec;
      smoke.mesh.rotation.y += smoke.spinY * deltaSec;

      const life = smoke.age / smoke.ttl;
      smoke.mesh.scale.setScalar(smoke.startScale + life * smoke.scaleGrow);
      const smokeMaterial = smoke.mesh.material as THREE.MeshStandardMaterial;
      smokeMaterial.opacity = 0.56 * (1 - life);
    }

    if (fx.age >= fx.ttl) {
      removeBotExplosionFxAt(i);
    }
  }
}

function updateBotDeathFxTracking(bots: Record<string, BotState>, meta: StateMeta) {
  const currentIds = new Set<string>();
  for (const [botId, bot] of Object.entries(bots)) {
    currentIds.add(botId);
    lastBotPos.set(botId, { x: bot.x, z: bot.z });
  }

  const removedIds: string[] = [];
  for (const prevId of prevBotIds) {
    if (!currentIds.has(prevId)) {
      removedIds.push(prevId);
    }
  }

  const massRemoval = removedIds.length > 5;
  const canSpawnFx =
    !suppressBotDeathFx && meta.phaseState === "playing" && prevBotIds.size > 0 && removedIds.length > 0 && !massRemoval;

  if (canSpawnFx) {
    for (const removedId of removedIds) {
      const lastPos = lastBotPos.get(removedId);
      if (lastPos) {
        spawnExplosionFx(lastPos.x, lastPos.z);
      }
    }
  }

  for (const removedId of removedIds) {
    lastBotPos.delete(removedId);
  }

  prevBotIds.clear();
  for (const currentId of currentIds) {
    prevBotIds.add(currentId);
  }

  if (meta.phaseState === "intermission" || massRemoval) {
    suppressBotDeathFx = true;
    return;
  }

  if (suppressBotDeathFx) {
    suppressBotDeathFx = false;
  }
}

function syncBots(bots: Record<string, BotState>) {
  for (const [botId, bot] of Object.entries(bots)) {
    if (!botMeshes.has(botId)) {
      createDroneMesh(botId);
    }

    const visual = botMeshes.get(botId);
    if (!visual) {
      continue;
    }

    visual.group.position.x = bot.x;
    visual.group.position.z = bot.z;
  }

  for (const [botId] of botMeshes) {
    if (!(botId in bots)) {
      removeBotVisual(botId);
    }
  }
}

function animateDrones(deltaSec: number, nowMs: number) {
  const timeSec = nowMs / 1000;
  const rotorSpin = deltaSec * 34;

  for (const visual of botMeshes.values()) {
    for (const rotor of visual.rotors) {
      rotor.rotation.y += rotorSpin;
    }

    const bob = Math.sin(timeSec * 3.2 + visual.bobPhase) * 0.06;
    visual.group.position.y = visual.baseY + bob;
    visual.group.rotation.y = Math.sin(timeSec * 1.9 + visual.bobPhase) * 0.09;
  }
}

function animateRiverDecor(nowMs: number) {
  if (!riverBoatGroup) {
    return;
  }

  const timeSec = nowMs / 1000;
  const bob = Math.sin(timeSec * 1.8 + riverBoatPhase) * 0.048;
  const roll = Math.sin(timeSec * 1.25 + riverBoatPhase) * 0.038;
  const yaw = Math.sin(timeSec * 0.72 + riverBoatPhase * 1.1) * 0.04;
  riverBoatGroup.position.y = riverBoatBaseY + bob;
  riverBoatGroup.rotation.z = roll;
  riverBoatGroup.rotation.y = yaw;

  for (const light of riverBoatNavLights) {
    const material = light.mesh.material as THREE.MeshStandardMaterial;
    const pulse = Math.abs(Math.sin(timeSec * 2.35 + riverBoatPhase + light.phaseOffset));
    material.emissiveIntensity = light.baseIntensity + pulse * 0.45;
  }
}

function syncProjectiles(projectiles: Record<string, ProjectileState>) {
  const nowMs = performance.now();

  for (const [projectileId, projectile] of Object.entries(projectiles)) {
    if (!projectileMeshes.has(projectileId)) {
      createProjectileMesh(projectileId, projectile, nowMs);
    }

    const visual = projectileMeshes.get(projectileId);
    if (!visual) {
      continue;
    }

    syncProjectileVisualFromState(visual, projectile, nowMs);
  }

  for (const [projectileId, visual] of projectileMeshes) {
    if (!(projectileId in projectiles)) {
      if (visual.isPlayerBeam) {
        if (visual.fadeStartedAtMs === null) {
          visual.fadeStartedAtMs = nowMs;
        }
      } else {
        removeProjectileVisual(projectileId);
      }
    }
  }
}

function processThematicEvents(sensors: Record<string, SensorState>, bots: Record<string, BotState>) {
  const now = Date.now();
  const currentBotCount = Object.keys(bots).length;

  if (previousBotCount === 0 && currentBotCount > 0) {
    addEvent("Alerta: drones detectados");
  }
  previousBotCount = currentBotCount;

  for (const [sensorId, sensor] of Object.entries(sensors)) {
    const prevHp = previousSensorHp.get(sensorId);

    if (prevHp !== undefined && sensor.hp < prevHp) {
      if (sensor.hp <= 0 && prevHp > 0) {
        addEvent(`Sensor ${sensorId.toUpperCase()} destruido`);
      } else {
        const lastLogAt = sensorDamageLogAt.get(sensorId) || 0;
        if (now - lastLogAt >= SENSOR_DAMAGE_EVENT_COOLDOWN_MS) {
          addEvent(`Sensor ${sensorId.toUpperCase()} danificado`);
          sensorDamageLogAt.set(sensorId, now);
        }
      }
    }

    previousSensorHp.set(sensorId, sensor.hp);
  }

  for (const existingSensorId of [...previousSensorHp.keys()]) {
    if (!(existingSensorId in sensors)) {
      previousSensorHp.delete(existingSensorId);
      sensorDamageLogAt.delete(existingSensorId);
    }
  }
}

function getNearestRepairableSensorId() {
  if (!myId) {
    return null;
  }

  const local = latestPlayers[myId];
  if (!local || local.hp <= 0) {
    return null;
  }

  let nearest: { id: string; dist: number } | null = null;

  for (const [sensorId, sensor] of Object.entries(latestSensors)) {
    if (sensor.hp <= 0) {
      continue;
    }

    const dist = Math.hypot(local.x - sensor.x, local.z - sensor.z);
    if (dist > REPAIR_RANGE) {
      continue;
    }

    if (!nearest || dist < nearest.dist) {
      nearest = { id: sensorId, dist };
    }
  }

  return nearest ? nearest.id : null;
}

function updateHud(meta: StateMeta) {
  const compactHud = isTouchControlMode();
  const intermissionTag = meta.phaseState === "intermission" ? " (INT)" : "";
  phaseTimeEl.textContent = compactHud
    ? `Fase ${meta.phaseLevel}${intermissionTag} | Tempo ${meta.timeLeftSec}s`
    : `Fase ${meta.phaseLevel}${intermissionTag} | Tempo: ${meta.timeLeftSec}s`;

  const baseNow = Math.max(0, Math.round(meta.base.now));
  const baseMax = Math.max(0, Math.round(meta.base.max));
  const basePct = Math.max(0, Math.min(100, Math.round(meta.base.pct)));
  baseEl.textContent = compactHud ? `Base ${basePct}%` : `BASE ${basePct}% (${baseNow}/${baseMax})`;
  baseBarFillEl.style.width = `${basePct}%`;
  const isAnyRepairing = Object.keys(meta.repairing || {}).length > 0;
  baseBarWrapEl.classList.remove("low", "repairing", "low-repair");
  if (basePct < 30 && isAnyRepairing) {
    baseBarWrapEl.classList.add("low-repair");
  } else if (basePct < 30) {
    baseBarWrapEl.classList.add("low");
  } else if (isAnyRepairing) {
    baseBarWrapEl.classList.add("repairing");
  }

  const aliveSuffix = meta.wave.aliveCount > 0 ? (compactHud ? ` A${meta.wave.aliveCount}` : ` A:${meta.wave.aliveCount}`) : "";
  botsEl.textContent = compactHud
    ? `Bots ${meta.wave.killedCount}/${meta.wave.totalToSpawn}${aliveSuffix}`
    : `Bots: ${meta.wave.killedCount}/${meta.wave.totalToSpawn}${aliveSuffix}`;

  const sortedKills = Object.entries(meta.kills).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  const p1Fallback = sortedKills[0]?.[1];
  const p2Fallback = sortedKills[1]?.[1];
  const p1Kills = meta.kills["1"] ?? p1Fallback;
  const p2Kills = meta.kills["2"] ?? p2Fallback;
  if (compactHud) {
    killsEl.textContent = `Kills P1/${typeof p1Kills === "number" ? p1Kills : "-"} P2/${typeof p2Kills === "number" ? p2Kills : "-"}`;
  } else {
    killsEl.textContent = `Kills P1: ${typeof p1Kills === "number" ? p1Kills : "-"} | P2: ${
      typeof p2Kills === "number" ? p2Kills : "-"
    }`;
  }
}

function getManualAimDirection() {
  const x = lastMoveDir.x;
  const z = lastMoveDir.y;
  const len = Math.hypot(x, z);
  if (len <= 0.00001) {
    return new THREE.Vector2(0, -1);
  }
  return new THREE.Vector2(x / len, z / len);
}

function getAimForShot() {
  const local = myId ? latestPlayers[myId] : undefined;

  if (local) {
    let nearest: { dist: number; dir: THREE.Vector2 } | null = null;

    for (const bot of Object.values(latestBots)) {
      const dx = bot.x - local.x;
      const dz = bot.z - local.z;
      const dist = Math.hypot(dx, dz);
      if (dist > AIM_ASSIST_RADIUS || dist <= 0.00001) {
        continue;
      }

      const dir = new THREE.Vector2(dx / dist, dz / dist);
      if (!nearest || dist < nearest.dist) {
        nearest = { dist, dir };
      }
    }

    if (nearest) {
      return { dir: nearest.dir, mode: "assistida" as const };
    }
  }

  return { dir: getManualAimDirection(), mode: "manual" as const };
}

function updateAimIndicator() {
  if (!myId) {
    aimArrow.visible = false;
    return;
  }

  const localInspector = playerMeshes.get(myId);
  if (!localInspector) {
    aimArrow.visible = false;
    return;
  }

  const manualDir = getManualAimDirection();
  aimArrow.visible = true;
  aimArrow.position.set(localInspector.position.x, 0.8, localInspector.position.z);
  aimArrow.setDirection(new THREE.Vector3(manualDir.x, 0, manualDir.y));
}

function updateCameraFollow() {
  if (!myId) {
    ring.visible = false;
    camera.lookAt(cameraLookTarget);
    return;
  }

  const localInspector = playerMeshes.get(myId);
  if (!localInspector) {
    ring.visible = false;
    camera.lookAt(cameraLookTarget);
    return;
  }

  const targetPosition = localInspector.position.clone().add(CAMERA_OFFSET);
  camera.position.lerp(targetPosition, CAMERA_LERP_ALPHA);
  cameraLookTarget.lerp(localInspector.position, 0.16);
  camera.lookAt(cameraLookTarget);

  ring.visible = true;
  ring.position.x = localInspector.position.x;
  ring.position.z = localInspector.position.z;
}

function refreshLastMoveDir() {
  const input = getCombinedKeysSnapshot();
  const horizontal = Number(input.right) - Number(input.left);
  const vertical = Number(input.down) - Number(input.up);
  const length = Math.hypot(horizontal, vertical);

  if (length <= 0.00001) {
    return;
  }

  lastMoveDir.set(horizontal / length, vertical / length);
}

function updateLocalShotFlash(deltaSec: number) {
  if (!myId) {
    return;
  }

  const localInspector = playerMeshes.get(myId);
  if (!localInspector) {
    return;
  }

  const localPlayer = latestPlayers[myId];
  const rig = getInspectorRig(localInspector);
  if (!rig) {
    return;
  }

  if (!localPlayer || localPlayer.hp <= 0) {
    const tipMaterial = rig.scannerTip.material as THREE.MeshStandardMaterial;
    tipMaterial.emissiveIntensity = 0.12;
    return;
  }

  const tipMaterial = rig.scannerTip.material as THREE.MeshStandardMaterial;
  if (localShotFlashTimer > 0) {
    localShotFlashTimer = Math.max(0, localShotFlashTimer - deltaSec);
    tipMaterial.emissiveIntensity = 1.55;
  } else {
    tipMaterial.emissiveIntensity = 0.75;
  }
}

function animateInspectors(deltaSec: number) {
  for (const [playerId, inspector] of playerMeshes) {
    const rig = getInspectorRig(inspector);
    const state = latestPlayers[playerId];
    if (!rig || !state) {
      continue;
    }

    if (rig.dead || state.hp <= 0) {
      rig.moveBlend += (0 - rig.moveBlend) * Math.min(1, deltaSec * 8);
      rig.leftArm.rotation.x = -0.05;
      rig.rightArm.rotation.x = -0.18;
      rig.leftLeg.rotation.x = 0;
      rig.rightLeg.rotation.x = 0;
      rig.locomotionRoot.rotation.x = 0.1;
      rig.locomotionRoot.rotation.z = 0;
      continue;
    }

    const speed = Math.hypot(state.vx, state.vz);
    const moving = speed > 0.05;
    const targetBlend = moving ? 1 : 0;
    rig.moveBlend += (targetBlend - rig.moveBlend) * Math.min(1, deltaSec * 9);
    rig.stepPhase += deltaSec * (4 + Math.min(8, speed) * 1.25);

    const swing = Math.sin(rig.stepPhase * 2.6) * 0.64 * rig.moveBlend;
    rig.leftArm.rotation.x = rig.armBasePitch + swing;
    rig.rightArm.rotation.x = rig.armBasePitch - swing * 0.78;
    rig.leftLeg.rotation.x = rig.legBasePitch - swing * 0.82;
    rig.rightLeg.rotation.x = rig.legBasePitch + swing * 0.82;

    const inv = speed > 0.001 ? 1 / speed : 0;
    const dirX = state.vx * inv;
    const dirZ = state.vz * inv;
    const targetLeanX = -dirZ * 0.12 * rig.moveBlend;
    const targetLeanZ = -dirX * 0.13 * rig.moveBlend;
    rig.locomotionRoot.rotation.x += (targetLeanX - rig.locomotionRoot.rotation.x) * Math.min(1, deltaSec * 10);
    rig.locomotionRoot.rotation.z += (targetLeanZ - rig.locomotionRoot.rotation.z) * Math.min(1, deltaSec * 10);
  }
}

function isGameplayLocked() {
  return gameOverResult !== null || latestMeta?.phaseState === "intermission";
}

function sendShootIfReady(nowMs: number) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !myId || isGameplayLocked()) {
    return;
  }

  const localPlayer = latestPlayers[myId];
  if (!localPlayer || localPlayer.hp <= 0) {
    return;
  }

  if (nowMs - lastShotAtMs < SHOT_COOLDOWN_MS) {
    return;
  }

  const aim = getAimForShot();
  ws.send(
    JSON.stringify({
      type: "shoot",
      dir: {
        x: aim.dir.x,
        z: aim.dir.y,
      },
    })
  );

  lastShotAtMs = nowMs;
  localShotFlashTimer = 0.08;
}

function sendRepairIfNeeded(nowMs: number) {
  const repairHeld = isRepairHeld || isHealButtonHeld;

  if (!ws || ws.readyState !== WebSocket.OPEN || !myId || isGameplayLocked()) {
    if (isRepairRequestActive) {
      ws?.send(JSON.stringify({ type: "repairStop" }));
      isRepairRequestActive = false;
      currentRepairRequestSensorId = null;
    }
    return;
  }

  if (!repairHeld) {
    if (isRepairRequestActive) {
      ws.send(JSON.stringify({ type: "repairStop" }));
      isRepairRequestActive = false;
      currentRepairRequestSensorId = null;
    }
    return;
  }

  const localPlayer = latestPlayers[myId];
  if (!localPlayer || localPlayer.hp <= 0) {
    if (isRepairRequestActive) {
      ws.send(JSON.stringify({ type: "repairStop" }));
      isRepairRequestActive = false;
      currentRepairRequestSensorId = null;
    }
    return;
  }

  const nearestSensorId = getNearestRepairableSensorId();
  if (!nearestSensorId) {
    if (isRepairRequestActive) {
      ws.send(JSON.stringify({ type: "repairStop" }));
      isRepairRequestActive = false;
      currentRepairRequestSensorId = null;
    }
    if (isHealButtonHeld && nowMs - lastRepairHintAtMs >= REPAIR_HINT_COOLDOWN_MS) {
      addEvent("Aproxime-se de um sensor para reparar");
      lastRepairHintAtMs = nowMs;
    }
    return;
  }

  const changedTarget = currentRepairRequestSensorId !== nearestSensorId;
  const shouldRefresh = nowMs - lastRepairSendAtMs >= REPAIR_SEND_INTERVAL_MS;

  if (!isRepairRequestActive || changedTarget || shouldRefresh) {
    ws.send(
      JSON.stringify({
        type: "repair",
        sensorId: nearestSensorId,
      })
    );
    isRepairRequestActive = true;
    currentRepairRequestSensorId = nearestSensorId;
    lastRepairSendAtMs = nowMs;
  }
}

function handleRestartFromServer() {
  gameOverResult = null;
  hideGameOverOverlay();
  hidePhaseTransitionOverlay();
  clearEvents();
  addEvent("Missao reiniciada");

  isRepairHeld = false;
  isHealButtonHeld = false;
  isRepairRequestActive = false;
  currentRepairRequestSensorId = null;
  setHealHoldState(false);

  previousBotCount = 0;
  previousSensorHp.clear();
  sensorDamageLogAt.clear();
  prevBotIds.clear();
  lastBotPos.clear();
  suppressBotDeathFx = true;
  clearBotExplosionFx();
}

function handleServerEvent(eventMsg: ServerEventMessage) {
  if (eventMsg.kind === "bot_neutralized") {
    const by = eventMsg.by || "?";
    addEvent(`Bot neutralizado por P${by}`);
    return;
  }

  if (eventMsg.kind === "restarted") {
    handleRestartFromServer();
  }
}

function handlePhaseMessage(phaseMsg: PhaseMessage) {
  const phase = typeof phaseMsg.phase === "number" ? phaseMsg.phase : 1;

  if (phaseMsg.kind === "complete") {
    gameOverResult = null;
    hideGameOverOverlay();
    showPhaseTransitionOverlay(`PARABENS! FASE ${phase} CONCLUIDA`, "Preparando proxima fase...", 2500);
    addEvent(`Fase ${phase} concluida`);
    return;
  }

  if (phaseMsg.kind === "start") {
    gameOverResult = null;
    hideGameOverOverlay();
    showPhaseTransitionOverlay(`FASE ${phase} INICIADA`, "", 2000);
    showTrechoToastForPhase(phase, 2000);
    addEvent(`Fase ${phase} iniciada`);

    const parsedPhase = toPhaseLevel(phase);
    if (parsedPhase) {
      currentPhase = parsedPhase;
    }
  }
}

function bindSocketHandlers(socket: WebSocket) {
  let hasConnected = false;

  socket.addEventListener("open", () => {
    if (ws !== socket) {
      return;
    }
    hasConnected = true;
    statusEl.textContent = "open";
    fullMessageEl.textContent = "";
  });

  socket.addEventListener("close", () => {
    if (ws !== socket) {
      return;
    }
    statusEl.textContent = "closed";
    if (!hasConnected && fullMessageEl.textContent !== "Sala cheia") {
      showConnectionFailureMessage();
    }
  });

  socket.addEventListener("error", () => {
    if (ws !== socket) {
      return;
    }
    statusEl.textContent = "closed";
    if (!hasConnected && fullMessageEl.textContent !== "Sala cheia") {
      showConnectionFailureMessage();
    }
  });

  socket.addEventListener("message", (event) => {
    if (ws !== socket) {
      return;
    }

    const raw = typeof event.data === "string" ? event.data : null;
    if (!raw) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (!message || typeof message !== "object") {
      return;
    }

    const typed = message as { type?: string };

    if (typed.type === "full") {
      fullMessageEl.textContent = "Sala cheia";
      socket.close();
      return;
    }

    if (typed.type === "welcome") {
      const welcome = message as WelcomeMessage;
      myId = welcome.id;
      myIdEl.textContent = welcome.id;
      roomEl.textContent = welcome.room;
      fullMessageEl.textContent = "";
      addEvent("Equipe conectada");
      return;
    }

    if (typed.type === "event") {
      handleServerEvent(message as ServerEventMessage);
      return;
    }

    if (typed.type === "phase") {
      handlePhaseMessage(message as PhaseMessage);
      return;
    }

    if (typed.type === "gameover") {
      const gameover = message as GameOverMessage;
      const phaseReached =
        gameover.summary?.phaseReached ?? latestMeta?.phaseLevel ?? (currentPhase ? Number(currentPhase) : 1);
      if (gameover.result === "win" && phaseReached < 3) {
        gameOverResult = null;
        hideGameOverOverlay();
        return;
      }
      if (!gameOverResult) {
        gameOverResult = gameover.result;
        showGameOverOverlay(gameover.result, gameover.summary);
      }
      return;
    }

    if (typed.type !== "state") {
      return;
    }

    const state = message as StateMessage;
    if (state.room !== currentRoom || !state.players || !state.sensors || !state.bots || !state.projectiles || !state.meta) {
      return;
    }

    latestPlayers = state.players;
    latestSensors = state.sensors;
    latestBots = state.bots;
    latestMeta = state.meta;

    const statePhase = toPhaseLevel(state.meta.phaseLevel);
    if (statePhase) {
      const phaseChanged = lastServerPhaseLevel !== state.meta.phaseLevel;
      currentPhase = statePhase;
      if (phaseChanged) {
        lastServerPhaseLevel = state.meta.phaseLevel;
        setUrlForSession(currentRoom, statePhase);
        clearEnvironment();
        buildEnvironmentForPhase(statePhase);
        showTrechoToastForPhase(statePhase, 2000);
      }
    } else {
      lastServerPhaseLevel = state.meta.phaseLevel;
    }

    updateBotDeathFxTracking(state.bots, state.meta);
    syncPlayers(state.players);
    syncSensors(state.sensors, state.meta.repairing || {}, state.bots);
    syncBots(state.bots);
    syncProjectiles(state.projectiles);

    updateHud(state.meta);
    processThematicEvents(state.sensors, state.bots);
  });
}

function connectSocket() {
  if (!currentPhase) {
    return;
  }
  statusEl.textContent = "connecting";
  fullMessageEl.textContent = "";

  const socket = new WebSocket(getWsUrl());
  ws = socket;
  bindSocketHandlers(socket);
}

function reconnectSocket(delayMs = 120) {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
  }
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, delayMs);
}

function startCampaignFromBriefing() {
  const explicitRoom = new URLSearchParams(window.location.search).get("room")?.trim();
  if (explicitRoom) {
    currentRoom = explicitRoom;
  } else if (!currentRoom || currentRoom === "default") {
    currentRoom = "campanha";
  }
  roomEl.textContent = currentRoom;
  startPhase(1);
}

function startPhase(level: PhaseLevel) {
  disconnectSocket();
  currentPhase = level;
  lastServerPhaseLevel = null;
  setUrlForSession(currentRoom, currentPhase);
  hideMenuOverlay();
  resetSessionState(true);
  clearEnvironment();
  buildEnvironmentForPhase(level);
  addEvent(`Fase ${level} selecionada`);
  reconnectSocket();
}

function returnToMenu() {
  disconnectSocket();
  lastServerPhaseLevel = null;
  currentPhase = null;
  setUrlForSession(currentRoom, null);
  resetSessionState(true);
  showMenuOverlay();
  statusEl.textContent = "menu";
}

function requestRestartMission() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify({ type: "restart" }));
  gameOverResult = null;
  hideGameOverOverlay();
}

shootBtnEl.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  shootBtnEl.setPointerCapture(event.pointerId);
  setShootHoldState(true);
  sendShootIfReady(performance.now());
});

shootBtnEl.addEventListener("pointerup", (event) => {
  event.preventDefault();
  if (shootBtnEl.hasPointerCapture(event.pointerId)) {
    shootBtnEl.releasePointerCapture(event.pointerId);
  }
  setShootHoldState(false);
});

shootBtnEl.addEventListener("pointercancel", (event) => {
  if (shootBtnEl.hasPointerCapture(event.pointerId)) {
    shootBtnEl.releasePointerCapture(event.pointerId);
  }
  setShootHoldState(false);
});

shootBtnEl.addEventListener("pointerleave", () => {
  if (isShootButtonHeld) {
    setShootHoldState(false);
  }
});

shootBtnEl.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

healBtnEl.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  healBtnEl.setPointerCapture(event.pointerId);
  setHealHoldState(true);
  sendRepairIfNeeded(performance.now());
});

healBtnEl.addEventListener("pointerup", (event) => {
  event.preventDefault();
  if (healBtnEl.hasPointerCapture(event.pointerId)) {
    healBtnEl.releasePointerCapture(event.pointerId);
  }
  setHealHoldState(false);
});

healBtnEl.addEventListener("pointercancel", (event) => {
  if (healBtnEl.hasPointerCapture(event.pointerId)) {
    healBtnEl.releasePointerCapture(event.pointerId);
  }
  setHealHoldState(false);
});

healBtnEl.addEventListener("pointerleave", () => {
  if (isHealButtonHeld) {
    setHealHoldState(false);
  }
});

healBtnEl.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

joystickEl.addEventListener("pointerdown", (event) => {
  if (!isTouchControlMode()) {
    return;
  }
  if (joystickPointerId !== null) {
    return;
  }
  event.preventDefault();
  joystickPointerId = event.pointerId;
  joystickEl.setPointerCapture(event.pointerId);
  joystickEl.classList.add("active");
  updateJoystickFromPointer(event.clientX, event.clientY);
});

window.addEventListener("pointermove", (event) => {
  if (event.pointerId !== joystickPointerId) {
    return;
  }
  event.preventDefault();
  updateJoystickFromPointer(event.clientX, event.clientY);
});

window.addEventListener("pointerup", (event) => {
  if (event.pointerId !== joystickPointerId) {
    return;
  }
  if (joystickEl.hasPointerCapture(event.pointerId)) {
    joystickEl.releasePointerCapture(event.pointerId);
  }
  releaseJoystick();
});

window.addEventListener("pointercancel", (event) => {
  if (event.pointerId !== joystickPointerId) {
    return;
  }
  if (joystickEl.hasPointerCapture(event.pointerId)) {
    joystickEl.releasePointerCapture(event.pointerId);
  }
  releaseJoystick();
});

restartButton.addEventListener("click", () => {
  requestRestartMission();
});

serverSaveButton.addEventListener("click", () => {
  persistWsServer(serverInput.value);
  if (getConfiguredWsServer()) {
    fullMessageEl.textContent = "";
  }
});

serverInput.addEventListener("blur", () => {
  persistWsServer(serverInput.value);
  if (getConfiguredWsServer()) {
    fullMessageEl.textContent = "";
  }
});

serverInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }
  event.preventDefault();
  persistWsServer(serverInput.value);
  if (getConfiguredWsServer()) {
    fullMessageEl.textContent = "";
  }
});

playButton.addEventListener("click", () => {
  const savedServer = persistWsServer(serverInput.value);
  if (requiresManualWsServer() && !savedServer) {
    fullMessageEl.textContent = "Informe o IP:PORT do servidor";
    return;
  }
  startCampaignFromBriefing();
});

backToMenuButton.addEventListener("click", () => {
  returnToMenu();
});

function handleMoveKey(event: KeyboardEvent, pressed: boolean) {
  switch (event.code) {
    case "KeyW":
    case "ArrowUp":
      keys.up = pressed;
      event.preventDefault();
      break;
    case "KeyS":
    case "ArrowDown":
      keys.down = pressed;
      event.preventDefault();
      break;
    case "KeyA":
    case "ArrowLeft":
      keys.left = pressed;
      event.preventDefault();
      break;
    case "KeyD":
    case "ArrowRight":
      keys.right = pressed;
      event.preventDefault();
      break;
    default:
      return;
  }

  refreshLastMoveDir();
}

window.addEventListener("keydown", (event) => {
  if (event.code === "KeyP") {
    event.preventDefault();
    if (skyBannerRig) {
      skyBannerRig.group.visible = !skyBannerRig.group.visible;
    }
    return;
  }

  if (event.code === "Space") {
    event.preventDefault();
    if (!event.repeat) {
      isSpaceHeld = true;
      sendShootIfReady(performance.now());
    }
    return;
  }

  if (event.code === "KeyR") {
    event.preventDefault();
    isRepairHeld = true;
    sendRepairIfNeeded(performance.now());
    return;
  }

  handleMoveKey(event, true);
});

window.addEventListener("keyup", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    isSpaceHeld = false;
    return;
  }

  if (event.code === "KeyR") {
    event.preventDefault();
    isRepairHeld = false;
    if (!isHealButtonHeld && ws && ws.readyState === WebSocket.OPEN && isRepairRequestActive) {
      ws.send(JSON.stringify({ type: "repairStop" }));
      isRepairRequestActive = false;
      currentRepairRequestSensorId = null;
    }
    return;
  }

  handleMoveKey(event, false);
});

window.addEventListener("blur", () => {
  isSpaceHeld = false;
  isRepairHeld = false;
  setHealHoldState(false);
  setShootHoldState(false);
  releaseJoystick();

  if (ws && ws.readyState === WebSocket.OPEN && isRepairRequestActive) {
    ws.send(JSON.stringify({ type: "repairStop" }));
  }
  isRepairRequestActive = false;
  currentRepairRequestSensorId = null;
});

setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN || isGameplayLocked()) {
    return;
  }

  ws.send(
    JSON.stringify({
      type: "input",
      keys: getCombinedKeysSnapshot(),
    })
  );
}, INPUT_INTERVAL_MS);

window.addEventListener("resize", () => {
  if (!isTouchControlMode() && joystickPointerId !== null) {
    releaseJoystick();
  }
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  const deltaSec = clock.getDelta();
  const nowMs = performance.now();

  if (isSpaceHeld || isShootButtonHeld) {
    sendShootIfReady(nowMs);
  }

  sendRepairIfNeeded(nowMs);
  updateAimIndicator();
  updateCameraFollow();
  updateLocalShotFlash(deltaSec);
  animateInspectors(deltaSec);
  animateDrones(deltaSec, nowMs);
  animateBotExplosionFx(deltaSec);
  animateProjectileVisuals(nowMs);
  animateSkyBanner(deltaSec, nowMs);
  animateRiverDecor(nowMs);

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

async function bootstrapGame() {
  await initGameFonts();
  ensureSkyBannerRig();
  buildEnvironmentForPhase(currentPhase ?? 1);
  resetSessionState(true);
  if (currentPhase) {
    startPhase(currentPhase);
  } else {
    showMenuOverlay();
    statusEl.textContent = "menu";
  }

  animate();
}

void bootstrapGame();
