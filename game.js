/* 星晶小猫 —— 太空站收集小游戏
 * 纯原生 Canvas + WebAudio，无外部素材，双击 index.html 即可运行。
 *
 * 玩法：收集晶能启动返回舱（12 点）。
 *   蓝晶 +1；紫晶 +3，只有护盾开启时才能拾取。
 *   护盾要花 3 点晶能，持续 6 秒，免疫辐射与巡逻机器人。
 * 核心选择：晶能既是分数也是货币，开盾会让自己离目标更远，
 *          但不开盾就进不了辐射区，也就拿不到高分紫晶。
 */
(function () {
  'use strict';

  /* ============================================================
   * 1. 常量与关卡数据
   * ============================================================ */
  const TILE = 48;
  const COLS = 16;
  const ROWS = 11;
  const W = COLS * TILE;   // 768
  const H = ROWS * TILE;   // 528
  const STEP_MS = 150;     // 走一格的时间
  const BGC = 2;           // 背景离屏画布倍率

  const GOAL = 12;         // 启动返回舱所需晶能
  const TIME_LIMIT = 80;   // 秒
  const SHIELD_COST = 3;   // 开盾消耗晶能
  const SHIELD_MS = 6000;  // 护盾持续时间
  const RAD_DRAIN = 2;     // 无护盾时辐射区每秒额外扣的秒数
  const HIT_PENALTY = 5;   // 撞机器人扣秒
  const HIT_RADIUS = 30;   // 碰撞半径（像素）

  // T 舱壁 / P 冷却液池 / R 辐射区 / , 气闸通道
  const MAP = [
    'TTTTTTTTTTTTTTTT',
    'T........TRRRRRT',
    'T.PP.....TRRRRRT',
    'T..T.....TRRRRRT',
    'T........TRRRRRT',
    'T........,RRRRRT',
    'T........,RRRRRT',
    'T..T.....TRRRRRT',
    'T.PP.....TRRRRRT',
    'T........TRRRRRT',
    'TTTTTTTTTTTTTTTT'
  ];

  // 安全舱段的蓝晶（+1）
  const BLUE = [
    [1, 1], [4, 1], [7, 2], [1, 4], [5, 4],
    [8, 4], [2, 6], [6, 7], [8, 9]
  ];

  // 辐射舱段的紫晶（+3，需护盾）
  const PURPLE = [
    [12, 2], [13, 4], [11, 5], [13, 7], [10, 8]
  ];

  const START = [1, 5];
  const SAFE_SPOTS = [
    [1, 5], [1, 1], [8, 9], [8, 1], [2, 4], [8, 6]
  ];

  // 机器人巡逻路线（轴对齐闭合路线）
  const ROBOT_PATH = [
    [11, 1], [14, 1], [14, 3], [11, 3],
    [11, 6], [14, 6], [14, 8], [11, 8]
  ];
  const ROBOT_SPEED = 3.2; // 格 / 秒

  /* ============================================================
   * 2. DOM 与画布
   * ============================================================ */
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  const el = {
    hud: document.getElementById('hud'),
    hudEnergy: document.getElementById('hudEnergy'),
    hudEnergyNum: document.getElementById('hudEnergyNum'),
    hudGoal: document.getElementById('hudGoal'),
    hudTime: document.getElementById('hudTime'),
    pillShield: document.getElementById('pillShield'),
    pillTime: document.querySelector('.pill-time'),
    hudShield: document.getElementById('hudShield'),
    overlayMenu: document.getElementById('overlayMenu'),
    overlayPause: document.getElementById('overlayPause'),
    overlayResult: document.getElementById('overlayResult'),
    resultMark: document.getElementById('resultMark'),
    resultTitle: document.getElementById('resultTitle'),
    resultSub: document.getElementById('resultSub'),
    toast: document.getElementById('toast'),
    btnStart: document.getElementById('btnStart'),
    btnShield: document.getElementById('btnShield'),
    btnPause: document.getElementById('btnPause'),
    btnResume: document.getElementById('btnResume'),
    btnPauseRestart: document.getElementById('btnPauseRestart'),
    btnRetry: document.getElementById('btnRetry'),
    btnSound: document.getElementById('btnSound')
  };

  function fitCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
  }
  fitCanvas();
  window.addEventListener('resize', fitCanvas);

  /* ============================================================
   * 3. 状态
   * ============================================================ */
  const G = {
    state: 'menu',        // menu | playing | paused | won | lost
    crystals: [],
    cat: null,
    robot: null,
    energy: 0,
    shieldMs: 0,
    timeLeft: TIME_LIMIT,
    elapsed: 0,
    collisions: 0,
    invuln: 0,
    controlLock: 0,
    shake: 0,
    hitFlash: 0,
    radFlash: 0,
    particles: [],
    popups: [],
    t: 0,
    lastTick: TIME_LIMIT,
    input: { held: [], tap: null },
    denyUntil: 0,
    radToastUntil: 0
  };

  /* ============================================================
   * 4. 音效（WebAudio 合成）
   * ============================================================ */
  const Sfx = {
    ctx: null,
    enabled: true,
    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          try { this.ctx = new AC(); } catch (e) { this.ctx = null; }
        }
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    tone(freq, dur, type, vol, delay) {
      if (!this.enabled || !this.ctx) return;
      const t0 = this.ctx.currentTime + (delay || 0);
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol || 0.12, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },
    collect() {
      this.tone(760, 0.08, 'triangle', 0.12, 0);
      this.tone(1140, 0.11, 'triangle', 0.09, 0.06);
    },
    big() {
      this.tone(620, 0.09, 'triangle', 0.13, 0);
      this.tone(930, 0.09, 'triangle', 0.12, 0.07);
      this.tone(1240, 0.16, 'triangle', 0.1, 0.14);
    },
    shield() {
      this.tone(300, 0.16, 'sine', 0.1, 0);
      this.tone(600, 0.2, 'sine', 0.09, 0.08);
      this.tone(900, 0.26, 'sine', 0.07, 0.16);
    },
    deny() {
      this.tone(220, 0.12, 'square', 0.07, 0);
      this.tone(170, 0.16, 'square', 0.06, 0.08);
    },
    hit() {
      this.tone(190, 0.18, 'sawtooth', 0.13, 0);
      this.tone(120, 0.26, 'square', 0.09, 0.05);
    },
    win() {
      [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.11, i * 0.11));
    },
    lose() {
      [440, 349, 262].forEach((f, i) => this.tone(f, 0.24, 'sine', 0.11, i * 0.15));
    },
    tick() { this.tone(1180, 0.05, 'square', 0.05); },
    step() { this.tone(300, 0.025, 'sine', 0.02); }
  };

  /* ============================================================
   * 5. 工具
   * ============================================================ */
  function hash(x, y) {
    let h = x * 374761393 + y * 668265263;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { return t * t * (3 - 2 * t); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

  function circle(c, x, y, r) {
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }
  function ellipse(c, x, y, rx, ry, rot) {
    c.beginPath();
    c.ellipse(x, y, rx, ry, rot || 0, 0, Math.PI * 2);
    c.fill();
  }
  function rrect(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
    c.fill();
  }
  function cellCenter(gx, gy) {
    return { x: gx * TILE + TILE / 2, y: gy * TILE + TILE / 2 };
  }
  function walkable(x, y) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
    const ch = MAP[y][x];
    return ch !== 'T' && ch !== 'P';
  }
  function isRadCell(x, y) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
    return MAP[y][x] === 'R';
  }
  function catInRadiation() {
    return !!G.cat && isRadCell(G.cat.x, G.cat.y);
  }

  /* ============================================================
   * 6. 背景（离屏绘制一次）
   * ============================================================ */
  let bgCanvas = null;

  function drawFloor(g, x, y) {
    const px = x * TILE;
    const py = y * TILE;
    const rad = MAP[y][x] === 'R';

    g.fillStyle = rad ? '#241d3a' : ((x + y) % 2 ? '#1a2138' : '#1d2540');
    g.fillRect(px, py, TILE, TILE);

    // 地板拼缝
    g.strokeStyle = rad ? 'rgba(180,130,255,0.16)' : 'rgba(140,175,235,0.10)';
    g.lineWidth = 1;
    g.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);

    // 螺栓
    g.fillStyle = rad ? 'rgba(190,150,255,0.22)' : 'rgba(150,180,235,0.16)';
    [[7, 7], [TILE - 7, 7], [7, TILE - 7], [TILE - 7, TILE - 7]].forEach(([dx, dy]) => {
      circle(g, px + dx, py + dy, 1.4);
    });

    if (rad) {
      // 辐射区：斜向危险条纹
      g.save();
      g.beginPath();
      g.rect(px, py, TILE, TILE);
      g.clip();
      g.strokeStyle = 'rgba(190,130,255,0.10)';
      g.lineWidth = 6;
      for (let k = -TILE; k < TILE * 2; k += 16) {
        g.beginPath();
        g.moveTo(px + k, py);
        g.lineTo(px + k - TILE, py + TILE);
        g.stroke();
      }
      g.restore();
      g.strokeStyle = 'rgba(200,150,255,0.22)';
      g.strokeRect(px + 1.5, py + 1.5, TILE - 3, TILE - 3);
    } else if (MAP[y][x] === '.' && hash(x * 31 + 7, y * 17 + 3) > 0.78) {
      // 通风口 / 地灯
      g.fillStyle = 'rgba(120,190,255,0.10)';
      g.fillRect(px + 12, py + 18, 24, 12);
      g.strokeStyle = 'rgba(120,190,255,0.22)';
      g.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.moveTo(px + 14, py + 21 + i * 3);
        g.lineTo(px + 34, py + 21 + i * 3);
        g.stroke();
      }
    }
  }

  function drawWall(g, x, y) {
    const px = x * TILE;
    const py = y * TILE;
    const grad = g.createLinearGradient(px, py, px, py + TILE);
    grad.addColorStop(0, '#5a6a9a');
    grad.addColorStop(0.55, '#3c4874');
    grad.addColorStop(1, '#2c3659');
    g.fillStyle = grad;
    g.fillRect(px, py, TILE, TILE);

    // 内嵌面板 + 斜角，让舱壁明显高出地面
    g.fillStyle = 'rgba(255, 255, 255, 0.08)';
    g.fillRect(px + 5, py + 5, TILE - 10, TILE - 10);
    g.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(px + 5, py + TILE - 5);
    g.lineTo(px + 5, py + 5);
    g.lineTo(px + TILE - 5, py + 5);
    g.stroke();
    g.strokeStyle = 'rgba(0, 0, 0, 0.32)';
    g.beginPath();
    g.moveTo(px + TILE - 5, py + 5);
    g.lineTo(px + TILE - 5, py + TILE - 5);
    g.lineTo(px + 5, py + TILE - 5);
    g.stroke();

    g.strokeStyle = 'rgba(8, 13, 28, 0.85)';
    g.lineWidth = 2;
    g.strokeRect(px + 1, py + 1, TILE - 2, TILE - 2);

    const up = MAP[y - 1] ? MAP[y - 1][x] : 'T';
    const down = MAP[y + 1] ? MAP[y + 1][x] : 'T';
    if (up !== 'T') {
      g.fillStyle = 'rgba(170, 205, 255, 0.30)';
      g.fillRect(px, py, TILE, 3);
    }
    if (down !== 'T') {
      g.fillStyle = 'rgba(0, 0, 0, 0.38)';
      g.fillRect(px, py + TILE - 5, TILE, 5);
    }

    g.fillStyle = 'rgba(160, 190, 245, 0.25)';
    [[10, 10], [TILE - 10, 10], [10, TILE - 10], [TILE - 10, TILE - 10]].forEach(([dx, dy]) => {
      circle(g, px + dx, py + dy, 1.6);
    });

    if (hash(x * 13 + 5, y * 7 + 11) > 0.72) {
      g.fillStyle = 'rgba(120, 220, 255, 0.35)';
      g.fillRect(px + 18, py + 22, 12, 3);
      g.fillStyle = 'rgba(120, 220, 255, 0.14)';
      g.fillRect(px + 16, py + 20, 16, 7);
    }
  }

  function drawPool(g, x, y) {
    const px = x * TILE;
    const py = y * TILE;
    const grad = g.createLinearGradient(px, py, px, py + TILE);
    grad.addColorStop(0, '#1f7f9e');
    grad.addColorStop(1, '#0d3f57');
    g.fillStyle = grad;
    g.fillRect(px, py, TILE, TILE);

    g.strokeStyle = 'rgba(160, 240, 255, 0.42)';
    g.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.arc(px + 16 + i * 8, py + 30 - i * 6, 5 + i * 2, Math.PI * 1.05, Math.PI * 1.85);
      g.stroke();
    }
    g.fillStyle = 'rgba(200, 250, 255, 0.45)';
    [[14, 14], [30, 22], [22, 36]].forEach(([dx, dy]) => circle(g, px + dx, py + dy, 1.8));

    g.strokeStyle = '#2b3a5e';
    g.lineWidth = 3;
    g.strokeRect(px + 1.5, py + 1.5, TILE - 3, TILE - 3);
  }

  function buildBackground() {
    const cv = document.createElement('canvas');
    cv.width = W * BGC;
    cv.height = H * BGC;
    const g = cv.getContext('2d');
    g.scale(BGC, BGC);

    g.fillStyle = '#0d1326';
    g.fillRect(0, 0, W, H);

    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const ch = MAP[y][x];
        if (ch === 'T') drawWall(g, x, y);
        else if (ch === 'P') drawPool(g, x, y);
        else drawFloor(g, x, y);
      }
    }

    // 气闸指示灯
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (MAP[y][x] !== ',') continue;
        const px = x * TILE;
        const py = y * TILE;
        g.fillStyle = 'rgba(111, 210, 255, 0.10)';
        g.fillRect(px, py, TILE, TILE);
        g.strokeStyle = 'rgba(111, 210, 255, 0.45)';
        g.lineWidth = 2;
        g.strokeRect(px + 4, py + 4, TILE - 8, TILE - 8);
      }
    }

    return cv;
  }

  /* ============================================================
   * 7. 角色与道具绘制
   * ============================================================ */
  function drawCat(c, cx, cy, t, moving, face, blink, invuln) {
    const bob = moving ? Math.sin(t * 18) * 1.6 : Math.sin(t * 2.2) * 0.7;
    const y = cy + bob;
    const f = face;

    c.save();
    if (invuln > 0) c.globalAlpha = Math.sin(t * 30) > 0 ? 0.4 : 1;

    c.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ellipse(c, cx, cy + 18, 17, 5.5);

    // 背包
    c.fillStyle = '#39466b';
    rrect(c, cx - f * 15 - 5, y - 3, 10, 15, 3);
    c.fillStyle = 'rgba(111, 210, 255, 0.85)';
    circle(c, cx - f * 15, y + 1, 1.7);

    // 尾巴
    const wag = Math.sin(t * 3.6) * 5;
    c.strokeStyle = '#e2a566';
    c.lineWidth = 6;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(cx - f * 11, y + 5);
    c.quadraticCurveTo(cx - f * 22, y + 3 + wag, cx - f * 19, y - 12 + wag);
    c.stroke();

    // 腿
    const legPhase = moving ? Math.sin(t * 22) : 0;
    c.fillStyle = '#e9ac6c';
    rrect(c, cx - 11, y + 8, 7, 10 + legPhase * 2, 3.5);
    rrect(c, cx + 5, y + 8, 7, 10 - legPhase * 2, 3.5);
    c.fillStyle = '#f0bb80';
    rrect(c, cx - 4, y + 9, 7, 9 - legPhase * 2, 3.5);
    rrect(c, cx + 11, y + 9, 7, 9 + legPhase * 2, 3.5);

    // 身体
    c.fillStyle = '#f7ca93';
    ellipse(c, cx, y + 3, 16, 11.5);
    c.strokeStyle = '#e2a566';
    c.lineWidth = 2.4;
    c.beginPath();
    c.moveTo(cx - 7, y - 4); c.quadraticCurveTo(cx - 4, y - 1, cx - 7, y + 2);
    c.moveTo(cx - 1, y - 5); c.quadraticCurveTo(cx + 2, y - 1, cx - 1, y + 2);
    c.stroke();

    // 胸口指示灯
    c.fillStyle = 'rgba(111, 210, 255, 0.9)';
    circle(c, cx + f * 3, y + 3, 2);
    c.fillStyle = 'rgba(111, 210, 255, 0.25)';
    circle(c, cx + f * 3, y + 3, 5);

    // 头
    const hx = cx + f * 8;
    const hy = y - 8;

    c.fillStyle = '#f0b87b';
    c.beginPath();
    c.moveTo(hx - 9, hy - 7); c.lineTo(hx - 4, hy - 16); c.lineTo(hx + 1, hy - 8);
    c.closePath(); c.fill();
    c.beginPath();
    c.moveTo(hx + 3, hy - 8); c.lineTo(hx + 8, hy - 16); c.lineTo(hx + 10, hy - 5);
    c.closePath(); c.fill();
    c.fillStyle = '#f6a7a2';
    c.beginPath();
    c.moveTo(hx - 6.5, hy - 8); c.lineTo(hx - 4.5, hy - 13); c.lineTo(hx - 2, hy - 8.5);
    c.closePath(); c.fill();
    c.beginPath();
    c.moveTo(hx + 4.5, hy - 8.5); c.lineTo(hx + 7.5, hy - 13); c.lineTo(hx + 8.5, hy - 7);
    c.closePath(); c.fill();

    c.fillStyle = '#f9d4a6';
    circle(c, hx, hy, 11.5);
    c.fillStyle = '#fff6e6';
    ellipse(c, hx + f * 3, hy + 4, 6.5, 5);

    if (blink) {
      c.strokeStyle = '#4a3a2c';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(hx - 4, hy - 2); c.lineTo(hx - 0.5, hy - 2);
      c.moveTo(hx + 3, hy - 2); c.lineTo(hx + 6.5, hy - 2);
      c.stroke();
    } else {
      c.fillStyle = '#4a3a2c';
      circle(c, hx - 2.2, hy - 2.5, 2.4);
      circle(c, hx + 5.2, hy - 2.5, 2.4);
      c.fillStyle = '#fff';
      circle(c, hx - 1.5, hy - 3.2, 0.9);
      circle(c, hx + 5.9, hy - 3.2, 0.9);
    }

    c.fillStyle = '#e58a8a';
    c.beginPath();
    c.moveTo(hx + f * 2, hy + 4);
    c.lineTo(hx + f * 5, hy + 6);
    c.lineTo(hx + f * 2, hy + 7.4);
    c.closePath(); c.fill();

    c.strokeStyle = 'rgba(120, 100, 80, 0.55)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(hx + 7, hy + 5); c.lineTo(hx + 14, hy + 4);
    c.moveTo(hx + 7, hy + 7); c.lineTo(hx + 13, hy + 9);
    c.stroke();

    c.fillStyle = 'rgba(246, 154, 154, 0.5)';
    circle(c, hx - 7, hy + 3, 2.6);
    circle(c, hx + 10, hy + 3, 2.4);

    // 头盔
    c.save();
    c.globalAlpha = 0.26;
    c.fillStyle = '#a8e8ff';
    circle(c, hx, hy, 16.5);
    c.globalAlpha = 0.85;
    c.strokeStyle = 'rgba(190, 240, 255, 0.75)';
    c.lineWidth = 1.6;
    c.beginPath();
    c.arc(hx, hy, 16.5, 0, Math.PI * 2);
    c.stroke();
    c.globalAlpha = 0.55;
    c.strokeStyle = '#ffffff';
    c.lineWidth = 2.2;
    c.beginPath();
    c.arc(hx, hy, 12.5, Math.PI * 1.12, Math.PI * 1.5);
    c.stroke();
    c.restore();

    // 天线
    c.strokeStyle = '#8ea6d8';
    c.lineWidth = 1.8;
    c.beginPath();
    c.moveTo(hx - 2, hy - 16);
    c.lineTo(hx - 3, hy - 23);
    c.stroke();
    const blinkAnt = 0.55 + 0.45 * Math.sin(t * 5);
    c.fillStyle = `rgba(255, 140, 140, ${blinkAnt})`;
    circle(c, hx - 3, hy - 24, 2.2);

    c.restore();
  }

  function drawRobot(c, cx, cy, t, face) {
    const bob = Math.sin(t * 4) * 2.4;
    const y = cy + bob;
    const f = face;

    c.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ellipse(c, cx, cy + 18, 15, 5);

    // 尾部推进器
    const flicker = 0.7 + 0.3 * Math.sin(t * 22);
    c.save();
    c.globalCompositeOperation = 'lighter';
    const flame = c.createLinearGradient(cx, y + 10, cx, y + 26);
    flame.addColorStop(0, `rgba(120, 210, 255, ${0.55 * flicker})`);
    flame.addColorStop(1, 'rgba(80, 160, 255, 0)');
    c.fillStyle = flame;
    ellipse(c, cx - 8, y + 16, 4.5, 9 * flicker);
    ellipse(c, cx + 8, y + 16, 4.5, 9 * flicker);
    c.restore();

    // 机身
    c.fillStyle = '#414d73';
    rrect(c, cx - 15, y - 14, 30, 26, 9);
    c.fillStyle = '#5a6a96';
    rrect(c, cx - 12, y - 11, 24, 8, 5);
    c.fillStyle = 'rgba(0, 0, 0, 0.25)';
    rrect(c, cx - 15, y + 5, 30, 7, 5);

    // 独眼
    c.fillStyle = '#0b1120';
    circle(c, cx + f * 3, y, 7.6);
    const eye = 0.7 + 0.3 * Math.sin(t * 6);
    c.fillStyle = `rgba(255, 108, 92, ${eye})`;
    circle(c, cx + f * 3, y, 4.6);
    c.fillStyle = `rgba(255, 220, 210, ${0.75 * eye})`;
    circle(c, cx + f * 3 - 1.2, y - 1.4, 1.6);

    // 扫描光
    c.save();
    c.globalCompositeOperation = 'lighter';
    const scan = c.createLinearGradient(cx + f * 3, y, cx + f * 40, y);
    scan.addColorStop(0, 'rgba(255, 110, 95, 0.28)');
    scan.addColorStop(1, 'rgba(255, 110, 95, 0)');
    c.fillStyle = scan;
    c.beginPath();
    c.moveTo(cx + f * 5, y - 4);
    c.lineTo(cx + f * 46, y - 16);
    c.lineTo(cx + f * 46, y + 16);
    c.lineTo(cx + f * 5, y + 4);
    c.closePath();
    c.fill();
    c.restore();

    // 侧翼与天线
    c.fillStyle = '#7b8dba';
    rrect(c, cx - 21, y - 6, 7, 12, 3);
    rrect(c, cx + 14, y - 6, 7, 12, 3);
    c.strokeStyle = '#8ea6d8';
    c.lineWidth = 1.6;
    c.beginPath();
    c.moveTo(cx, y - 14);
    c.lineTo(cx, y - 21);
    c.stroke();
    c.fillStyle = `rgba(255, 120, 120, ${0.6 + 0.4 * Math.sin(t * 7)})`;
    circle(c, cx, y - 22, 2);
  }

  function drawCrystal(c, cx, cy, t, value, phase) {
    const bob = Math.sin(t * 2 + phase) * 2.2;
    const y = cy + bob;
    const big = value > 1;
    const main = big ? '#c08bff' : '#6fd2ff';
    const lite = big ? '#f0daff' : '#d6f6ff';
    const dark = big ? '#6f45c0' : '#2f8fc4';

    c.save();
    c.globalCompositeOperation = 'lighter';
    const halo = c.createRadialGradient(cx, y, 1, cx, y, big ? 27 : 21);
    halo.addColorStop(0, big ? 'rgba(200, 150, 255, 0.55)' : 'rgba(120, 215, 255, 0.45)');
    halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
    c.fillStyle = halo;
    circle(c, cx, y, big ? 27 : 21);
    c.restore();

    c.save();
    c.translate(cx, y);

    // 晶体主体
    const pts = [[0, -15], [10, -4], [7, 12], [-7, 12], [-10, -4]];
    c.beginPath();
    pts.forEach(([px, py], i) => i ? c.lineTo(px, py) : c.moveTo(px, py));
    c.closePath();
    c.fillStyle = main;
    c.fill();

    // 切面
    c.beginPath();
    c.moveTo(0, -15);
    c.lineTo(10, -4);
    c.lineTo(2, 2);
    c.closePath();
    c.fillStyle = lite;
    c.fill();
    c.beginPath();
    c.moveTo(0, -15);
    c.lineTo(-10, -4);
    c.lineTo(-2, 0);
    c.closePath();
    c.fillStyle = dark;
    c.globalAlpha = 0.85;
    c.fill();
    c.globalAlpha = 1;

    // 底座
    c.fillStyle = 'rgba(255, 255, 255, 0.35)';
    c.fillRect(-4, 8, 8, 2);

    // 闪光
    const tw = 0.5 + 0.5 * Math.sin(t * 4 + phase * 6);
    c.strokeStyle = `rgba(255, 255, 255, ${0.25 + tw * 0.6})`;
    c.lineWidth = 1.6;
    c.beginPath();
    c.moveTo(4, -8); c.lineTo(4, -1);
    c.moveTo(0.5, -4.5); c.lineTo(7.5, -4.5);
    c.stroke();

    c.restore();

    if (big) {
      // 紫晶上方的小星标
      const sy = y - 21 + Math.sin(t * 3 + phase) * 1.5;
      c.fillStyle = '#e6c8ff';
      c.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
        const a2 = a + Math.PI / 5;
        c.lineTo(cx + Math.cos(a) * 4.6, sy + Math.sin(a) * 4.6);
        c.lineTo(cx + Math.cos(a2) * 2, sy + Math.sin(a2) * 2);
      }
      c.closePath();
      c.fill();
    }
  }

  function drawShield(c, cx, cy, t) {
    const r = 27 + Math.sin(t * 6) * 1.4;

    c.save();
    c.globalCompositeOperation = 'lighter';
    const glow = c.createRadialGradient(cx, cy, r * 0.6, cx, cy, r + 12);
    glow.addColorStop(0, 'rgba(120, 220, 255, 0)');
    glow.addColorStop(0.7, 'rgba(120, 220, 255, 0.16)');
    glow.addColorStop(1, 'rgba(120, 220, 255, 0)');
    c.fillStyle = glow;
    circle(c, cx, cy, r + 12);
    c.restore();

    c.save();
    c.translate(cx, cy);
    c.rotate(t * 0.7);
    c.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (i) c.lineTo(px, py);
      else c.moveTo(px, py);
    }
    c.closePath();
    c.strokeStyle = 'rgba(150, 235, 255, 0.9)';
    c.lineWidth = 2;
    c.stroke();
    c.strokeStyle = 'rgba(90, 190, 255, 0.30)';
    c.lineWidth = 8;
    c.stroke();
    c.restore();
  }

  function drawPatrolPath(c) {
    if (!G.robot) return;
    const pts = G.robot.path;
    c.save();
    c.strokeStyle = 'rgba(255, 140, 130, 0.28)';
    c.lineWidth = 2;
    c.setLineDash([6, 10]);
    c.lineJoin = 'round';
    c.beginPath();
    pts.forEach((p, i) => {
      const p1 = cellCenter(p.x, p.y);
      if (i === 0) c.moveTo(p1.x, p1.y);
      else c.lineTo(p1.x, p1.y);
    });
    c.closePath();
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = 'rgba(255, 150, 140, 0.35)';
    pts.forEach(p => {
      const p1 = cellCenter(p.x, p.y);
      circle(c, p1.x, p1.y, 2.2);
    });
    c.restore();
  }

  /* ============================================================
   * 8. 特效
   * ============================================================ */
  function burst(x, y, color, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (speed || 90) * (0.4 + Math.random() * 0.8);
      G.particles.push({
        x, y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 30,
        life: 0.55 + Math.random() * 0.35,
        max: 0.9,
        size: 2 + Math.random() * 3,
        color,
        gravity: 220
      });
    }
  }

  function confetti() {
    const colors = ['#6fd2ff', '#c08bff', '#ffd166', '#86f0cc', '#ffffff'];
    for (let i = 0; i < 70; i++) {
      G.particles.push({
        x: Math.random() * W,
        y: -20 - Math.random() * 120,
        vx: (Math.random() - 0.5) * 60,
        vy: 70 + Math.random() * 100,
        life: 2.2 + Math.random() * 0.8,
        max: 3,
        size: 3 + Math.random() * 4,
        color: colors[i % colors.length],
        gravity: 25,
        square: true
      });
    }
  }

  function popup(gx, gy, text, color, emphasize) {
    const p = cellCenter(gx, gy);
    const duration = emphasize ? 1.3 : 1.0;
    G.popups.push({
      x: p.x, y: p.y - 14, text,
      color: color || '#fff',
      life: duration, max: duration,
      size: emphasize ? 19 : 14
    });
  }

  function updateEffects(dt) {
    const d = dt / 1000;
    for (let i = G.particles.length - 1; i >= 0; i--) {
      const p = G.particles[i];
      p.x += p.vx * d;
      p.y += p.vy * d;
      p.vy += (p.gravity || 0) * d;
      p.life -= d;
      if (p.life <= 0) G.particles.splice(i, 1);
    }
    for (let i = G.popups.length - 1; i >= 0; i--) {
      const p = G.popups[i];
      p.y -= 26 * d;
      p.life -= d;
      if (p.life <= 0) G.popups.splice(i, 1);
    }
    if (G.shake > 0) G.shake = Math.max(0, G.shake - 60 * d);
    if (G.hitFlash > 0) G.hitFlash = Math.max(0, G.hitFlash - 2.2 * d);
    if (G.radFlash > 0) G.radFlash = Math.max(0, G.radFlash - 2.2 * d);
    if (G.invuln > 0) G.invuln = Math.max(0, G.invuln - d);
    if (G.controlLock > 0) G.controlLock = Math.max(0, G.controlLock - d);
  }

  function renderEffects(c) {
    G.particles.forEach(p => {
      const a = clamp(p.life / p.max, 0, 1);
      c.globalAlpha = a;
      c.fillStyle = p.color;
      if (p.square) {
        c.save();
        c.translate(p.x, p.y);
        c.rotate(p.x * 0.02 + p.life * 2);
        c.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        c.restore();
      } else {
        circle(c, p.x, p.y, p.size * a);
      }
    });
    c.globalAlpha = 1;

    G.popups.forEach(p => {
      const a = clamp(p.life / p.max, 0, 1);
      c.globalAlpha = a;
      c.font = `700 ${p.size}px "PingFang SC", "Microsoft YaHei", sans-serif`;
      c.textAlign = 'center';
      c.lineWidth = 4;
      c.strokeStyle = 'rgba(6, 10, 24, 0.7)';
      c.strokeText(p.text, p.x, p.y);
      c.fillStyle = p.color;
      c.fillText(p.text, p.x, p.y);
    });
    c.globalAlpha = 1;
    c.textAlign = 'left';
  }

  /* ============================================================
   * 9. 流程
   * ============================================================ */
  function buildCrystals() {
    const list = [];
    BLUE.forEach(([x, y], i) => {
      list.push({ x, y, v: 1, taken: false, phase: hash(x + i * 3, y + i) });
    });
    PURPLE.forEach(([x, y], i) => {
      list.push({ x, y, v: 3, taken: false, phase: hash(x + i * 5, y + i * 2) });
    });
    return list;
  }

  function setupWorld() {
    G.crystals = buildCrystals();
    G.cat = {
      x: START[0], y: START[1],
      from: null, to: null, p: 0, moving: false,
      dir: { x: 1, y: 0 }, face: 1, bump: 0
    };
    G.robot = {
      path: ROBOT_PATH.map(p => ({ x: p[0], y: p[1] })),
      seg: 0,
      segP: 0,
      speed: ROBOT_SPEED,
      px: (ROBOT_PATH[0][0] + 0.5) * TILE,
      py: (ROBOT_PATH[0][1] + 0.5) * TILE,
      face: 1
    };
    G.energy = 0;
    G.shieldMs = 0;
    G.timeLeft = TIME_LIMIT;
    G.elapsed = 0;
    G.collisions = 0;
    G.invuln = 0;
    G.controlLock = 0;
    G.shake = 0;
    G.hitFlash = 0;
    G.radFlash = 0;
    G.particles = [];
    G.popups = [];
    G.input.held = [];
    G.input.tap = null;
    G.denyUntil = 0;
    G.radToastUntil = 0;
    if (!bgCanvas) bgCanvas = buildBackground();
    updateHUD();
  }

  function startGame() {
    setupWorld();
    G.state = 'playing';
    hideOverlays();
    clearToast();
    Sfx.ensure();
    canvas.focus();
    updateHUD();
  }

  function showMenu() {
    setupWorld();
    G.state = 'menu';
    hideOverlays();
    clearToast();
    el.overlayMenu.classList.add('show');
    el.btnStart.focus();
    updateHUD();
  }

  function hideOverlays() {
    el.overlayMenu.classList.remove('show');
    el.overlayPause.classList.remove('show');
    el.overlayResult.classList.remove('show');
  }

  function pauseGame() {
    if (G.state !== 'playing') return;
    G.state = 'paused';
    G.input.held = [];
    G.input.tap = null;
    el.overlayPause.classList.add('show');
    el.btnResume.focus();
    updateHUD();
  }

  function resumeGame() {
    if (G.state !== 'paused') return;
    G.state = 'playing';
    el.overlayPause.classList.remove('show');
    canvas.focus();
    Sfx.ensure();
    updateHUD();
  }

  function endGame(win) {
    if (G.state === 'won' || G.state === 'lost') return;
    G.state = win ? 'won' : 'lost';
    G.input.held = [];
    G.input.tap = null;
    G.shieldMs = 0;

    if (win) {
      Sfx.win();
      confetti();
      const p = cellCenter(G.cat.x, G.cat.y);
      burst(p.x, p.y - 10, '#9ff0ff', 20, 150);
    } else {
      Sfx.lose();
    }

    el.resultMark.textContent = win ? '✓' : '!';
    el.resultMark.classList.toggle('lose', !win);

    if (win) {
      el.resultTitle.textContent = '返回舱点火成功！';
      el.resultSub.textContent = `晶能 ${Math.min(G.energy, GOAL)} / ${GOAL}，小猫回家了。`;
    } else {
      el.resultTitle.textContent = '时间到，舱门关上了';
      el.resultSub.textContent = `还差 ${Math.max(0, GOAL - G.energy)} 点晶能。按“再试一次”重来。`;
    }

    setTimeout(() => {
      if (G.state === 'won' || G.state === 'lost') {
        el.overlayResult.classList.add('show');
        el.btnRetry.focus();
      }
    }, 460);

    updateHUD();
  }

  function checkWin() {
    if (G.energy >= GOAL) endGame(true);
  }

  /* ============================================================
   * 10. 收集与护盾
   * ============================================================ */
  function tryCollect(gx, gy) {
    const cr = G.crystals.find(k => !k.taken && k.x === gx && k.y === gy);
    if (!cr) return false;

    if (cr.v > 1 && G.shieldMs <= 0) {
      const now = performance.now();
      if (now > G.denyUntil) {
        G.denyUntil = now + 1600;
        popup(gx, gy, '需要护盾', '#e3caff', true);
        toast(`紫晶被辐射包住：按空格花 ${SHIELD_COST} 点晶能开护盾`, 2200);
        Sfx.deny();
      }
      return false;
    }

    cr.taken = true;
    G.energy += cr.v;
    const p = cellCenter(cr.x, cr.y);
    burst(p.x, p.y, cr.v > 1 ? '#d9b8ff' : '#9de8ff', cr.v > 1 ? 18 : 10, cr.v > 1 ? 160 : 100);
    popup(cr.x, cr.y, `+${cr.v} 晶能`, cr.v > 1 ? '#e3caff' : '#d6f6ff', true);
    if (cr.v > 1) Sfx.big(); else Sfx.collect();
    G.invuln = Math.max(G.invuln, 0.1);
    updateHUD();
    checkWin();
    return true;
  }

  function activateShield() {
    if (G.state !== 'playing') return false;
    if (G.shieldMs > 0) {
      toast('护盾已经在运行');
      return false;
    }
    if (G.energy < SHIELD_COST) {
      toast(`晶能不足：开护盾需要 ${SHIELD_COST} 点，先去捡蓝晶`);
      Sfx.deny();
      updateHUD();
      return false;
    }
    G.energy -= SHIELD_COST;
    G.shieldMs = SHIELD_MS;
    const p = cellCenter(G.cat.x, G.cat.y);
    burst(p.x, p.y, '#9ff0ff', 16, 130);
    popup(G.cat.x, G.cat.y, `护盾 −${SHIELD_COST}`, '#c9f7ff', true);
    toast('护盾开启 6 秒：辐射区里的紫晶可以拿了', 1900);
    Sfx.shield();
    updateHUD();
    return true;
  }

  /* ============================================================
   * 11. 更新
   * ============================================================ */
  function currentDir() {
    const held = G.input.held;
    if (held.length) return held[held.length - 1];
    const tap = G.input.tap;
    if (tap && performance.now() < tap.until) return tap;
    return null;
  }

  function tryStep() {
    const cat = G.cat;
    const d = currentDir();
    if (!d) return;
    cat.dir = d;
    if (d.x) cat.face = d.x > 0 ? 1 : -1;
    const nx = cat.x + d.x;
    const ny = cat.y + d.y;
    if (!walkable(nx, ny)) {
      cat.bump = 0.14;
      return;
    }
    cat.from = { x: cat.x, y: cat.y };
    cat.to = { x: nx, y: ny };
    cat.p = 0;
    cat.moving = true;
  }

  function updateCat(dt) {
    const cat = G.cat;
    const wasMoving = cat.moving;

    if (cat.moving) {
      cat.p += dt / STEP_MS;
      if (cat.p >= 1) {
        cat.p = 1;
        cat.moving = false;
        cat.x = cat.to.x;
        cat.y = cat.to.y;
        tryCollect(cat.x, cat.y);
      }
    }

    if (!wasMoving && !cat.moving && G.controlLock <= 0 && G.state === 'playing') tryStep();
  }

  function updateRobot(dt) {
    const robot = G.robot;
    if (!robot) return;
    let remain = (dt / 1000) * robot.speed;
    let guard = 0;

    while (remain > 0 && guard++ < 12) {
      const a = robot.path[robot.seg];
      const b = robot.path[(robot.seg + 1) % robot.path.length];
      const segLen = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      const need = (1 - robot.segP) * segLen;
      if (remain < need) {
        robot.segP += remain / segLen;
        remain = 0;
      } else {
        remain -= need;
        robot.seg = (robot.seg + 1) % robot.path.length;
        robot.segP = 0;
        if (b.x !== a.x) robot.face = b.x > a.x ? 1 : -1;
      }
    }

    const a = robot.path[robot.seg];
    const b = robot.path[(robot.seg + 1) % robot.path.length];
    robot.px = (a.x + (b.x - a.x) * robot.segP + 0.5) * TILE;
    robot.py = (a.y + (b.y - a.y) * robot.segP + 0.5) * TILE;
  }

  function catPixel() {
    const cat = G.cat;
    if (cat.moving && cat.from && cat.to) {
      const e = ease(cat.p);
      return {
        x: (lerp(cat.from.x, cat.to.x, e) + 0.5) * TILE,
        y: (lerp(cat.from.y, cat.to.y, e) + 0.5) * TILE
      };
    }
    return cellCenter(cat.x, cat.y);
  }

  function checkRobotHit() {
    const robot = G.robot;
    if (!robot || G.invuln > 0 || G.state !== 'playing') return;
    const cat = catPixel();
    if (dist(cat.x, cat.y, robot.px, robot.py) < HIT_RADIUS) {
      if (G.shieldMs > 0) {
        const p = cellCenter(G.cat.x, G.cat.y);
        burst(p.x, p.y, '#9ff0ff', 8, 90);
        return;
      }
      hitRobot();
    }
  }

  function hitRobot() {
    G.collisions++;
    G.timeLeft = Math.max(0, G.timeLeft - HIT_PENALTY);
    G.invuln = 1.3;
    G.controlLock = 0.24;
    G.shake = 12;
    G.hitFlash = 1;
    Sfx.hit();

    const from = catPixel();
    burst(from.x, from.y, '#ff9a8a', 12, 140);
    popup(G.cat.x, G.cat.y, `−${HIT_PENALTY} 秒`, '#ff9a9a');

    teleportSafe();
    toast(`撞到巡逻机器人 · −${HIT_PENALTY} 秒 · 已退回安全舱`, 1700);

    const to = cellCenter(G.cat.x, G.cat.y);
    burst(to.x, to.y, '#bcd8ff', 10, 90);
    updateHUD();

    if (G.timeLeft <= 0) endGame(false);
  }

  function teleportSafe() {
    const cat = G.cat;
    let best = null;
    let bestScore = Infinity;

    SAFE_SPOTS.forEach(([x, y]) => {
      if (!walkable(x, y)) return;
      const p = cellCenter(x, y);
      const robotD = G.robot ? dist(p.x, p.y, G.robot.px, G.robot.py) / TILE : 99;
      if (robotD < 3) return;
      const catD = Math.hypot(x - cat.x, y - cat.y);
      if (catD < bestScore) {
        bestScore = catD;
        best = [x, y];
      }
    });

    if (!best) best = START;
    cat.moving = false;
    cat.x = best[0];
    cat.y = best[1];
    cat.p = 0;
    cat.from = null;
    cat.to = null;
  }

  function update(dt) {
    const d = dt / 1000;

    if (G.shieldMs > 0) {
      G.shieldMs = Math.max(0, G.shieldMs - dt);
      if (G.shieldMs === 0) toast('护盾结束了', 1200);
    }

    G.timeLeft -= d;
    G.elapsed += d;

    if (catInRadiation() && G.shieldMs <= 0) {
      G.timeLeft -= RAD_DRAIN * d;
      G.radFlash = Math.min(1, G.radFlash + 2.4 * d);
      const now = performance.now();
      if (now > G.radToastUntil) {
        G.radToastUntil = now + 3000;
        toast(`辐射过强：每秒多掉 ${RAD_DRAIN} 秒，护盾可以免疫`, 2000);
      }
    }

    if (G.timeLeft <= 0) {
      G.timeLeft = 0;
      updateHUD();
      endGame(false);
      return;
    }

    const sec = Math.ceil(G.timeLeft);
    if (sec !== G.lastTick) {
      G.lastTick = sec;
      if (sec <= 5 && sec > 0) Sfx.tick();
    }

    updateCat(dt);
    updateRobot(dt);
    checkRobotHit();
    updateEffects(dt);
    updateHUD();
  }

  /* ============================================================
   * 12. 渲染
   * ============================================================ */
  let lastBlink = 0;
  let blinkUntil = 0;

  function renderRadiation(t) {
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (MAP[y][x] !== 'R') continue;
        const px = x * TILE;
        const py = y * TILE;
        const a = 0.05 + 0.045 * Math.sin(t * 2 + x * 0.7 + y * 0.5);
        ctx.fillStyle = `rgba(160, 95, 255, ${a})`;
        ctx.fillRect(px, py, TILE, TILE);

        const sy = py + ((t * 22 + (x * 13 + y * 7) * 6) % TILE);
        const scan = ctx.createLinearGradient(px, sy, px, sy + 14);
        scan.addColorStop(0, 'rgba(210, 160, 255, 0)');
        scan.addColorStop(0.5, 'rgba(210, 160, 255, 0.22)');
        scan.addColorStop(1, 'rgba(210, 160, 255, 0)');
        ctx.fillStyle = scan;
        ctx.fillRect(px, sy, TILE, 14);
      }
    }
  }

  function render() {
    const t = G.t;
    if (!G.cat) return;

    ctx.save();
    if (G.shake > 0) {
      ctx.translate((Math.random() - 0.5) * G.shake, (Math.random() - 0.5) * G.shake);
    }

    ctx.drawImage(bgCanvas, 0, 0, W, H);
    renderRadiation(t);
    drawPatrolPath(ctx);

    G.crystals.forEach(cr => {
      if (cr.taken) return;
      const p = cellCenter(cr.x, cr.y);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ellipse(ctx, p.x, p.y + 13, 9, 3.4);
      drawCrystal(ctx, p.x, p.y - 2, t, cr.v, cr.phase);
    });

    drawRobot(ctx, G.robot.px, G.robot.py, t, G.robot.face);

    const cp = catPixel();
    const blink = t < blinkUntil;
    drawCat(ctx, cp.x, cp.y, t, G.cat.moving, G.cat.face, blink, G.invuln);
    if (G.shieldMs > 0) drawShield(ctx, cp.x, cp.y, t);

    renderEffects(ctx);

    if (G.hitFlash > 0) {
      const grad = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.82);
      grad.addColorStop(0, 'rgba(255, 90, 80, 0)');
      grad.addColorStop(1, `rgba(255, 80, 70, ${0.4 * G.hitFlash})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }

    if (G.radFlash > 0) {
      const grad = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.85);
      grad.addColorStop(0, 'rgba(170, 90, 255, 0)');
      grad.addColorStop(1, `rgba(160, 80, 255, ${0.42 * G.radFlash})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }

    // 快没时间：边缘红色呼吸
    if (G.state === 'playing' && G.timeLeft <= 10) {
      const a = 0.09 + 0.11 * (0.5 + 0.5 * Math.sin(t * 6));
      const grad = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.86);
      grad.addColorStop(0, 'rgba(255, 120, 90, 0)');
      grad.addColorStop(1, `rgba(255, 110, 80, ${a})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.restore();

    if (t - lastBlink > 3.2) {
      lastBlink = t;
      blinkUntil = t + 0.13;
    }
  }

  /* ============================================================
   * 13. 主循环
   * ============================================================ */
  let lastTs = performance.now();
  function frame(now) {
    const dt = Math.min(50, now - lastTs);
    lastTs = now;

    if (G.state === 'playing') {
      update(dt);
    } else {
      G.t += dt / 1000;
      updateEffects(dt);
      if (G.state === 'paused') {
        // 暂停时也让护盾剩余时间停住
      }
    }

    render();
    requestAnimationFrame(frame);
  }

  /* ============================================================
   * 14. 输入
   * ============================================================ */
  const KEYMAP = {
    ArrowUp: { x: 0, y: -1, code: 'U' },
    ArrowDown: { x: 0, y: 1, code: 'D' },
    ArrowLeft: { x: -1, y: 0, code: 'L' },
    ArrowRight: { x: 1, y: 0, code: 'R' },
    KeyW: { x: 0, y: -1, code: 'U' },
    KeyS: { x: 0, y: 1, code: 'D' },
    KeyA: { x: -1, y: 0, code: 'L' },
    KeyD: { x: 1, y: 0, code: 'R' }
  };

  document.addEventListener('keydown', e => {
    if (KEYMAP[e.code] && G.state === 'playing') {
      e.preventDefault();
      const d = KEYMAP[e.code];
      const held = G.input.held;
      if (!held.some(h => h.code === d.code)) held.push(d);
      G.input.tap = { x: d.x, y: d.y, until: performance.now() + 110 };
      return;
    }

    if (e.code === 'Space') {
      if (e.target.closest('button')) return;
      e.preventDefault();
      if (e.repeat) return;
      if (G.state === 'menu') startGame();
      else if (G.state === 'playing') activateShield();
      else if (G.state === 'won' || G.state === 'lost') startGame();
      else if (G.state === 'paused') resumeGame();
      return;
    }

    if (e.code === 'KeyR') {
      e.preventDefault();
      if (e.repeat) return;
      if (['playing', 'paused', 'won', 'lost'].includes(G.state)) startGame();
      return;
    }

    if (e.code === 'Escape') {
      e.preventDefault();
      if (e.repeat) return;
      if (G.state === 'playing') pauseGame();
      else if (G.state === 'paused') resumeGame();
      else if (G.state === 'won' || G.state === 'lost') showMenu();
    }
  });

  document.addEventListener('keyup', e => {
    if (!KEYMAP[e.code]) return;
    const d = KEYMAP[e.code];
    G.input.held = G.input.held.filter(h => h.code !== d.code);
  });

  window.addEventListener('blur', () => {
    G.input.held = [];
    G.input.tap = null;
  });

  /* ============================================================
   * 15. UI 绑定
   * ============================================================ */
  let toastTimer = null;
  function clearToast() {
    clearTimeout(toastTimer);
    el.toast.classList.remove('show');
  }
  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms || 2200);
  }

  function updateHUD() {
    const playingLike = G.state === 'playing' || G.state === 'paused' || G.state === 'won' || G.state === 'lost';
    el.hud.hidden = !playingLike;
    el.btnPause.hidden = G.state !== 'playing';
    el.btnShield.hidden = G.state !== 'playing';

    el.hudEnergy.max = GOAL;
    el.hudEnergy.value = Math.min(G.energy, GOAL);
    el.hudEnergyNum.textContent = Math.min(G.energy, GOAL);
    el.hudGoal.textContent = ` / ${GOAL}`;

    el.hudTime.textContent = Math.max(0, G.timeLeft).toFixed(1);
    el.pillTime.classList.toggle('warn', G.timeLeft <= 10 && G.state === 'playing');

    const shielded = G.shieldMs > 0;
    el.pillShield.classList.toggle('active', shielded);
    el.pillShield.classList.toggle('ready', !shielded && G.energy >= SHIELD_COST);
    el.btnShield.classList.toggle('active', shielded);
    el.btnShield.classList.toggle('ready', !shielded && G.energy >= SHIELD_COST);
    el.btnShield.disabled = shielded || G.energy < SHIELD_COST;

    if (shielded) {
      el.hudShield.textContent = `护盾 ${(G.shieldMs / 1000).toFixed(1)} 秒`;
      el.btnShield.textContent = '护盾中';
    } else if (G.energy >= SHIELD_COST) {
      el.hudShield.textContent = '护盾就绪';
      el.btnShield.textContent = `护盾 · ${SHIELD_COST}`;
    } else {
      el.hudShield.textContent = `护盾需 ${SHIELD_COST} 点`;
      el.btnShield.textContent = `护盾 · ${SHIELD_COST}`;
    }
  }

  el.btnStart.addEventListener('click', startGame);
  el.btnShield.addEventListener('click', activateShield);
  el.btnPause.addEventListener('click', pauseGame);
  el.btnResume.addEventListener('click', resumeGame);
  el.btnPauseRestart.addEventListener('click', startGame);
  el.btnRetry.addEventListener('click', startGame);
  el.btnSound.addEventListener('click', () => {
    Sfx.enabled = !Sfx.enabled;
    el.btnSound.textContent = Sfx.enabled ? '音效 开' : '音效 关';
    if (Sfx.enabled) Sfx.ensure();
  });

  // 触屏方向键
  const touchDirections = { up: [0, -1], left: [-1, 0], down: [0, 1], right: [1, 0] };
  document.querySelectorAll('[data-dir]').forEach(button => {
    const code = 'touch-' + button.dataset.dir;
    const [x, y] = touchDirections[button.dataset.dir];
    const release = () => {
      G.input.held = G.input.held.filter(h => h.code !== code);
      button.classList.remove('pressed');
    };
    button.addEventListener('pointerdown', event => {
      if (G.state !== 'playing') return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      G.input.held = G.input.held.filter(h => !String(h.code).startsWith('touch-'));
      G.input.held.push({ code, x, y });
      G.input.tap = { x, y, until: performance.now() + 110 };
      button.classList.add('pressed');
    });
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
  });

  /* ============================================================
   * 16. 调试接口 + 自检（?selftest=1）
   * ============================================================ */
  function snapshot() {
    return {
      state: G.state,
      energy: G.energy,
      shieldMs: Math.round(G.shieldMs),
      timeLeft: Math.round(G.timeLeft * 10) / 10,
      collected: G.crystals.filter(c => c.taken).length,
      left: G.crystals.filter(c => !c.taken).length,
      cat: { x: G.cat.x, y: G.cat.y },
      robot: { x: Math.round(G.robot.px / TILE), y: Math.round(G.robot.py / TILE) }
    };
  }

  function showSelfTest(rows, pass) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:99;background:#0b1022;color:#e8efff;' +
      'font:14px/1.7 ui-monospace,Consolas,monospace;padding:24px;overflow:auto;white-space:pre-wrap;';
    const title = pass ? 'SELFTEST PASS' : 'SELFTEST FAIL';
    box.textContent = title + '\n\n' + rows.join('\n');
    box.style.borderTop = pass ? '6px solid #86f0cc' : '6px solid #ff7b7b';
    document.body.appendChild(box);
    document.title = title;
  }

  function runSelfTest() {
    const rows = [];
    const ok = (name, cond) => rows.push((cond ? 'PASS  ' : 'FAIL  ') + name);

    startGame();
    G.energy = 0;
    G.shieldMs = 0;

    const blue = G.crystals.find(c => c.v === 1);
    G.cat.x = blue.x;
    G.cat.y = blue.y;
    ok('蓝晶可直接拾取并 +1', tryCollect(blue.x, blue.y) === true && G.energy === 1);

    const purple = G.crystals.find(c => c.v > 1);
    G.cat.x = purple.x;
    G.cat.y = purple.y;
    const denied = tryCollect(purple.x, purple.y);
    ok('无护盾时紫晶拿不到', denied === false && purple.taken === false);

    G.energy = SHIELD_COST;
    ok('开护盾扣 3 点晶能', activateShield() === true && G.energy === 0 && G.shieldMs > 0);
    ok('开盾后能拿紫晶并 +3', tryCollect(purple.x, purple.y) === true && G.energy === 3);

    G.shieldMs = 0;
    G.cat.x = 11;
    G.cat.y = 4;
    G.invuln = 5;
    const before = G.timeLeft;
    update(1000);
    ok('辐射区无护盾每秒多扣 2 秒', before - G.timeLeft > 2.6);

    G.energy = GOAL;
    checkWin();
    ok('晶能满 12 触发通关', G.state === 'won');

    const pass = rows.every(r => r.startsWith('PASS'));
    showSelfTest(rows, pass);
  }

  window.__starCat = {
    start: startGame,
    menu: showMenu,
    state: () => G.state,
    snap: snapshot,
    selfTest: runSelfTest,
    debug: {
      setCat(x, y) {
        G.cat.moving = false;
        G.cat.x = x;
        G.cat.y = y;
        G.cat.from = null;
        G.cat.to = null;
        G.cat.p = 0;
      },
      setEnergy(v) { G.energy = v; updateHUD(); },
      setTime(sec) { G.timeLeft = sec; updateHUD(); },
      collect: (x, y) => tryCollect(x, y),
      shield: activateShield,
      crystals: () => G.crystals.map(c => ({ x: c.x, y: c.y, v: c.v, taken: c.taken }))
    }
  };

  /* ============================================================
   * 17. 启动
   * ============================================================ */
  bgCanvas = buildBackground();
  setupWorld();
  G.lastTick = TIME_LIMIT;
  showMenu();
  requestAnimationFrame(frame);

  const params = new URLSearchParams(location.search);
  if (params.get('selftest') === '1') {
    setTimeout(runSelfTest, 120);
  }
})();
