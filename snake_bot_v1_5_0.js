/**
 * SnakeBot v1.5.0
 * Читает snapshot из React fiber, рулит через mousemove/mousedown на canvas
 * (ровно так, как игра читает ввод сама — проверено по исходнику игры).
 *
 * v1.5.0: встроен помощник «Смотри рекламу» (из FaroAds v1.0)
 *  - работает как ручное нажатие: единственное действие — click() по кнопке
 *    «Watch ad» в самом приложении, когда она доступна. Ничего не отправляет
 *    на сервер, не подделывает просмотры, не пропускает, не закрывает и не
 *    глушит рекламу — приложение само ждёт конец показа и само засчитывает его
 *  - стоит, если приложение свёрнуто; останавливается на N/N или если реклама
 *    несколько раз подряд не засчиталась; держит экран включённым (wake lock)
 *  - отдельная кнопка в панели; не мешает игровому боту: __SNAKE_BOT__.ads.start()
 *
 * v1.4.0:
 *  - авто-калибровка радиуса поворота: бот сам меряет скорость и скорость
 *    поворота змеи по snapshot и считает turnRadius (ручное значение — запасное)
 *  - слой безопасности: 25 «лучей» вокруг желаемого курса, выбирается
 *    ближайшее направление без столкновения с телами, предсказанными головами,
 *    бомбами и стеной (вместо простой суммы векторов)
 *  - пауза игры (paused) уважается, настройки сохраняются между запусками
 *
 * v1.3.0: подогнан под реальный код игры
 *  - цвета фруктов: type%5 → 0 синий, 1 ЗЕЛЁНЫЙ, 2 ЖЁЛТЫЙ, 3 оранжевый, 4 розовый
 *    (теперь переключатели по цветам, а не по номерам типов)
 *  - бомба = [id, x, y, detected]: 4-е поле — флаг, а не радиус (радиус рисуется 12)
 *  - фрукты с флагом 0 игра рисует тусклыми — им штраф
 *  - поиск snapshot сразу по цепочке fiber.return от canvas (компонент SnakeCanvas)
 *  - предпочитает крупные фрукты и скопления
 * Что нового по сравнению с 1.1.0:
 *  - не крутится вокруг одной монеты (учёт радиуса поворота, залипание цели,
 *    чёрный список «недоступных» фруктов, детектор кругов с выходом по прямой)
 *  - не зависает (кэш fiber вместо обхода дерева каждый тик, поиск socket
 *    больше не сканирует webpack 20 раз в секунду, детектор «замёрзшего» snapshot,
 *    mousedown/mouseup шлются только при смене состояния)
 *  - не шарахается от красных кружков (бомб) и красной стены заранее:
 *    реакция только вблизи, с учётом направления движения
 *  - переключатели по типам фруктов (у каждого типа — свой чекбокс и метка цвета)
 *
 * 1. Зайди в матч  2. Вставь скрипт в eruda  3. START
 * __SNAKE_BOT__.start() / .stop() / .status() / .types() / .set({...})
 */
