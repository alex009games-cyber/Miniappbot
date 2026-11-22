/**
 * SnakeBot v1.1.0
 * Работает БЕЗ перехвата socket: читает snapshot из React fiber,
 * рулит через mousemove/mousedown на canvas (как палец игрока).
 *
 * 1. Зайди в матч змейки
 * 2. Вставь скрипт в eruda
 * 3. START
 *
 * __SNAKE_BOT__.start() / .stop() / .status()
 */
(function () {
  "use strict";
  if (window.__SNAKE_BOT__ && window.__SNAKE_BOT__.version === "1.1.0") {
    console.log("[SnakeBot] already v1.1.0");
    return;
  }

  var VERSION = "1.1.0";
  var TAG = "[SnakeBot]";
  var WORLD = 8000;
  var WALL_MARGIN = 300;

  var cfg = {
    enabled: false,
    peaceful: true,
    attackIfThreatened: true,
    avoidBombs: true,
    boostOnFlee: true,
    boostOnHunt: false,
    fruitWeight: 1.15,
    avoidWeight: 2.4,
    wallWeight: 3.2,
    huntWeight: 1.3,
    threatRange: 450,
    huntRange: 360,
    tickMs: 50,
    log: true,
  };

  var running = false;
  var timer = null;
  var lastAngle = 0;
  var lastSnap = null;
  var canvas = null;
  var socket = null;
  var stats = { ticks: 0, boosts: 0 };
  var lastError = "";
  var lastMode = "idle";

  function log() {
    var a = Array.prototype.slice.call(arguments);
    if (cfg.log) console.log.apply(console, [TAG].concat(a));
    uiLog(a.map(String).join(" "));
  }
  function warn(m) {
    lastError = String(m);
    console.warn(TAG, m);
    uiLog("! " + m, true);
  }

  function hypot(a, b) { return Math.sqrt(a * a + b * b); }
  function normAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  function lerpAngle(a, b, t) {
    return a + normAngle(b - a) * t;
  }

  // ---------- find canvas ----------
  function findCanvas() {
    if (canvas && document.body.contains(canvas)) return canvas;
    var list = document.querySelectorAll("canvas");
    var best = null, bestArea = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var a = c.clientWidth * c.clientHeight;
      if (a > bestArea) { bestArea = a; best = c; }
    }
    canvas = best;
    return canvas;
  }

  // ---------- React fiber: extract snapshot ----------
  function getFiber(dom) {
    if (!dom) return null;
    var keys = Object.keys(dom);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf("__reactFiber") === 0 || k.indexOf("__reactInternalInstance") === 0) {
        return dom[k];
      }
    }
    return null;
  }

  function walkFiber(fiber, maxNodes) {
    var queue = [fiber];
    var seen = 0;
    while (queue.length && seen < maxNodes) {
      var f = queue.shift();
      seen++;
      if (!f) continue;
      try {
        var p = f.memoizedProps || f.pendingProps;
        if (p && p.snapshot && p.snapshot.me && typeof p.snapshot.me.x === "number") {
          return p.snapshot;
        }
        // store from useSnakeStore sometimes on hooks
        if (f.memoizedState) {
          var s = f.memoizedState;
          var guard = 0;
          while (s && guard++ < 30) {
            var mq = s.memoizedState;
            if (mq && mq.snapshot && mq.snapshot.me) return mq.snapshot;
            if (mq && mq.phase && mq.snapshot) return mq.snapshot;
            s = s.next;
          }
        }
      } catch (e) {}
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
    }
    return null;
  }

  function readSnapshot() {
    var c = findCanvas();
    if (!c) return lastSnap;
    // walk up DOM to find react roots with snapshot
    var el = c;
    for (var depth = 0; depth < 12 && el; depth++) {
      var fiber = getFiber(el);
      if (fiber) {
        var snap = walkFiber(fiber, 800);
        if (snap) {
          lastSnap = snap;
          return snap;
        }
      }
      el = el.parentElement;
    }
    // try #root
    var root = document.getElementById("root") || document.body;
    var rf = getFiber(root);
    if (rf) {
      var snap2 = walkFiber(rf, 2500);
      if (snap2) {
        lastSnap = snap2;
        return snap2;
      }
    }
    return lastSnap;
  }

  // ---------- socket optional (direct emit) ----------
  function tryFindSocket() {
    if (socket && socket.connected) return socket;
    function check(o) {
      if (!o || typeof o !== "object") return null;
      try {
        if (typeof o.emit === "function" && typeof o.on === "function" && o.io && (o.connected === true || o.connected === false)) {
          return o;
        }
      } catch (e) {}
      return null;
    }
    try {
      if (window.io && window.io.managers) {
        var mgrs = window.io.managers;
        for (var k in mgrs) {
          var m = mgrs[k];
          if (m && m.nsps) {
            for (var n in m.nsps) {
              var s = check(m.nsps[n]);
              if (s) { socket = s; return s; }
            }
          }
        }
      }
    } catch (e) {}
    // scan webpack chunk modules lightly
    try {
      var cache = window.__webpack_require__ && window.__webpack_require__.c;
      if (cache) {
        var ids = Object.keys(cache).slice(0, 400);
        for (var i = 0; i < ids.length; i++) {
          var exp = cache[ids[i]] && cache[ids[i]].exports;
          if (!exp) continue;
          var s2 = check(exp) || check(exp.default) || check(exp.socket);
          if (s2) { socket = s2; return s2; }
        }
      }
    } catch (e) {}
    return socket;
  }

  // ---------- parse game state ----------
  function parseBody(flat) {
    var pts = [];
    if (!flat) return pts;
    for (var i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
    return pts;
  }
  function parseSnakes(snap) {
    var list = [];
    if (!snap || !snap.snakes) return list;
    for (var i = 0; i < snap.snakes.length; i++) {
      var s = snap.snakes[i];
      var body = parseBody(s.slice(4));
      list.push({
        runId: s[0], color: s[1], radius: s[2] || 10,
        body: body, head: body[0] || null, len: body.length
      });
    }
    return list;
  }
  function parseFruit(snap) {
    var list = [];
    if (!snap || !snap.fruit) return list;
    for (var i = 0; i < snap.fruit.length; i++) {
      var f = snap.fruit[i];
      list.push({ type: f[1], x: f[2], y: f[3], r: f[4] || 8 });
    }
    return list;
  }
  function parseBombs(snap) {
    var list = [];
    if (!snap || !snap.bombs) return list;
    for (var i = 0; i < snap.bombs.length; i++) {
      var b = snap.bombs[i];
      list.push({ x: b[1], y: b[2] });
    }
    return list;
  }

  // ---------- AI ----------
  function computeSteer(snap) {
    if (!snap || !snap.me) return null;
    var mx = snap.me.x, my = snap.me.y, myId = snap.me.runId;
    var snakes = parseSnakes(snap);
    var fruits = parseFruit(snap);
    var bombs = parseBombs(snap);
    var meSnake = null;
    for (var i = 0; i < snakes.length; i++) if (snakes[i].runId === myId) meSnake = snakes[i];
    var myR = meSnake ? meSnake.radius : 12;
    var myLen = meSnake ? meSnake.len : 5;

    var vx = 0, vy = 0, boost = false, mode = "cruise";

    // walls
    if (mx < WALL_MARGIN) vx += ((WALL_MARGIN - mx) / WALL_MARGIN) * cfg.wallWeight;
    if (mx > WORLD - WALL_MARGIN) vx -= ((mx - (WORLD - WALL_MARGIN)) / WALL_MARGIN) * cfg.wallWeight;
    if (my < WALL_MARGIN) vy += ((WALL_MARGIN - my) / WALL_MARGIN) * cfg.wallWeight;
    if (my > WORLD - WALL_MARGIN) vy -= ((my - (WORLD - WALL_MARGIN)) / WALL_MARGIN) * cfg.wallWeight;

    var threat = null;
    for (var si = 0; si < snakes.length; si++) {
      var sn = snakes[si];
      if (sn.runId === myId || !sn.head) continue;
      var step = Math.max(1, Math.floor(sn.body.length / 14));
      for (var bi = 0; bi < sn.body.length; bi += step) {
        var p = sn.body[bi];
        var dx = mx - p.x, dy = my - p.y, d = hypot(dx, dy);
        var safe = myR + sn.radius + 50;
        if (d < safe * 3.2 && d > 1) {
          var w = cfg.avoidWeight * (safe * 3.2 - d) / (safe * 3.2);
          vx += (dx / d) * w;
          vy += (dy / d) * w;
        }
      }
      var hx = sn.head.x - mx, hy = sn.head.y - my, hd = hypot(hx, hy);
      if (hd < cfg.threatRange && hd > 1 && sn.body.length >= 2) {
        var heading = Math.atan2(sn.body[0].y - sn.body[1].y, sn.body[0].x - sn.body[1].x);
        var toMe = Math.atan2(-hy, -hx);
        if (Math.abs(normAngle(heading - toMe)) < 1.05) {
          if (!threat || hd < threat.d) threat = { sn: sn, d: hd, hx: hx, hy: hy };
        }
      }
    }

    if (cfg.avoidBombs) {
      for (var bi2 = 0; bi2 < bombs.length; bi2++) {
        var b = bombs[bi2];
        var dxb = mx - b.x, dyb = my - b.y, db = hypot(dxb, dyb);
        if (db < 220 && db > 1) {
          vx += (dxb / db) * 2.6 * (220 - db) / 220;
          vy += (dyb / db) * 2.6 * (220 - db) / 220;
        }
      }
    }

    if (threat && cfg.attackIfThreatened) {
      var bigger = myLen > threat.sn.len * 1.15;
      if (bigger && !cfg.peaceful) {
        mode = "counter";
        var ddx = threat.sn.head.x - mx, ddy = threat.sn.head.y - my, dd = hypot(ddx, ddy) || 1;
        vx += (ddx / dd) * cfg.huntWeight;
        vy += (ddy / dd) * cfg.huntWeight;
        boost = cfg.boostOnHunt;
      } else {
        mode = "flee";
        var fx = -threat.hx, fy = -threat.hy, fd = hypot(fx, fy) || 1;
        vx += (fx / fd) * cfg.avoidWeight * 2.2;
        vy += (fy / fd) * cfg.avoidWeight * 2.2;
        vx += (-fy / fd) * 0.9;
        vy += (fx / fd) * 0.9;
        boost = cfg.boostOnFlee;
      }
    }

    if (mode !== "flee") {
      var best = null, bestScore = Infinity;
      for (var fi = 0; fi < fruits.length; fi++) {
        var fr = fruits[fi];
        var dist = hypot(fr.x - mx, fr.y - my);
        var score = dist - (fr.type === 4 ? 90 : 0);
        if (fr.x < 160 || fr.x > WORLD - 160 || fr.y < 160 || fr.y > WORLD - 160) score += 140;
        for (var sj = 0; sj < snakes.length; sj++) {
          if (snakes[sj].runId === myId || !snakes[sj].head) continue;
          if (hypot(fr.x - snakes[sj].head.x, fr.y - snakes[sj].head.y) < 200) score += 220;
        }
        if (score < bestScore) { bestScore = score; best = fr; }
      }
      if (best) {
        if (mode === "cruise") mode = "farm";
        var ddfx = best.x - mx, ddfy = best.y - my, dfd = hypot(ddfx, ddfy) || 1;
        vx += (ddfx / dfd) * cfg.fruitWeight;
        vy += (ddfy / dfd) * cfg.fruitWeight;
      }
    }

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
        var px = prey.en.head.x - mx, py = prey.en.head.y - my, pp = hypot(px, py) || 1;
        vx += (px / pp) * cfg.huntWeight;
        vy += (py / pp) * cfg.huntWeight;
        boost = cfg.boostOnHunt && prey.d < 220;
      }
    }

    if (vx === 0 && vy === 0) return { angle: lastAngle, boost: false, mode: "idle" };
    var angle = lerpAngle(lastAngle, Math.atan2(vy, vx), 0.4);
    lastAngle = angle;
    return { angle: angle, boost: boost, mode: mode };
  }

  // ---------- inject input via canvas pointer ----------
  function applyInput(angle, boost) {
    var c = findCanvas();
    if (!c) return false;
    var rect = c.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    // point far enough from center in desired direction
    var dist = Math.min(rect.width, rect.height) * 0.35;
    var x = cx + Math.cos(angle) * dist;
    var y = cy + Math.sin(angle) * dist;

    // Prefer direct socket if we have it
    var s = tryFindSocket();
    if (s && s.connected) {
      try {
        s.emit("i", { angle: angle, boost: !!boost });
        return true;
      } catch (e) {}
    }

    try {
      var move = new MouseEvent("mousemove", {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y
      });
      c.dispatchEvent(move);
      if (boost) {
        c.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y
        }));
        stats.boosts++;
      } else {
        window.dispatchEvent(new MouseEvent("mouseup", {
          bubbles: true, cancelable: true, view: window, button: 0
        }));
      }
      return true;
    } catch (e) {
      warn("input: " + e);
      return false;
    }
  }

  function tick() {
    if (!running || !cfg.enabled) return;
    var snap = readSnapshot();
    if (!snap || !snap.me) {
      uiStatus("нет snapshot — открой матч");
      return;
    }
    var decision = computeSteer(snap);
    if (!decision) return;
    lastMode = decision.mode;
    applyInput(decision.angle, decision.boost);
    stats.ticks++;
    if (stats.ticks % 10 === 0) {
      uiStatus(decision.mode + (decision.boost ? " ⚡" : "") + " · t=" + stats.ticks);
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
      '<div id="sb-status" style="font-size:11px;opacity:.9;margin-bottom:8px">idle</div>' +
      '<div style="display:flex;gap:6px;margin-bottom:6px">' +
      '<button id="sb-start" style="flex:1;padding:6px;border:0;border-radius:8px;background:#2a8;color:#fff;font-weight:700">START</button>' +
      '<button id="sb-stop" style="flex:1;padding:6px;border:0;border-radius:8px;background:#844;color:#fff;font-weight:700">STOP</button></div>' +
      '<label style="font-size:11px;display:flex;gap:6px;align-items:center;margin-bottom:6px">' +
      '<input id="sb-peaceful" type="checkbox" checked/> мирный</label>' +
      '<div id="sb-log" style="font-size:10px;max-height:110px;overflow:auto;line-height:1.35;opacity:.85"></div>';
    panel.style.cssText =
      "position:fixed;right:8px;bottom:100px;z-index:2147483646;width:190px;padding:10px;" +
      "border-radius:12px;background:rgba(12,18,28,.93);color:#d0e4ff;" +
      "font:12px/1.3 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);border:1px solid #3a5570;";
    document.body.appendChild(panel);
    logEl = panel.querySelector("#sb-log");
    statusEl = panel.querySelector("#sb-status");
    panel.querySelector("#sb-start").onclick = function () { api.start(); };
    panel.querySelector("#sb-stop").onclick = function () { api.stop(); };
    panel.querySelector("#sb-peaceful").onchange = function (e) {
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
    while (logEl.children.length > 30) logEl.removeChild(logEl.lastChild);
  }
  function uiStatus(t) {
    ensureUI();
    if (statusEl) statusEl.textContent = t;
  }

  var api = {
    version: VERSION,
    cfg: cfg,
    start: function () {
      ensureUI();
      cfg.enabled = true;
      running = true;
      findCanvas();
      tryFindSocket();
      if (timer) clearInterval(timer);
      timer = setInterval(tick, cfg.tickMs);
      log("START v" + VERSION);
      // immediate tick
      tick();
      return "started";
    },
    stop: function () {
      cfg.enabled = false;
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
      try {
        window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
      } catch (e) {}
      log("STOP");
      uiStatus("stopped");
      return "stopped";
    },
    status: function () {
      var snap = readSnapshot();
      return {
        version: VERSION,
        enabled: cfg.enabled,
        hasCanvas: !!findCanvas(),
        hasSnap: !!(snap && snap.me),
        hasSocket: !!(socket && socket.connected),
        me: snap && snap.me ? { x: snap.me.x, y: snap.me.y, runId: snap.me.runId } : null,
        mode: lastMode,
        stats: stats,
        lastError: lastError,
      };
    },
    set: function (o) { Object.assign(cfg, o || {}); return cfg; },
  };

  window.__SNAKE_BOT__ = api;
  ensureUI();
  uiStatus("ready — матч + START");
  console.log("%c" + TAG + " v" + VERSION + " ready", "color:#6af;font-weight:bold");
})();
