/**
 * Snake Bot v1.0.0 — для мини-аппы (api-4-1.tg-app-data.buzz / snake-io)
 *
 * Режим: мирный фарм фруктов + защита. Атакует только если на тебя идут
 * и ты крупнее (или деваться некуда).
 *
 * Использование:
 * 1. Открой игру «Змейка» и зайди в матч (чтобы пошёл socket).
 * 2. Вставь этот скрипт в eruda / DevTools.
 * 3. Нажми START на панели (или __SNAKE_BOT__.start()).
 *
 * Управление: __SNAKE_BOT__.start() / .stop() / .status() / .set({...})
 */
(function () {
  "use strict";
  if (window.__SNAKE_BOT__ && window.__SNAKE_BOT__.version === "1.0.0") {
    console.log("[SnakeBot] already loaded");
    return;
  }

  var VERSION = "1.0.0";
  var TAG = "[SnakeBot]";
  var WORLD = 8000;
  var WALL_MARGIN = 280;

  var cfg = {
    enabled: false,
    peaceful: true,       // не охотиться без угрозы
    attackIfThreatened: true,
    preferFruit: true,
    avoidBombs: true,
    boostOnFlee: true,
    boostOnHunt: false,
    fruitWeight: 1.0,
    avoidWeight: 2.2,
    wallWeight: 3.0,
    huntWeight: 1.4,
    threatRange: 420,
    huntRange: 380,
    inputHz: 30,
    log: true,
  };

  var socket = null;
  var lastSnap = null;
  var timer = null;
  var running = false;
  var stats = { moves: 0, kills: 0, deaths: 0, fruitEaten: 0 };
  var lastAngle = 0;
  var lastError = "";

  function log() {
    var a = Array.prototype.slice.call(arguments);
    if (cfg.log) console.log.apply(console, [TAG].concat(a));
    uiLog(a.map(String).join(" "));
  }
  function warn() {
    var a = Array.prototype.slice.call(arguments);
    console.warn.apply(console, [TAG].concat(a));
    lastError = a.map(String).join(" ");
    uiLog("! " + lastError, true);
  }

  // ---------- socket capture ----------
  function tryCaptureSocket(s) {
    if (!s || s.__snakeBotHooked) return;
    // accept sockets that talk snake events
    var isSnake = false;
    try {
      var url = (s.io && s.io.uri) || (s.io && s.io._opts && s.io._opts.hostname) || "";
      if (String(url).indexOf("tg-app-data") >= 0 || String(url).indexOf("snake") >= 0) isSnake = true;
    } catch (e) {}
    s.__snakeBotHooked = true;
    var origOn = s.on.bind(s);
    var origEmit = s.emit.bind(s);
    s.on = function (ev, fn) {
      if (ev === "s" || ev === "death" || ev === "kill" || ev === "roster" || ev === "settled") {
        isSnake = true;
        socket = s;
      }
      if (ev === "s") {
        return origOn(ev, function (snap) {
          lastSnap = snap;
          try { fn && fn.apply(this, arguments); } catch (e) {}
        });
      }
      if (ev === "death") {
        return origOn(ev, function () {
          stats.deaths++;
          log("death");
          try { fn && fn.apply(this, arguments); } catch (e) {}
        });
      }
      if (ev === "kill") {
        return origOn(ev, function (data) {
          stats.kills++;
          log("kill +" + (data && data.reward));
          try { fn && fn.apply(this, arguments); } catch (e) {}
        });
      }
      return origOn(ev, fn);
    };
    s.emit = function (ev, payload) {
      if (ev === "join" || ev === "i") {
        isSnake = true;
        socket = s;
      }
      return origEmit.apply(this, arguments);
    };
    // also listen directly
    try {
      s.on("s", function (snap) { lastSnap = snap; socket = s; });
      s.on("death", function () { stats.deaths++; });
      s.on("kill", function (d) { stats.kills++; log("kill +" + (d && d.reward)); });
    } catch (e) {}
    if (isSnake) {
      socket = s;
      log("socket captured");
    }
  }

  function hookSocketIO() {
    // Patch Manager / lookup if present
    try {
      if (window.io && window.io.Manager) {
        var M = window.io.Manager;
        if (!M.__snakeBot) {
          M.__snakeBot = true;
          var origSock = M.prototype.socket;
          M.prototype.socket = function () {
            var s = origSock.apply(this, arguments);
            tryCaptureSocket(s);
            return s;
          };
        }
      }
    } catch (e) {}
    // Scan existing sockets on global io
    try {
      if (window.io && window.io.managers) {
        Object.keys(window.io.managers).forEach(function (k) {
          var mgr = window.io.managers[k];
          if (mgr && mgr.nsps) {
            Object.keys(mgr.nsps).forEach(function (n) {
              tryCaptureSocket(mgr.nsps[n]);
            });
          }
        });
      }
    } catch (e) {}
    // Fallback: wrap WebSocket constructor to detect snake-io
    try {
      if (!WebSocket.__snakeBot) {
        var OrigWS = WebSocket;
        WebSocket.__snakeBot = true;
        window.WebSocket = function (url, protocols) {
          var ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
          if (String(url).indexOf("snake-io") >= 0 || String(url).indexOf("snake") >= 0) {
            log("WS opened " + String(url).slice(0, 60));
          }
          return ws;
        };
        window.WebSocket.prototype = OrigWS.prototype;
        window.WebSocket.OPEN = OrigWS.OPEN;
        window.WebSocket.CLOSED = OrigWS.CLOSED;
        window.WebSocket.CONNECTING = OrigWS.CONNECTING;
        window.WebSocket.CLOSING = OrigWS.CLOSING;
      }
    } catch (e) {}
  }

  // Try to find socket already in memory via engine
  function findExistingSocket() {
    try {
      var keys = Object.keys(window);
      // socket.io caches managers often on io.managers
      if (window.io) {
        var mgrs = window.io.managers || window.io.Manager && window.io.Manager.managers;
        if (mgrs) {
          Object.keys(mgrs).forEach(function (k) {
            var m = mgrs[k];
            if (m && m.nsps) {
              Object.keys(m.nsps).forEach(function (n) {
                tryCaptureSocket(m.nsps[n]);
              });
            }
          });
        }
      }
    } catch (e) {}
  }

  // ---------- geometry helpers ----------
  function hypot(dx, dy) { return Math.sqrt(dx * dx + dy * dy); }
  function atan2(y, x) { return Math.atan2(y, x); }
  function normAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  function lerpAngle(a, b, t) {
    var d = normAngle(b - a);
    return a + d * t;
  }

  function parseBody(flat) {
    var pts = [];
    if (!flat || flat.length < 2) return pts;
    for (var i = 0; i + 1 < flat.length; i += 2) {
      pts.push({ x: flat[i], y: flat[i + 1] });
    }
    return pts;
  }

  function parseSnakes(snap) {
    var list = [];
    if (!snap || !snap.snakes) return list;
    for (var i = 0; i < snap.snakes.length; i++) {
      var s = snap.snakes[i];
      var body = parseBody(s.slice(4));
      list.push({
        runId: s[0],
        color: s[1],
        radius: s[2] || 10,
        body: body,
        head: body[0] || null,
        len: body.length,
      });
    }
    return list;
  }

  function parseFruit(snap) {
    var list = [];
    if (!snap || !snap.fruit) return list;
    for (var i = 0; i < snap.fruit.length; i++) {
      var f = snap.fruit[i];
      // [, type, x, y, r, flag]
      list.push({ type: f[1], x: f[2], y: f[3], r: f[4] || 8, flag: f[5] });
    }
    return list;
  }

  function parseBombs(snap) {
    var list = [];
    if (!snap || !snap.bombs) return list;
    for (var i = 0; i < snap.bombs.length; i++) {
      var b = snap.bombs[i];
      list.push({ x: b[1], y: b[2], flag: b[3] });
    }
    return list;
  }

  // ---------- AI ----------
  function computeSteer(snap) {
    if (!snap || !snap.me) return null;
    var me = snap.me;
    var mx = me.x, my = me.y;
    var myId = me.runId;
    var snakes = parseSnakes(snap);
    var fruits = parseFruit(snap);
    var bombs = parseBombs(snap);

    var meSnake = null;
    for (var i = 0; i < snakes.length; i++) {
      if (snakes[i].runId === myId) { meSnake = snakes[i]; break; }
    }
    var myR = meSnake ? meSnake.radius : 12;
    var myLen = meSnake ? meSnake.len : 5;

    // Desired velocity vector (steering)
    var vx = 0, vy = 0;
    var boost = false;
    var mode = "cruise";

    // 1) Wall avoidance
    var wallForce = 0;
    if (mx < WALL_MARGIN) { vx += (WALL_MARGIN - mx) / WALL_MARGIN * cfg.wallWeight; wallForce++; }
    if (mx > WORLD - WALL_MARGIN) { vx -= (mx - (WORLD - WALL_MARGIN)) / WALL_MARGIN * cfg.wallWeight; wallForce++; }
    if (my < WALL_MARGIN) { vy += (WALL_MARGIN - my) / WALL_MARGIN * cfg.wallWeight; wallForce++; }
    if (my > WORLD - WALL_MARGIN) { vy -= (my - (WORLD - WALL_MARGIN)) / WALL_MARGIN * cfg.wallWeight; wallForce++; }

    // 2) Avoid other snakes' bodies + detect threats
    var threat = null; // closest enemy head aiming at us
    for (var si = 0; si < snakes.length; si++) {
      var sn = snakes[si];
      if (sn.runId === myId) continue;
      if (!sn.head) continue;

      // body collision avoidance
      for (var bi = 0; bi < sn.body.length; bi += Math.max(1, Math.floor(sn.body.length / 12))) {
        var p = sn.body[bi];
        var dx = mx - p.x, dy = my - p.y;
        var d = hypot(dx, dy);
        var safe = myR + sn.radius + 40;
        if (d < safe * 3 && d > 1) {
          var w = cfg.avoidWeight * (safe * 3 - d) / (safe * 3);
          vx += (dx / d) * w;
          vy += (dy / d) * w;
        }
      }

      // head threat: enemy close and roughly facing us
      var hx = sn.head.x - mx, hy = sn.head.y - my;
      var hd = hypot(hx, hy);
      if (hd < cfg.threatRange && hd > 1) {
        // approximate enemy heading from first body segment
        var heading = 0;
        if (sn.body.length >= 2) {
          heading = atan2(sn.body[0].y - sn.body[1].y, sn.body[0].x - sn.body[1].x);
        }
        var toMe = atan2(-hy, -hx); // from enemy to me
        var align = Math.abs(normAngle(heading - toMe));
        if (align < 1.0) {
          if (!threat || hd < threat.d) threat = { sn: sn, d: hd, hx: hx, hy: hy };
        }
      }
    }

    // 3) Bomb avoidance
    if (cfg.avoidBombs) {
      for (var bi2 = 0; bi2 < bombs.length; bi2++) {
        var b = bombs[bi2];
        var dxb = mx - b.x, dyb = my - b.y;
        var db = hypot(dxb, dyb);
        if (db < 200 && db > 1) {
          vx += (dxb / db) * 2.5 * (200 - db) / 200;
          vy += (dyb / db) * 2.5 * (200 - db) / 200;
        }
      }
    }

    // 4) Threat response
    if (threat && cfg.attackIfThreatened) {
      var bigger = myLen > threat.sn.len * 1.15 || myR > threat.sn.radius * 1.1;
      if (bigger && !cfg.peaceful) {
        // counter-attack: head toward their body side
        mode = "counter";
        var tx = threat.sn.head.x, ty = threat.sn.head.y;
        var ddx = tx - mx, ddy = ty - my;
        var dd = hypot(ddx, ddy) || 1;
        vx += (ddx / dd) * cfg.huntWeight;
        vy += (ddy / dd) * cfg.huntWeight;
        boost = cfg.boostOnHunt;
      } else {
        // flee perpendicular / away
        mode = "flee";
        var fx = -threat.hx, fy = -threat.hy;
        var fd = hypot(fx, fy) || 1;
        vx += (fx / fd) * cfg.avoidWeight * 2;
        vy += (fy / fd) * cfg.avoidWeight * 2;
        // side-step
        vx += -fy / fd * 0.8;
        vy += fx / fd * 0.8;
        boost = cfg.boostOnFlee;
      }
    }

    // 5) Seek fruit (if not fleeing hard)
    if (cfg.preferFruit && mode !== "flee") {
      var best = null, bestScore = Infinity;
      for (var fi = 0; fi < fruits.length; fi++) {
        var fr = fruits[fi];
        var ddx2 = fr.x - mx, ddy2 = fr.y - my;
        var dist = hypot(ddx2, ddy2);
        // prefer closer, slightly prefer type 4 (special) if any
        var score = dist - (fr.type === 4 ? 80 : 0);
        // penalize fruit near walls
        if (fr.x < 150 || fr.x > WORLD - 150 || fr.y < 150 || fr.y > WORLD - 150) score += 120;
        // penalize fruit near enemies
        for (var sj = 0; sj < snakes.length; sj++) {
          if (snakes[sj].runId === myId || !snakes[sj].head) continue;
          var ed = hypot(fr.x - snakes[sj].head.x, fr.y - snakes[sj].head.y);
          if (ed < 180) score += 200;
        }
        if (score < bestScore) {
          bestScore = score;
          best = fr;
        }
      }
      if (best) {
        if (mode === "cruise") mode = "farm";
        var ddfx = best.x - mx, ddfy = best.y - my;
        var dfd = hypot(ddfx, ddfy) || 1;
        vx += (ddfx / dfd) * cfg.fruitWeight;
        vy += (ddfy / dfd) * cfg.fruitWeight;
      }
    }

    // 6) Optional opportunistic hunt (disabled if peaceful)
    if (!cfg.peaceful && mode === "farm") {
      var prey = null;
      for (var sk = 0; sk < snakes.length; sk++) {
        var en = snakes[sk];
        if (en.runId === myId || !en.head) continue;
        if (en.len >= myLen * 0.9) continue;
        var pd = hypot(en.head.x - mx, en.head.y - my);
        if (pd < cfg.huntRange && (!prey || pd < prey.d)) prey = { en: en, d: pd };
      }
      if (prey) {
        mode = "hunt";
        var px = prey.en.head.x - mx, py = prey.en.head.y - my;
        var pp = hypot(px, py) || 1;
        vx += (px / pp) * cfg.huntWeight;
        vy += (py / pp) * cfg.huntWeight;
        boost = cfg.boostOnHunt && prey.d < 200;
      }
    }

    if (vx === 0 && vy === 0) {
      // keep previous heading
      return { angle: lastAngle, boost: false, mode: "idle" };
    }
    var angle = atan2(vy, vx);
    // smooth
    angle = lerpAngle(lastAngle, angle, 0.35);
    lastAngle = angle;
    return { angle: angle, boost: boost, mode: mode };
  }

  function tick() {
    if (!cfg.enabled || !running) return;
    if (!socket || !socket.connected) {
      findExistingSocket();
      if (!socket) {
        uiStatus("нет socket — зайди в матч");
        return;
      }
    }
    if (!lastSnap) {
      uiStatus("ждём snapshot…");
      return;
    }
    var decision = computeSteer(lastSnap);
    if (!decision) return;
    try {
      socket.emit("i", { angle: decision.angle, boost: !!decision.boost });
      stats.moves++;
      uiStatus(decision.mode + (decision.boost ? " ⚡" : "") + " · m=" + stats.moves);
    } catch (e) {
      warn("emit: " + e);
    }
  }

  // ---------- UI ----------
  var panel, logEl, statusEl;
  function ensureUI() {
    if (panel && document.body.contains(panel)) return;
    panel = document.createElement("div");
    panel.id = "snake-bot-panel";
    panel.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px">SnakeBot ' + VERSION + "</div>" +
      '<div id="snake-bot-status" style="font-size:11px;opacity:.9;margin-bottom:8px">idle</div>' +
      '<div style="display:flex;gap:6px;margin-bottom:6px">' +
      '<button id="snake-bot-start" style="flex:1;padding:6px;border:0;border-radius:8px;background:#2a8;color:#fff;font-weight:700">START</button>' +
      '<button id="snake-bot-stop" style="flex:1;padding:6px;border:0;border-radius:8px;background:#844;color:#fff;font-weight:700">STOP</button>' +
      "</div>" +
      '<label style="font-size:11px;display:flex;gap:6px;align-items:center;margin-bottom:6px">' +
      '<input id="snake-bot-peaceful" type="checkbox" checked/> мирный</label>' +
      '<div id="snake-bot-log" style="font-size:10px;max-height:110px;overflow:auto;line-height:1.35;opacity:.85"></div>';
    panel.style.cssText =
      "position:fixed;right:8px;bottom:90px;z-index:2147483646;width:190px;padding:10px;" +
      "border-radius:12px;background:rgba(12,18,28,.93);color:#d0e4ff;" +
      "font:12px/1.3 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);border:1px solid #3a5570;";
    document.body.appendChild(panel);
    logEl = panel.querySelector("#snake-bot-log");
    statusEl = panel.querySelector("#snake-bot-status");
    panel.querySelector("#snake-bot-start").onclick = function () { api.start(); };
    panel.querySelector("#snake-bot-stop").onclick = function () { api.stop(); };
    panel.querySelector("#snake-bot-peaceful").onchange = function (e) {
      cfg.peaceful = !!e.target.checked;
      log("peaceful=" + cfg.peaceful);
    };
  }
  function uiLog(msg, isErr) {
    ensureUI();
    if (!logEl) return;
    var line = document.createElement("div");
    line.textContent = msg;
    if (isErr) line.style.color = "#f99";
    logEl.insertBefore(line, logEl.firstChild);
    while (logEl.children.length > 35) logEl.removeChild(logEl.lastChild);
  }
  function uiStatus(t) {
    ensureUI();
    if (statusEl) statusEl.textContent = t;
  }

  // ---------- public API ----------
  var api = {
    version: VERSION,
    cfg: cfg,
    start: function () {
      ensureUI();
      hookSocketIO();
      findExistingSocket();
      cfg.enabled = true;
      running = true;
      if (timer) clearInterval(timer);
      timer = setInterval(tick, Math.max(20, 1000 / cfg.inputHz));
      log("START v" + VERSION);
      uiStatus("running");
      return "started";
    },
    stop: function () {
      cfg.enabled = false;
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
      log("STOP");
      uiStatus("stopped");
      return "stopped";
    },
    status: function () {
      return {
        version: VERSION,
        enabled: cfg.enabled,
        hasSocket: !!(socket && socket.connected),
        hasSnap: !!lastSnap,
        me: lastSnap && lastSnap.me ? { x: lastSnap.me.x, y: lastSnap.me.y, runId: lastSnap.me.runId } : null,
        stats: stats,
        peaceful: cfg.peaceful,
        lastError: lastError,
      };
    },
    set: function (opts) {
      Object.assign(cfg, opts || {});
      return cfg;
    },
    // manual inject of socket if needed
    attachSocket: function (s) {
      tryCaptureSocket(s);
      socket = s;
      return !!socket;
    },
  };

  window.__SNAKE_BOT__ = api;
  hookSocketIO();
  ensureUI();
  uiStatus("ready — зайди в матч и START");
  console.log("%c" + TAG + " v" + VERSION + " ready", "color:#6af;font-weight:bold");
})();