(function () {
  "use strict";
  var VERSION = "1.5.0";
  var TAG = "[SnakeBot]";

  // обновление со старой версии
  try { if (window.__FARO_ADS__) window.__FARO_ADS__.stop(); } catch (e) {}   // отдельный FaroAds теперь внутри
  try { var oldPill = document.getElementById("faro-ads-pill"); if (oldPill) oldPill.remove(); } catch (e) {}
  if (window.__SNAKE_BOT__) {
    try { window.__SNAKE_BOT__.stop(); } catch (e) {}
    try { if (window.__SNAKE_BOT__.dispose) window.__SNAKE_BOT__.dispose(); } catch (e) {}
    var oldPanel = document.getElementById("snake-bot-panel");
    if (oldPanel && oldPanel.parentNode) oldPanel.parentNode.removeChild(oldPanel);
  }

  var WORLD = 8000;

  var cfg = {
    enabled: false,
    peaceful: true,
    attackIfThreatened: true,
    avoidBombs: true,
    boostOnFlee: true,
    boostOnHunt: false,
    useSocket: false,        // по умолчанию только мышь
    fruitWeight: 1.15,
    avoidWeight: 2.0,
    wallWeight: 3.0,
    huntWeight: 1.3,
    threatRange: 380,
    huntRange: 360,
    wallMargin: 110,         // было 300 — отсюда ранний отлёт от стены
    bombMargin: 45,          // запас сверх радиуса бомбы (было ~220 всего)
    bombR: 12,               // радиус бомбы (так её рисует игра)
    dimPenalty: 150,         // штраф фруктам с флагом != 1 (игра рисует их тусклыми)
    sizeBonus: 5,            // бонус за радиус фрукта
    clusterBonus: 10,        // бонус за каждого соседа в радиусе 160 (макс. 5)
    bodyMargin: 45,
    turnRadius: 95,          // запасной радиус поворота, если авто-калибровка ещё не готова
    autoTurn: true,          // сам измерять радиус поворота
    rays: true,              // слой безопасности по лучам
    rayAhead: 2.2,           // длина луча = turnRadius * rayAhead + 60
    rayMargin: 18,           // запас от препятствия сверх радиусов
    targetStickiness: 0.8,   // новая цель должна быть заметно лучше текущей
    noProgressMs: 2000,      // нет сближения с целью столько — в чёрный список
    blacklistMs: 5000,
    tickMs: 50,
    log: true
  };

  var running = false;
  var timer = null;
  var lastAngle = 0;
  var lastSnap = null;
  var canvas = null;
  var socket = null;
  var lastSocketScan = 0;
  var stats = { ticks: 0, boosts: 0, rescans: 0, circles: 0, blacklisted: 0 };
  var lastError = "";
  var lastMode = "idle";
  var boostDown = false;
  var holder = null;          // fiber, где лежит snapshot (кэш)
  var lastScan = 0;
  var lastMe = null;
  var stallTicks = 0;
  var lastT = null;
  var lastBoost = false;
  var target = null;
  var blk = {};               // чёрный список фруктов: key -> время окончания
  var hist = [];              // история позиций для детектора кругов
  var escapeUntil = 0;
  var wanderPhase = 0;
  var loggedFruitSample = false;

  // ---------- настройки по типам фруктов ----------
  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  // Палитра из кода игры: FRUIT_COLORS[type % 5]
  var GROUPS = [
    { icon: "🔵", name: "синие" },
    { icon: "🟢", name: "зелёные" },
    { icon: "🟡", name: "жёлтые" },
    { icon: "🟠", name: "оранжевые" },
    { icon: "🌸", name: "розовые (бонус)" }
  ];
  var groupOn = lsGet("sb_group_on", {});   // группа 0..4 -> true/false
  var groupSeen = {};                       // группа -> {n, dim}
  function grp(t) { return Math.abs(t) % 5; }
  function isTypeOn(t) { return groupOn[grp(t)] !== false; }

  var PERSIST = ["peaceful", "avoidBombs", "boostOnFlee", "autoTurn"];
  (function () {
    var saved = lsGet("sb_cfg", {});
    PERSIST.forEach(function (k) { if (typeof saved[k] === "boolean") cfg[k] = saved[k]; });
  })();
  function saveCfg() {
    var o = {};
    PERSIST.forEach(function (k) { o[k] = cfg[k]; });
    lsSet("sb_cfg", o);
  }

  // ---------- авто-калибровка радиуса поворота ----------
  // R = скорость / угловая скорость. Меряем по snapshot (время snap.t, мс),
  // только без ускорения и только когда команда просит крутой поворот.
  var cal = { snapT: null, h: 0, x: 0, y: 0, cmd: 0, boost: false, speeds: [], omegas: [], R: null };
  function pctl(arr, p) {
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[Math.min(a.length - 1, Math.floor(a.length * p))];
  }
  function calibrate(snapT, x, y, h) {
    if (typeof snapT !== "number") return;
    var c = cal;
    if (snapT === c.snapT) return;
    if (c.snapT !== null) {
      var dt = (snapT - c.snapT) / 1000;
      if (dt > 0.01 && dt < 0.3 && !c.boost) {
        var dist = hypot(x - c.x, y - c.y);
        if (dist > 0.3 && dist < 300) { c.speeds.push(dist / dt); if (c.speeds.length > 60) c.speeds.shift(); }
        if (Math.abs(normAngle(c.cmd - c.h)) > 1.0) {
          var om = Math.abs(normAngle(h - c.h)) / dt;
          if (om > 0.2 && om < 15) { c.omegas.push(om); if (c.omegas.length > 60) c.omegas.shift(); }
        }
      }
    }
    c.snapT = snapT; c.h = h; c.x = x; c.y = y; c.cmd = lastAngle; c.boost = lastBoost;
    if (c.speeds.length >= 20 && c.omegas.length >= 15) {
      var r = pctl(c.speeds, 0.5) / pctl(c.omegas, 0.8);
      r = Math.max(40, Math.min(260, r));
      c.R = c.R === null ? r : c.R * 0.9 + r * 0.1;
    }
  }

  // ---------- слой безопасности: лучи ----------
  function pickSafeAngle(desired, mx, my, myR, heading, snakes, bombs, myId, TR) {
    var L = TR * cfg.rayAhead + 60, reach = L + 120;
    var obs = [];   // плоский массив троек x, y, r
    for (var i = 0; i < snakes.length; i++) {
      var sn = snakes[i];
      if (sn.runId === myId || !sn.head) continue;
      for (var j = 0; j < sn.body.length && obs.length < 2700; j++) {
        var p = sn.body[j];
        if (Math.abs(p.x - mx) < reach && Math.abs(p.y - my) < reach) obs.push(p.x, p.y, sn.radius);
      }
      if (sn.body.length >= 2) {
        // где окажется голова противника через долю секунды
        var eh = Math.atan2(sn.body[0].y - sn.body[1].y, sn.body[0].x - sn.body[1].x), fl = sn.radius * 5;
        obs.push(sn.head.x + Math.cos(eh) * fl, sn.head.y + Math.sin(eh) * fl, sn.radius * 1.2);
      }
    }
    if (cfg.avoidBombs) for (var bi = 0; bi < bombs.length; bi++) obs.push(bombs[bi].x, bombs[bi].y, bombs[bi].r + 6);

    var wallSafe = myR + 35;
    function clear(a) {
      var ux = Math.cos(a), uy = Math.sin(a), t = L;
      if (ux > 1e-6) t = Math.min(t, Math.max(0, (WORLD - wallSafe - mx) / ux));
      else if (ux < -1e-6) t = Math.min(t, Math.max(0, (wallSafe - mx) / ux));
      if (uy > 1e-6) t = Math.min(t, Math.max(0, (WORLD - wallSafe - my) / uy));
      else if (uy < -1e-6) t = Math.min(t, Math.max(0, (wallSafe - my) / uy));
      for (var k = 0; k < obs.length; k += 3) {
        var dx = obs[k] - mx, dy = obs[k + 1] - my;
        var along = dx * ux + dy * uy;
        if (along < -obs[k + 2] || along > t) continue;
        var lat = Math.abs(-dx * uy + dy * ux);
        var lim = obs[k + 2] + myR + cfg.rayMargin;
        if (lat < lim) {
          var tt = Math.max(0, along - Math.sqrt(lim * lim - lat * lat));
          if (tt < t) t = tt;
        }
      }
      return t;
    }

    var best = desired, bestCost = Infinity;
    for (var d = -180; d <= 180; d += 15) {
      var off = d * Math.PI / 180, a = desired + off, c = clear(a);
      var blocked = c < L ? (L - c) / L * 8 : 0;
      if (c < TR * 0.8) blocked += 10;
      var cost = Math.abs(off) + blocked +
        Math.abs(normAngle(a - heading)) * 0.35 + Math.abs(normAngle(a - lastAngle)) * 0.15;
      if (cost < bestCost) { bestCost = cost; best = a; }
    }
    return best;
  }

  function log() {
    var a = Array.prototype.slice.call(arguments);
    if (cfg.log) console.log.apply(console, [TAG].concat(a));
    uiLog(a.map(String).join(" "));
  }
  function warn(m) {
    m = String(m);
    if (m === lastError) return;      // не спамим одинаковыми ошибками
    lastError = m;
    console.warn(TAG, m);
    uiLog("! " + m, true);
  }

  function hypot(a, b) { return Math.sqrt(a * a + b * b); }
  function normAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  function lerpAngle(a, b, t) { return a + normAngle(b - a) * t; }

  // ---------- canvas ----------
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

  // ---------- React fiber ----------
  function getFiber(dom) {
    if (!dom) return null;
    var keys = Object.keys(dom);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf("__reactFiber") === 0 || k.indexOf("__reactInternalInstance") === 0) return dom[k];
    }
    return null;
  }

  function snapFromFiber(f) {
    if (!f) return null;
    try {
      var p = f.memoizedProps || f.pendingProps;
      if (p && p.snapshot && p.snapshot.me && typeof p.snapshot.me.x === "number") return p.snapshot;
      var s = f.memoizedState, g = 0;
      while (s && g++ < 30) {
        var mq = s.memoizedState;
        if (mq && mq.snapshot && mq.snapshot.me && typeof mq.snapshot.me.x === "number") return mq.snapshot;
        s = s.next;
      }
    } catch (e) {}
    return null;
  }

  // BFS без queue.shift() (он O(n) и тормозил на телефоне). Возвращает fiber-держатель.
  function findHolder(fiber, maxNodes) {
    var queue = [fiber], head = 0, seen = 0;
    while (head < queue.length && seen < maxNodes) {
      var f = queue[head++];
      seen++;
      if (!f) continue;
      if (snapFromFiber(f)) return f;
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
    }
    return null;
  }

  var FRESH_KEYS = ["tick", "t", "time", "ts", "seq", "frame", "serverTime", "now"];
  function fresher(a, b) {
    for (var i = 0; i < FRESH_KEYS.length; i++) {
      var k = FRESH_KEYS[i];
      if (typeof a[k] === "number" && typeof b[k] === "number" && a[k] !== b[k]) return a[k] > b[k];
    }
    var la = lastSnap && lastSnap.me;
    if (la) {
      var da = a.me.x !== la.x || a.me.y !== la.y;
      var db = b.me.x !== la.x || b.me.y !== la.y;
      if (da && !db) return true;
    }
    return false;
  }

  function readCached() {
    if (!holder) return null;
    var best = null, cands = [holder, holder.alternate];
    for (var i = 0; i < cands.length; i++) {
      var s = snapFromFiber(cands[i]);
      if (s && (!best || fresher(s, best))) best = s;
    }
    return best;
  }

  function scanForHolder(now) {
    var c = findCanvas();
    var found = null;
    if (c) {
      // SnakeCanvas получает snapshot пропсом: это предок canvas-fiber по цепочке return
      var up = getFiber(c);
      for (var u = 0; u < 40 && up && !found; u++) {
        if (snapFromFiber(up)) found = up;
        up = up.return;
      }
    }
    if (!found && c) {
      var el = c;
      for (var depth = 0; depth < 12 && el && !found; depth++) {
        var fiber = getFiber(el);
        if (fiber) found = findHolder(fiber, 800);
        el = el.parentElement;
      }
    }
    if (!found) {
      var root = document.getElementById("root") || document.body;
      var rf = getFiber(root);
      if (rf) found = findHolder(rf, 2500);
    }
    lastScan = now;
    stats.rescans++;
    return found;
  }

  function readSnapshot(now) {
    var s = readCached();
    if (s) { lastSnap = s; return s; }
    holder = null;
    // поиск не чаще чем раз в 300 мс — раньше это шло каждый тик
    if (now - lastScan < 300) return null;
    holder = scanForHolder(now);
    s = readCached();
    if (s) { lastSnap = s; return s; }
    return null;
  }

  // ---------- socket (по желанию) ----------
  function tryFindSocket(now) {
    if (socket && socket.connected) return socket;
    if (now - lastSocketScan < 3000) return null;   // раньше скан шёл каждый тик
    lastSocketScan = now;
    function check(o) {
      if (!o || typeof o !== "object") return null;
      try {
        if (typeof o.emit === "function" && typeof o.on === "function" && o.io &&
            (o.connected === true || o.connected === false)) return o;
      } catch (e) {}
      return null;
    }
    try {
      if (window.io && window.io.managers) {
        var mgrs = window.io.managers;
        for (var k in mgrs) {
          var m = mgrs[k];
          if (m && m.nsps) for (var n in m.nsps) {
            var s = check(m.nsps[n]);
            if (s) { socket = s; return s; }
          }
        }
      }
    } catch (e) {}
    return socket;
  }

  // ---------- разбор состояния ----------
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
      list.push({ runId: s[0], color: s[1], radius: s[2] || 10, body: body, head: body[0] || null, len: body.length });
    }
    return list;
  }
  function parseFruit(snap) {
    var list = [];
    if (!snap || !snap.fruit) return list;
    for (var i = 0; i < snap.fruit.length; i++) {
      var f = snap.fruit[i];
      list.push({ id: f[0], type: f[1], x: f[2], y: f[3], r: f[4] || 8, on: f[5] === 1 });
    }
    return list;
  }
  function parseBombs(snap) {
    var list = [];
    if (!snap || !snap.bombs) return list;
    for (var i = 0; i < snap.bombs.length; i++) {
      var b = snap.bombs[i];
      list.push({ x: b[1], y: b[2], r: cfg.bombR });
    }
    return list;
  }

  function fruitKey(fr) {
    return (fr.id !== undefined && fr.id !== null) ? "i" + fr.id : "p" + Math.round(fr.x / 20) + "," + Math.round(fr.y / 20);
  }

  // Фрукт внутри минимального круга поворота = змея будет ходить вокруг него по кругу
  function unreachable(mx, my, h, fx, fy, R, slack) {
    var rr = Math.max(R * 0.5, R - slack);
    var lx = mx + Math.cos(h + Math.PI / 2) * R, ly = my + Math.sin(h + Math.PI / 2) * R;
    var rx = mx + Math.cos(h - Math.PI / 2) * R, ry = my + Math.sin(h - Math.PI / 2) * R;
    return hypot(fx - lx, fy - ly) < rr || hypot(fx - rx, fy - ry) < rr;
  }

  function noteTypes(fruits) {
    var seen = {};
    for (var i = 0; i < fruits.length; i++) {
      var g = grp(fruits[i].type);
      if (!seen[g]) seen[g] = { n: 0, dim: 0 };
      seen[g].n++;
      if (!fruits[i].on) seen[g].dim++;
    }
    groupSeen = seen;
    if (stats.ticks % 20 === 0) refreshGroupRows();
  }

  // ---------- история и детектор кругов ----------
  function detectCircling(now) {
    if (hist.length < 20 || now - hist[0].t < 2200) return false;
    var turn = 0;
    for (var i = 1; i < hist.length; i++) turn += normAngle(hist[i].h - hist[i - 1].h);
    var disp = hypot(hist[hist.length - 1].x - hist[0].x, hist[hist.length - 1].y - hist[0].y);
    return Math.abs(turn) > 5.2 && disp < 260;
  }

  function blacklistTarget(now, ms) {
    if (!target) return;
    blk[target.key] = now + (ms || cfg.blacklistMs);
    stats.blacklisted++;
    target = null;
  }

  // ---------- ИИ ----------
  function computeSteer(snap, now) {
    var mx = snap.me.x, my = snap.me.y, myId = snap.me.runId;
    var snakes = parseSnakes(snap);
    var fruits = parseFruit(snap);
    var bombs = parseBombs(snap);
    noteTypes(fruits);
    if (!loggedFruitSample && snap.fruit && snap.fruit.length) {
      loggedFruitSample = true;
      log("fruit[0]=" + JSON.stringify(snap.fruit[0]));
    }

    var meSnake = null;
    for (var i = 0; i < snakes.length; i++) if (snakes[i].runId === myId) meSnake = snakes[i];
    var myR = meSnake ? meSnake.radius : 12;
    var myLen = meSnake ? meSnake.len : 5;

    // реальное направление — по телу, а не по последней команде
    var heading = lastAngle;
    if (meSnake && meSnake.body.length >= 2) {
      var b0 = meSnake.body[0], b1 = meSnake.body[1];
      if (hypot(b0.x - b1.x, b0.y - b1.y) > 0.5) heading = Math.atan2(b0.y - b1.y, b0.x - b1.x);
    }
    var cosH = Math.cos(heading), sinH = Math.sin(heading);
    calibrate(snap.t, mx, my, heading);
    var TR = (cfg.autoTurn && cal.R) ? cal.R : cfg.turnRadius;

    hist.push({ t: now, x: mx, y: my, h: heading });
    while (hist.length && now - hist[0].t > 3500) hist.shift();
    if (detectCircling(now)) {
      stats.circles++;
      blacklistTarget(now, 6000);
      escapeUntil = now + 1000;
      hist.length = 0;
      log("круги → выход по прямой");
    }

    var hx = 0, hy = 0;   // отталкивание от опасностей
    var gx = 0, gy = 0;   // притяжение к цели
    var boost = false, mode = "cruise";

    // --- стены: реакция только вблизи (квадратичная), плюс небольшой взгляд вперёд ---
    var wm = cfg.wallMargin;
    function wp(d) { if (d >= wm) return 0; var t = (wm - d) / wm; return cfg.wallWeight * t * t; }
    hx += wp(mx) - wp(WORLD - mx);
    hy += wp(my) - wp(WORLD - my);
    var look = TR * 1.3 + 20, am = wm * 0.5;
    var ax = mx + cosH * look, ay = my + sinH * look;
    if (ax < am) hx += cfg.wallWeight * 0.8 * (am - ax) / am;
    if (ax > WORLD - am) hx -= cfg.wallWeight * 0.8 * (ax - (WORLD - am)) / am;
    if (ay < am) hy += cfg.wallWeight * 0.8 * (am - ay) / am;
    if (ay > WORLD - am) hy -= cfg.wallWeight * 0.8 * (ay - (WORLD - am)) / am;

    // --- чужие змеи ---
    var threat = null;
    for (var si = 0; si < snakes.length; si++) {
      var sn = snakes[si];
      if (sn.runId === myId || !sn.head) continue;
      var step = Math.max(1, Math.floor(sn.body.length / 24));
      var safe = myR + sn.radius + cfg.bodyMargin, infl = safe * 2.2;
      for (var bi = 0; bi < sn.body.length; bi += step) {
        var p = sn.body[bi];
        var dx = mx - p.x, dy = my - p.y, d = hypot(dx, dy);
        if (d < infl && d > 1) {
          var w = cfg.avoidWeight * (infl - d) / infl;
          hx += (dx / d) * w;
          hy += (dy / d) * w;
        }
      }
      var ehx = sn.head.x - mx, ehy = sn.head.y - my, ehd = hypot(ehx, ehy);
      if (ehd < cfg.threatRange && ehd > 1 && sn.body.length >= 2) {
        var eh = Math.atan2(sn.body[0].y - sn.body[1].y, sn.body[0].x - sn.body[1].x);
        var toMe = Math.atan2(-ehy, -ehx);
        if (Math.abs(normAngle(eh - toMe)) < 1.05) {
          if (!threat || ehd < threat.d) threat = { sn: sn, d: ehd, hx: ehx, hy: ehy, eh: eh };
        }
      }
    }

    // --- бомбы (красные кружки): только вблизи и/или по курсу ---
    if (cfg.avoidBombs) {
      for (var bj = 0; bj < bombs.length; bj++) {
        var b = bombs[bj];
        var danger = b.r + myR + cfg.bombMargin;
        var tbx = b.x - mx, tby = b.y - my, db = hypot(tbx, tby);
        if (db > danger * 2 || db < 1) continue;
        var fwd = tbx * cosH + tby * sinH;
        var lat = -tbx * sinH + tby * cosH;
        if (db < danger) {
          var wb = 0.6 + 2.8 * (danger - db) / danger;
          hx -= (tbx / db) * wb;
          hy -= (tby / db) * wb;
        } else if (fwd > 0 && Math.abs(lat) < danger) {
          // бомба на пути — мягко уходим вбок, а не назад
          var side = lat > 0 ? -1 : 1;
          var ws = 1.6 * (1 - fwd / (danger * 2));
          hx += (-sinH) * side * ws;
          hy += (cosH) * side * ws;
        }
      }
    }

    // --- угроза от змеи ---
    if (threat && cfg.attackIfThreatened) {
      var bigger = myLen > threat.sn.len * 1.15;
      if (bigger && !cfg.peaceful) {
        mode = "counter";
        var ddx = threat.sn.head.x - mx, ddy = threat.sn.head.y - my, dd = hypot(ddx, ddy) || 1;
        gx += (ddx / dd) * cfg.huntWeight;
        gy += (ddy / dd) * cfg.huntWeight;
        boost = cfg.boostOnHunt;
      } else {
        mode = "flee";
        var fd = hypot(threat.hx, threat.hy) || 1;
        hx += (-threat.hx / fd) * cfg.avoidWeight * 1.6;
        hy += (-threat.hy / fd) * cfg.avoidWeight * 1.6;
        // уходим вбок от траектории врага
        var ex = Math.cos(threat.eh), ey = Math.sin(threat.eh);
        var cross = ex * (-threat.hy) - ey * (-threat.hx);
        var sg = cross >= 0 ? 1 : -1;
        hx += (-ey) * sg * 1.6;
        hy += (ex) * sg * 1.6;
        boost = cfg.boostOnFlee;
      }
    }

    // --- выбор и ведение цели ---
    if (mode === "flee") {
      if (target) target.tMin = now;       // пауза таймера «нет прогресса»
    } else if (now < escapeUntil) {
      mode = "escape";
      gx += cosH * 1.5;
      gy += sinH * 1.5;
    } else {
      var bestFr = null, bestScore = Infinity, curFr = null, curScore = Infinity;
      for (var fi = 0; fi < fruits.length; fi++) {
        var fr = fruits[fi];
        if (!isTypeOn(fr.type)) continue;
        var key = fruitKey(fr);
        if (blk[key] && blk[key] > now) continue;
        var fdx = fr.x - mx, fdy = fr.y - my, dist = hypot(fdx, fdy);
        var diff = Math.abs(normAngle(Math.atan2(fdy, fdx) - heading));
        var score = dist + diff * TR * 0.9;
        if (fr.type === 4) score -= 90;
        if (!fr.on) score += cfg.dimPenalty;
        score -= fr.r * cfg.sizeBonus;
        var nb = 0;
        for (var nj = 0; nj < fruits.length && nb < 5; nj++) {
          if (nj !== fi && isTypeOn(fruits[nj].type) && hypot(fruits[nj].x - fr.x, fruits[nj].y - fr.y) < 160) nb++;
        }
        score -= nb * cfg.clusterBonus;
        var edge = Math.min(fr.x, fr.y, WORLD - fr.x, WORLD - fr.y);
        if (edge < 40) score += 250; else if (edge < 90) score += 100;
        var skip = false;
        for (var bk = 0; bk < bombs.length; bk++) {
          if (hypot(fr.x - bombs[bk].x, fr.y - bombs[bk].y) < bombs[bk].r + fr.r + myR + 20) { skip = true; break; }
        }
        if (skip && cfg.avoidBombs) continue;
        for (var sj = 0; sj < snakes.length; sj++) {
          if (snakes[sj].runId === myId || !snakes[sj].head) continue;
          if (hypot(fr.x - snakes[sj].head.x, fr.y - snakes[sj].head.y) < 200) score += 220;
        }
        if (dist < TR * 4 && unreachable(mx, my, heading, fr.x, fr.y, TR, (fr.r + myR) * 0.6)) score += 350;
        if (target && key === target.key) { curFr = fr; curScore = score; }
        if (score < bestScore) { bestScore = score; bestFr = fr; }
      }
      if (curFr && bestFr !== curFr && !(bestScore < curScore * cfg.targetStickiness - 25)) bestFr = curFr;

      if (bestFr) {
        var bkey = fruitKey(bestFr);
        var bd = hypot(bestFr.x - mx, bestFr.y - my);
        if (!target || target.key !== bkey) {
          target = { key: bkey, type: bestFr.type, t0: now, minD: bd, tMin: now };
        }
        if (bd < target.minD - 6) { target.minD = bd; target.tMin = now; }
        if (now - target.tMin > cfg.noProgressMs || (now - target.t0 > 12000 && bd < 600)) {
          blacklistTarget(now);
          bestFr = null;
        }
      } else {
        target = null;
      }

      if (bestFr) {
        mode = "farm";
        var tdx = bestFr.x - mx, tdy = bestFr.y - my, td = hypot(tdx, tdy) || 1;
        if (td < TR * 4 && unreachable(mx, my, heading, bestFr.x, bestFr.y, TR, (bestFr.r + myR) * 0.6)) {
          // внутри круга поворота: едем прямо, пока не выйдем из него, и заходим заново
          gx += cosH * cfg.fruitWeight;
          gy += sinH * cfg.fruitWeight;
        } else {
          gx += (tdx / td) * cfg.fruitWeight;
          gy += (tdy / td) * cfg.fruitWeight;
        }
      } else {
        // нечего собирать — спокойно плывём, тянемся к центру карты, если далеко от него
        mode = "wander";
        wanderPhase += 0.05;
        var wa = heading + Math.sin(wanderPhase) * 0.5;
        gx += Math.cos(wa) * 0.6;
        gy += Math.sin(wa) * 0.6;
        var cdx = WORLD / 2 - mx, cdy = WORLD / 2 - my, cd = hypot(cdx, cdy);
        if (cd > 3200) { gx += (cdx / cd) * 0.6; gy += (cdy / cd) * 0.6; }
      }
    }

    // --- охота ---
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
        gx += (px / pp) * cfg.huntWeight;
        gy += (py / pp) * cfg.huntWeight;
        boost = cfg.boostOnHunt && prey.d < 220;
      }
    }

    var vx = hx + gx, vy = hy + gy;
    if (Math.abs(vx) < 1e-6 && Math.abs(vy) < 1e-6) return { angle: lastAngle, boost: false, mode: "idle" };
    var desired = Math.atan2(vy, vx);
    var safeA = cfg.rays ? pickSafeAngle(desired, mx, my, myR, heading, snakes, bombs, myId, TR) : desired;
    var angle = lerpAngle(lastAngle, safeA, 0.55);
    lastAngle = angle;
    return { angle: angle, boost: boost, mode: mode };
  }

  // ---------- ввод ----------
  function fire(c, type, x, y, extra) {
    var o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    if (extra) for (var k in extra) o[k] = extra[k];
    try { c.dispatchEvent(new MouseEvent(type, o)); } catch (e) {}
  }
  function releaseBoost() {
    if (!boostDown) return;
    boostDown = false;
    var c = findCanvas();
    if (c) fire(c, "mouseup", 0, 0);
    try { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 })); } catch (e) {}
  }

  function applyInput(angle, boost, now) {
    var c = findCanvas();
    if (!c) return false;
    var rect = c.getBoundingClientRect();
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    var dist = Math.min(rect.width, rect.height) * 0.35;
    var x = cx + Math.cos(angle) * dist, y = cy + Math.sin(angle) * dist;

    if (cfg.useSocket) {
      var s = tryFindSocket(now);
      if (s && s.connected) {
        try { s.emit("i", { angle: angle, boost: !!boost }); return true; } catch (e) {}
      }
    }

    try {
      fire(c, "mousemove", x, y);
      // нажатие/отпускание — только при смене состояния
      if (boost && !boostDown) {
        boostDown = true;
        fire(c, "mousedown", x, y);
        stats.boosts++;
      } else if (!boost && boostDown) {
        releaseBoost();
      }
      return true;
    } catch (e) {
      warn("input: " + e);
      return false;
    }
  }

  // ---------- главный цикл ----------
  function tick() {
    if (!running || !cfg.enabled) return;
    var now = Date.now();
    var snap = readSnapshot(now);
    if (!snap || !snap.me) {
      releaseBoost();
      uiStatus("нет snapshot — открой матч");
      return;
    }

    var hp = holder && holder.memoizedProps;
    if (hp && hp.paused === true) {
      releaseBoost();
      uiStatus("пауза игры");
      return;
    }

    // «замёрзший» snapshot: живая змея всегда двигается
    var me = snap.me;
    var sameT = typeof snap.t === "number" && snap.t === lastT;
    if ((lastMe && me.x === lastMe.x && me.y === lastMe.y) || sameT) stallTicks++; else stallTicks = 0;
    lastMe = { x: me.x, y: me.y };
    lastT = snap.t;
    if (stallTicks > 30) {
      stallTicks = 0;
      holder = null;
      lastScan = 0;
      log("snapshot не меняется → пересканирую");
    }

    var decision = computeSteer(snap, now);
    if (!decision) return;
    lastMode = decision.mode;
    lastBoost = !!decision.boost;
    applyInput(decision.angle, decision.boost, now);
    stats.ticks++;

    if (stats.ticks % 200 === 0) {
      for (var k in blk) if (blk[k] < now) delete blk[k];
    }
    if (stats.ticks % 10 === 0) {
      uiStatus(decision.mode + (decision.boost ? " ⚡" : "") +
        (target ? " · цель " + GROUPS[grp(target.type)].icon : "") +
        (cal.R ? " · R" + Math.round(cal.R) : " · R?") + " · t=" + stats.ticks);
    }
  }

  function loop() {
    if (!running) return;
    var t0 = Date.now();
    try { tick(); } catch (e) { warn("tick: " + (e && e.message ? e.message : e)); }
    timer = setTimeout(loop, Math.max(10, cfg.tickMs - (Date.now() - t0)));
  }

  // ---------- «Смотри рекламу» (бывший FaroAds) ----------
  // Только нажимает кнопку в приложении, когда она доступна. Реклама показывается
  // на экране полностью, просмотр засчитывает само приложение.
  var adCfg = {
    pollMs: 1000,        // как часто проверяем кнопку
    minGapMs: 4000,      // минимум между нажатиями
    noProgressLimit: 3,  // сколько раз подряд реклама не засчиталась до остановки
    waitAdMs: 90000,     // максимум ждём окончания одного показа
    onlyVisible: true    // нажимать только когда приложение на экране
  };
  var ad = { running: false, timer: null, lastClick: 0, clickedAt: 0, progressAtClick: null, noProgress: 0, wakeLock: null, info: "готов" };
  var adBtnEl = null, adInfoEl = null, adVisTimer = null;

  function adFindRoot() { return document.querySelector(".watch-ad-task"); }
  function adFindButton() {
    var root = adFindRoot();
    return root ? root.querySelector("button.primary, button.button") : null;
  }
  function adReadProgress() {
    var root = adFindRoot();
    if (!root) return null;
    var strong = root.querySelector(".task-requirement strong") || root;
    var m = /(\d+)\s*\/\s*(\d+)/.exec(strong.textContent || "");
    return m ? { done: +m[1], total: +m[2] } : null;
  }
  function adIsBusy(btn) {
    return !btn || btn.disabled || btn.getAttribute("aria-busy") === "true" || btn.classList.contains("loading");
  }
  function adSetInfo(t) { ad.info = t; adRender(); }

  function adTick() {
    if (!ad.running) return;
    var p = adReadProgress();
    var btn = adFindButton();

    if (!p || !btn) { adSetInfo("открой задание с рекламой"); return; }
    if (p.done >= p.total) { adSetInfo("готово: " + p.done + "/" + p.total); adStop(true); return; }
    if (adCfg.onlyVisible && document.visibilityState !== "visible") { adSetInfo("жду экран · " + p.done + "/" + p.total); return; }

    // оценка предыдущего нажатия
    if (ad.clickedAt) {
      var t = Date.now();
      if (p.done > ad.progressAtClick) { ad.noProgress = 0; ad.clickedAt = 0; }
      else if (t - ad.clickedAt > adCfg.waitAdMs) {
        ad.noProgress++; ad.clickedAt = 0;
        if (ad.noProgress >= adCfg.noProgressLimit) { adSetInfo("реклама не засчитывается — стоп"); adStop(true); return; }
      } else { adSetInfo("идёт реклама… " + p.done + "/" + p.total); return; }
    }

    if (adIsBusy(btn)) { adSetInfo("кулдаун/загрузка · " + p.done + "/" + p.total); return; }
    if (Date.now() - ad.lastClick < adCfg.minGapMs) return;

    ad.lastClick = Date.now(); ad.clickedAt = ad.lastClick; ad.progressAtClick = p.done;
    adSetInfo("запускаю рекламу · " + p.done + "/" + p.total);
    btn.click();
  }

  function adLock() {
    try { if (navigator.wakeLock) navigator.wakeLock.request("screen").then(function (l) { ad.wakeLock = l; }, function () {}); } catch (e) {}
  }
  function adUnlock() { try { if (ad.wakeLock) ad.wakeLock.release(); } catch (e) {} ad.wakeLock = null; }
  function adOnVisible() { if (ad.running && document.visibilityState === "visible") adLock(); }
  document.addEventListener("visibilitychange", adOnVisible);

  function adStart() {
    if (ad.running) return "already";
    ad.running = true; ad.noProgress = 0; ad.clickedAt = 0; ad.lastClick = 0;
    adLock();
    ad.timer = setInterval(function () {
      try { adTick(); } catch (e) { warn("ads: " + (e && e.message ? e.message : e)); }
    }, adCfg.pollMs);
    adSetInfo("работаю");
    try { adTick(); } catch (e) { warn("ads: " + e); }
    return "started";
  }
  function adStop(silent) {
    ad.running = false;
    if (ad.timer) clearInterval(ad.timer);
    ad.timer = null;
    adUnlock();
    if (!silent) adSetInfo("стоп"); else adRender();
    return "stopped";
  }
  function adRender() {
    if (!adInfoEl || !adBtnEl) return;
    var p = adReadProgress();
    adInfoEl.textContent = "Реклама" + (p ? " " + p.done + "/" + p.total : "") + " · " + ad.info;
    adBtnEl.textContent = ad.running ? "СТОП" : "СТАРТ";
    adBtnEl.style.background = ad.running ? "#844" : "#2a8";
  }

  // ---------- UI ----------
  var panel, logEl, statusEl, typesEl, bodyEl;
  var typeRows = {};

  function ensureUI() {
    if (panel && document.body.contains(panel)) return;
    typeRows = {};
    panel = document.createElement("div");
    panel.id = "snake-bot-panel";
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
      '<b>SnakeBot ' + VERSION + '</b><button id="sb-min" style="border:0;background:#2a3a4c;color:#fff;border-radius:6px;padding:2px 8px">–</button></div>' +
      '<div id="sb-status" style="font-size:11px;opacity:.9;margin-bottom:8px">idle</div>' +
      '<div style="display:flex;align-items:center;gap:6px;border:1px solid #3a6a4a;border-radius:8px;padding:6px;margin-bottom:8px">' +
      '<div id="sb-ad-info" style="flex:1;min-width:0;font-size:11px">Реклама · готов</div>' +
      '<button id="sb-ad-btn" style="border:0;border-radius:8px;padding:6px 10px;font:700 11px system-ui;color:#fff;background:#2a8;touch-action:manipulation">СТАРТ</button></div>' +
      '<div id="sb-body">' +
      '<div style="display:flex;gap:6px;margin-bottom:6px">' +
      '<button id="sb-start" style="flex:1;padding:6px;border:0;border-radius:8px;background:#2a8;color:#fff;font-weight:700">START</button>' +
      '<button id="sb-stop" style="flex:1;padding:6px;border:0;border-radius:8px;background:#844;color:#fff;font-weight:700">STOP</button></div>' +
      '<label style="font-size:11px;display:flex;gap:6px;align-items:center;margin-bottom:4px"><input id="sb-peaceful" type="checkbox" checked/> мирный</label>' +
      '<label style="font-size:11px;display:flex;gap:6px;align-items:center;margin-bottom:4px"><input id="sb-bombs" type="checkbox" checked/> обходить бомбы</label>' +
      '<label style="font-size:11px;display:flex;gap:6px;align-items:center;margin-bottom:4px"><input id="sb-flee" type="checkbox" checked/> ускоряться при бегстве</label>' +
      '<label style="font-size:11px;display:flex;gap:6px;align-items:center;margin-bottom:6px"><input id="sb-auto" type="checkbox" checked/> авто-радиус поворота</label>' +
      '<div style="font-size:11px;font-weight:700;margin:6px 0 2px">Собирать фрукты (по цвету)</div>' +
      '<div id="sb-types" style="font-size:11px"></div>' +
      '<div id="sb-log" style="font-size:10px;max-height:90px;overflow:auto;line-height:1.35;opacity:.85;margin-top:6px"></div>' +
      '</div>';
    panel.style.cssText =
      "position:fixed;right:8px;bottom:100px;z-index:2147483646;width:200px;padding:10px;" +
      "border-radius:12px;background:rgba(12,18,28,.93);color:#d0e4ff;" +
      "font:12px/1.3 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);border:1px solid #3a5570;";
    document.body.appendChild(panel);
    logEl = panel.querySelector("#sb-log");
    statusEl = panel.querySelector("#sb-status");
    typesEl = panel.querySelector("#sb-types");
    bodyEl = panel.querySelector("#sb-body");
    adInfoEl = panel.querySelector("#sb-ad-info");
    adBtnEl = panel.querySelector("#sb-ad-btn");
    adBtnEl.onclick = function () { ad.running ? adStop() : adStart(); };
    adRender();
    panel.querySelector("#sb-start").onclick = function () { api.start(); };
    panel.querySelector("#sb-stop").onclick = function () { api.stop(); };
    panel.querySelector("#sb-peaceful").checked = cfg.peaceful;
    panel.querySelector("#sb-peaceful").onchange = function (e) { cfg.peaceful = !!e.target.checked; saveCfg(); log("peaceful=" + cfg.peaceful); };
    panel.querySelector("#sb-bombs").checked = cfg.avoidBombs;
    panel.querySelector("#sb-bombs").onchange = function (e) { cfg.avoidBombs = !!e.target.checked; saveCfg(); log("avoidBombs=" + cfg.avoidBombs); };
    panel.querySelector("#sb-flee").checked = cfg.boostOnFlee;
    panel.querySelector("#sb-flee").onchange = function (e) { cfg.boostOnFlee = !!e.target.checked; saveCfg(); log("boostOnFlee=" + cfg.boostOnFlee); };
    panel.querySelector("#sb-auto").checked = cfg.autoTurn;
    panel.querySelector("#sb-auto").onchange = function (e) { cfg.autoTurn = !!e.target.checked; saveCfg(); log("autoTurn=" + cfg.autoTurn); };
    panel.querySelector("#sb-min").onclick = function () {
      bodyEl.style.display = bodyEl.style.display === "none" ? "" : "none";
    };
    // восстановить строки типов после пересоздания панели
    buildGroupRows();
  }

  function buildGroupRows() {
    if (!typesEl) return;
    typesEl.innerHTML = "";
    typeRows = {};
    // зелёные и жёлтые — сверху, как просили
    var order = [1, 2, 0, 3, 4];
    order.forEach(function (g) {
      var row = document.createElement("label");
      row.style.cssText = "display:flex;align-items:center;gap:6px;margin:4px 0";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = groupOn[g] !== false;
      cb.onchange = function () {
        groupOn[g] = !!cb.checked;
        lsSet("sb_group_on", groupOn);
        if (!cb.checked && target && grp(target.type) === g) target = null;
        log(GROUPS[g].icon + " " + GROUPS[g].name + (cb.checked ? ": собираю" : ": пропускаю"));
      };
      var lab = document.createElement("span");
      lab.style.flex = "1";
      row.appendChild(cb); row.appendChild(lab);
      typesEl.appendChild(row);
      typeRows[g] = { cb: cb, lab: lab };
    });
    refreshGroupRows();
  }

  function refreshGroupRows() {
    for (var g in typeRows) {
      var s = groupSeen[g];
      typeRows[g].lab.textContent = GROUPS[g].icon + " " + GROUPS[g].name + (s ? " ×" + s.n : "");
    }
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
  function uiStatus(t) { ensureUI(); if (statusEl) statusEl.textContent = t; }

  var api = {
    version: VERSION,
    cfg: cfg,
    start: function () {
      ensureUI();
      cfg.enabled = true;
      running = true;
      findCanvas();
      holder = null; lastScan = 0; stallTicks = 0;
      target = null; hist.length = 0; blk = {}; escapeUntil = 0;
      loggedFruitSample = false;
      cal.snapT = null;
      if (timer) clearTimeout(timer);
      log("START v" + VERSION);
      loop();
      return "started";
    },
    stop: function () {
      cfg.enabled = false;
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      releaseBoost();
      log("STOP");
      uiStatus("stopped");
      return "stopped";
    },
    ads: {
      start: adStart,
      stop: function () { return adStop(); },
      cfg: adCfg,
      status: function () { return { running: ad.running, info: ad.info, progress: adReadProgress(), noProgress: ad.noProgress }; }
    },
    dispose: function () {
      adStop(true);
      document.removeEventListener("visibilitychange", adOnVisible);
      if (adVisTimer) clearInterval(adVisTimer);
    },
    status: function () {
      var snap = readSnapshot(Date.now());
      return {
        version: VERSION,
        ads: { running: ad.running, info: ad.info, progress: adReadProgress() },
        enabled: cfg.enabled,
        hasCanvas: !!findCanvas(),
        hasSnap: !!(snap && snap.me),
        hasSocket: !!(socket && socket.connected),
        me: snap && snap.me ? { x: snap.me.x, y: snap.me.y, runId: snap.me.runId } : null,
        mode: lastMode,
        target: target ? { type: target.type, key: target.key } : null,
        stats: stats,
        turnRadius: cal.R,
        samples: { speeds: cal.speeds.length, omegas: cal.omegas.length },
        lastError: lastError
      };
    },
    types: function () { return { seen: groupSeen, enabled: groupOn, groups: GROUPS }; },
    // __SNAKE_BOT__.setColor(1, false) — выключить зелёные; 0 синие, 1 зелёные, 2 жёлтые, 3 оранжевые, 4 розовые
    setColor: function (g, on) { groupOn[g] = !!on; lsSet("sb_group_on", groupOn); if (typeRows[g]) typeRows[g].cb.checked = !!on; return groupOn; },
    set: function (o) { Object.assign(cfg, o || {}); return cfg; }
  };

  window.__SNAKE_BOT__ = api;
  ensureUI();
  // панель могли убрать при смене экрана — возвращаем и обновляем счётчик рекламы
  adVisTimer = setInterval(function () { try { ensureUI(); adRender(); } catch (e) {} }, 2000);
  uiStatus("ready — матч + START");
  console.log("%c" + TAG + " v" + VERSION + " ready", "color:#6af;font-weight:bold");
})();
