/**
 * FaroBot v1.7.0  (основа — 1.4.0, без турбо)
 *
 * Вставь в консоль (Eruda) на странице Faro. Появится плавающая панель:
 *   START / STOP, выбор скорости, переключатели автоматизаций, статистика, лог.
 *
 * Что умеет:
 *  - Harvest: цепочки + бомбы, ждёт анимацию фишек (нет ошибок 409)
 *  - Авто-раунды: сам заходит в новый раунд (join), можно с x2-очками
 *  - Автосессия: при 401 сам обновляет токен (через Telegram initData)
 *  - Daily, Фарм (старт/клейм станций), Задания (claim), Колесо (бесплатные спины)
 *  - Watchdog, повтор при ошибках с паузой, "не засыпать" (wake lock)
 *  - Лимиты: по ходам и по минутам
 *  - Реклама: переключатель «Реклама» сам нажимает кнопку «Watch ad» в задании
 *    (откройте задание с рекламой; показ и засчитывание делает само приложение)
 *
 * Консоль: __FARO_BOT__.start() / .stop() / .status() / .speed("safe|normal|fast")
 */
(function () {
  "use strict";
  const VERSION = "1.7.0";
  const TAG = "[FaroBot]";

  // убрать предыдущий экземпляр
  try { if (window.__FARO_BOT__ && window.__FARO_BOT__.stop) window.__FARO_BOT__.stop(); } catch (e) {}
  try { var oldPanel = document.getElementById("faro-bot-panel"); if (oldPanel) oldPanel.remove(); } catch (e) {}

  // ---------- настройки ----------
  const SPEEDS = {
    safe:   { delayMin: 800, delayMax: 1600, thinkMin: 250, thinkMax: 700 },
    normal: { delayMin: 300, delayMax: 600,  thinkMin: 80,  thinkMax: 200 },
    fast:   { delayMin: 120, delayMax: 300,  thinkMin: 20,  thinkMax: 80 },
  };
  const SPEED_LABELS = { safe: "Медленно", normal: "Норм", fast: "Быстро" };

  const cfg = {
    enabled: false,
    speed: "fast",
    minChain: 3,
    diagonal: true,
    preferCoins: true,
    preferLong: true,
    // автоматизации (переключатели на панели)
    useBombs: true,
    autoJoin: true,
    useDouble: true,
    autoDaily: true,
    autoFarm: true,
    autoTasks: true,
    autoWheel: true,
    autoSession: true,
    wakeLock: true,
    autoAds: false,
    // лимиты (0 = без лимита)
    maxMoves: 0,
    maxMinutes: 0,
    // прочее
    autoResume: true,
    reloadOnStuck: false, // перезагружать страницу при зависании (нужен автоинжектор скрипта)
    log: true,
  };
  Object.assign(cfg, SPEEDS.fast);

  const TOGGLES = [
    ["useBombs", "Бомбы"], ["autoJoin", "Авто-раунды"], ["useDouble", "x2 очки"],
    ["autoDaily", "Daily"], ["autoFarm", "Фарм"], ["autoTasks", "Задания"],
    ["autoWheel", "Колесо"], ["autoSession", "Автосессия"], ["wakeLock", "Не засыпать"], ["autoAds", "Реклама"],
  ];
  const PERSIST = TOGGLES.map(function (t) { return t[0]; }).concat(["speed", "maxMoves", "maxMinutes", "autoResume", "reloadOnStuck"]);

  function loadCfg() {
    try {
      var o = JSON.parse(localStorage.getItem("faroBot:cfg") || "null");
      if (o) PERSIST.forEach(function (k) { if (k in o) cfg[k] = o[k]; });
      if (SPEEDS[cfg.speed]) Object.assign(cfg, SPEEDS[cfg.speed]);
    } catch (e) {}
  }
  function saveCfg() {
    try {
      var o = {}; PERSIST.forEach(function (k) { o[k] = cfg[k]; });
      localStorage.setItem("faroBot:cfg", JSON.stringify(o));
    } catch (e) {}
  }
  loadCfg();

  // ---------- состояние ----------
  let token = null;
  let deadToken = null;
  let lastHarvest = null;
  let busy = false, stopFlag = false, timer = null;
  let lastError = "";
  let errStreak = 0, failStreak = 0;
  let waitHit = false, lastMoveAt = 0, fallMs = 600, margin = 30;
  let joinBlockedUntil = 0;
  let lastProgress = Date.now(), stuckResets = 0;
  let refreshing = null, extraBusy = false, wakeLockObj = null;
  const extra = { daily: 0, farm: 0, tasks: 0, wheel: 0 };
  const taskTried = {};
  const noteAt = {};
  const stats = { moves: 0, bombs: 0, points: 0, best: 0, joins: 0, claims: 0, refreshes: 0, errors: 0, startedAt: 0 };

  function now() { return Date.now(); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function uuid() { return (crypto.randomUUID && crypto.randomUUID()) || (now() + "-" + Math.random()); }

  function log() {
    var m = Array.prototype.slice.call(arguments).map(String).join(" ");
    if (cfg.log) console.log(TAG, m);
    uiLog(m);
  }
  function warn() {
    var m = Array.prototype.slice.call(arguments).map(String).join(" ");
    console.warn(TAG, m);
    lastError = m; stats.errors++;
    uiLog("! " + m, true);
  }
  function note(msg) { // не спамить одинаковыми сообщениями
    if (noteAt[msg] && now() - noteAt[msg] < 20000) return;
    noteAt[msg] = now(); log(msg);
  }

  // ---------- токен / сессия ----------
  function readStoredSession() {
    var stores = [];
    try { stores.push(localStorage); } catch (e) {}
    try { stores.push(sessionStorage); } catch (e) {}
    for (var si = 0; si < stores.length; si++) {
      try {
        var raw = stores[si].getItem("faro:session");
        if (!raw) continue;
        var obj = JSON.parse(raw);
        if (obj && typeof obj.token === "string" && obj.token.length >= 32) return obj.token;
      } catch (e) {}
    }
    return null;
  }
  function isDead(t) { return deadToken && t && (t === deadToken || ("Bearer " + t) === deadToken || t === ("Bearer " + deadToken)); }
  function ensureToken() {
    if (token && !isDead(token)) return token;
    token = null;
    var t = readStoredSession();
    if (t && !isDead(t)) { token = t; log("токен из storage"); }
    return token;
  }
  function authHeaders() {
    var t = ensureToken();
    if (!t) return null;
    return {
      Authorization: t.indexOf("Bearer ") === 0 ? t : "Bearer " + t,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Faro-Precision": "4",
    };
  }

  var _fetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    try {
      var h = (init && init.headers) || (input && input.headers);
      if (h) {
        var auth = (typeof h.get === "function" && (h.get("Authorization") || h.get("authorization"))) || h.Authorization || h.authorization;
        if (auth && String(auth).indexOf("Bearer ") === 0 && !isDead(String(auth))) token = String(auth);
      }
    } catch (e) {}
    var res = await _fetch(input, init);
    if (/\/(?:api\/)?v1\/harvest(\?|$|\/?$)/.test(url) && !/\/moves|\/invoice|\/shop|\/ad-|\/orders|\/discovery/.test(url)) {
      try {
        var data = await res.clone().json();
        if (data && (data.entry || data.round)) {
          lastHarvest = data;
          if (cfg.enabled && !busy) schedule(400);
        }
      } catch (e) {}
    }
    return res;
  };

  async function refreshSession() {
    if (refreshing) return refreshing;
    refreshing = (async function () {
      var tg = window.Telegram && window.Telegram.WebApp;
      var init = tg && tg.initData;
      if (init) {
        try {
          var r = await _fetch("/api/auth/telegram", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ initData: init }),
          });
          if (r.ok) {
            var d = await r.json();
            if (d && d.token) {
              token = "Bearer " + d.token; deadToken = null;
              try { localStorage.setItem("faro:session", JSON.stringify({ token: d.token, mode: d.mode || "TELEGRAM" })); } catch (e) {}
              stats.refreshes++; log("сессия обновлена");
              return true;
            }
          } else { warn("auth/telegram " + r.status); }
        } catch (e) { warn("auth: " + e); }
      }
      // запасной путь: пусть приложение само перелогинится
      try { window.dispatchEvent(new Event("faro:unauthorized")); } catch (e) {}
      for (var i = 0; i < 8; i++) {
        await sleep(1000);
        var t = readStoredSession();
        if (t && !isDead(t)) { token = t; stats.refreshes++; log("сессия обновлена приложением"); return true; }
      }
      warn("не удалось обновить сессию");
      return false;
    })().finally(function () { refreshing = null; });
    return refreshing;
  }

  // универсальный вызов API (с авто-обновлением сессии при 401)
  async function call(method, path, body, isRetry) {
    var h = authHeaders();
    if (!h) {
      if (cfg.autoSession && !isRetry && (await refreshSession())) return call(method, path, body, true);
      return { ok: false, status: 0, text: "no token" };
    }
    try {
      var res = await _fetch("/api" + path, {
        method: method, headers: h, cache: "no-store",
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401) {
        deadToken = h.Authorization; token = null;
        if (cfg.autoSession && !isRetry && (await refreshSession())) return call(method, path, body, true);
        return { ok: false, status: 401, text: "401" };
      }
      var text = await res.text();
      var data = null; try { data = JSON.parse(text); } catch (e) {}
      return { ok: res.ok, status: res.status, data: data, text: text };
    } catch (e) {
      return { ok: false, status: 0, text: String(e) };
    }
  }

  // ---------- логика поля ----------
  function neighbors(i, diagonal) {
    var r = Math.floor(i / 6), c = i % 6, out = [];
    for (var dr = -1; dr <= 1; dr++) {
      for (var dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        if (!diagonal && Math.abs(dr) + Math.abs(dc) !== 1) continue;
        var nr = r + dr, nc = c + dc;
        if (nr < 0 || nr > 5 || nc < 0 || nc > 5) continue;
        out.push(nr * 6 + nc);
      }
    }
    return out;
  }

  function findPaths(board, minChain, diagonal) {
    var results = [], seenKey = {};
    function keyOf(p) { return p.slice().sort(function (a, b) { return a - b; }).join(","); }
    function dfs(path, type, used) {
      if (path.length >= minChain) {
        var k = keyOf(path);
        if (!seenKey[k]) { seenKey[k] = 1; results.push({ tiles: path.slice(), type: type, len: path.length, hasCoin: type === 3 }); }
      }
      if (path.length >= 12) return;
      var nbs = neighbors(path[path.length - 1], diagonal);
      for (var i = 0; i < nbs.length; i++) {
        var ni = nbs[i];
        if (used[ni] || board[ni] !== type || board[ni] === 5) continue;
        used[ni] = 1; path.push(ni);
        dfs(path, type, used);
        path.pop(); used[ni] = 0;
      }
    }
    for (var s = 0; s < 36; s++) {
      var t = board[s];
      if (t == null || t < 0 || t === 5) continue;
      var used = new Uint8Array(36); used[s] = 1;
      dfs([s], t, used);
    }
    results.sort(function (a, b) { return b.len - a.len; });
    var filtered = [], covered = {};
    for (var ri = 0; ri < results.length; ri++) {
      var p = results[ri];
      var all = p.tiles.every(function (x) { return covered[p.type + ":" + x]; });
      if (all && p.len < 8) continue;
      filtered.push(p);
      for (var ti = 0; ti < p.tiles.length; ti++) covered[p.type + ":" + p.tiles[ti]] = 1;
      if (filtered.length >= 40) break;
    }
    return filtered;
  }

  function rank(paths) {
    return paths.slice().sort(function (a, b) {
      if (cfg.preferCoins && a.hasCoin !== b.hasCoin) return a.hasCoin ? -1 : 1;
      if (cfg.preferLong && a.len !== b.len) return b.len - a.len;
      return 0;
    });
  }

  // ---------- Harvest API ----------
  async function getState() {
    var r = await call("GET", "/v1/harvest");
    if (!r.ok || !r.data) { warn("GET harvest " + r.status); return null; }
    lastHarvest = r.data;
    return r.data;
  }

  var lastMoveStatus = 0, lastMoveText = "";
  async function submitMove(roundId, sequence, kind, tiles) {
    var r = await call("POST", "/v1/harvest/" + roundId + "/moves", { requestId: uuid(), sequence: sequence, kind: kind, tiles: tiles });
    lastMoveStatus = r.status; lastMoveText = String(r.text || "");
    if (!r.ok) {
      waitHit = lastMoveText.indexOf("WAIT_FOR_THE_TILES") >= 0;
      if (!waitHit) warn("move " + r.status + " " + lastMoveText.slice(0, 140));
      return null;
    }
    return r.data;
  }

  // ждём анимацию фишек (fallMilliseconds) и повторяем при "WAIT_FOR_THE_TILES"
  async function sendMove(roundId, sequence, kind, tiles) {
    for (var attempt = 0; attempt < 5; attempt++) {
      var need = lastMoveAt + fallMs + margin - now();
      if (need > 0) await sleep(need);
      waitHit = false;
      var r = await submitMove(roundId, sequence, kind, tiles);
      if (r) {
        lastMoveAt = now() + (kind === "BOMB" ? 250 : 0);
        if (margin > 30 && Math.random() < 0.1) margin -= 5;
        return r;
      }
      if (!waitHit) return null;
      margin = Math.min(margin + 40, 400);
      lastMoveAt = now() - fallMs;
    }
    return null;
  }

  async function joinRound(state) {
    var helpers = [];
    if (cfg.useDouble && Number(state.doublePointsAvailable) > 0) helpers.push("DOUBLE_POINTS");
    var r = await call("POST", "/v1/harvest/" + state.round.id + "/join", helpers.length ? { helpers: helpers } : {});
    if (r.ok && r.data && r.data.entry) {
      lastHarvest = Object.assign({}, state, { entry: r.data.entry });
      stats.joins++; lastProgress = now(); failStreak = 0;
      log("вошёл в раунд" + (helpers.length ? " (x2 очки)" : ""));
      return true;
    }
    var t = String(r.text || "").toUpperCase();
    if (/TICKET|INSUFFICIENT|NOT_ENOUGH|COINS/.test(t)) {
      joinBlockedUntil = now() + 120000;
      warn("нет билетов/монет для входа — пауза 2 мин");
    } else {
      joinBlockedUntil = now() + 4000;
      note("join " + r.status + " " + t.slice(0, 80));
    }
    lastHarvest = null;
    return false;
  }

  function schedule(ms) {
    if (timer) clearTimeout(timer);
    if (stopFlag || !cfg.enabled) return;
    timer = setTimeout(function () { playOnce().catch(function (e) { warn(e); }); }, ms);
  }

  var BLOCKED = ["CLOSED", "ENDED", "FINISHED", "FINAL", "BREAK", "WAITING", "FULL", "CANCELLED", "PAUSED", "PREPARING"];

  async function playOnce() {
    if (busy || stopFlag || !cfg.enabled) return;
    busy = true; updateUI();
    var outcome = "idle";
    try {
      var state = lastHarvest;
      if (!state || !state.round) state = await getState();
      if (!state || !state.round) { outcome = "error"; return; }

      var round = state.round, entry = state.entry;
      var st = String(round.status || "").toUpperCase();
      if (round.config && round.config.fallMilliseconds) fallMs = round.config.fallMilliseconds;
      if (BLOCKED.indexOf(st) >= 0) {
        note("раунд: " + st + " — жду новый");
        lastHarvest = null; outcome = "idle"; return;
      }

      if (!entry) {
        if (!cfg.autoJoin) { note("не в раунде (авто-раунды выкл)"); outcome = "idle"; return; }
        if (now() < joinBlockedUntil) { outcome = "idle"; return; }
        outcome = (await joinRound(state)) ? "moved" : "idle";
        return;
      }

      var board = entry.board;
      if (!Array.isArray(board) || board.length < 36) { warn("плохой board len=" + (board && board.length)); lastHarvest = null; outcome = "error"; return; }

      var conf = round.config || {};
      if (conf.minimumChain) cfg.minChain = conf.minimumChain;
      if (typeof conf.diagonal === "boolean") cfg.diagonal = conf.diagonal;

      // бомба
      if (cfg.useBombs) {
        var bi = board.indexOf(5);
        if (bi >= 0) {
          await sleep(rand(cfg.thinkMin, cfg.thinkMax));
          var br = await sendMove(round.id, entry.sequence, "BOMB", [bi]);
          if (br) { onMoveOk(state, br, true); outcome = "moved"; return; }
          lastHarvest = null;
        }
      }

      var paths = rank(findPaths(board, cfg.minChain, cfg.diagonal));
      if (!paths.length) {
        paths = rank(findPaths(board, cfg.minChain, !cfg.diagonal));
        if (paths.length) { cfg.diagonal = !cfg.diagonal; log("diagonal=" + cfg.diagonal); }
      }
      if (!paths.length) { note("ходов нет"); lastHarvest = null; outcome = "idle"; return; }

      var result = null;
      for (var pi = 0; pi < paths.length && pi < 5; pi++) {
        var best = paths[pi];
        await sleep(rand(cfg.thinkMin, cfg.thinkMax));
        if (pi > 0) {
          var fresh = await getState();
          if (!fresh || !fresh.entry) break;
          state = fresh; entry = fresh.entry; round = fresh.round; board = entry.board;
          var ok = best.tiles.every(function (ti, idx) {
            if (board[ti] !== best.type) return false;
            return idx === 0 || neighbors(best.tiles[idx - 1], cfg.diagonal).indexOf(ti) >= 0;
          });
          if (!ok) continue;
        }
        result = await sendMove(round.id, entry.sequence, "COLLECT", best.tiles.slice());
        if (result) break;
        lastHarvest = null;
        if (/ROUND|ENDED|CLOSED|FINISH|EXPIRED/i.test(lastMoveText)) break;
      }

      if (result) { onMoveOk(state, result, false); outcome = "moved"; }
      else {
        failStreak++;
        outcome = failStreak >= 3 ? "idle" : "error";
        if (failStreak === 3) note("ходы не проходят — проверяю раунд");
      }
    } finally {
      busy = false; updateUI();
      if (cfg.enabled && !stopFlag) {
        if (outcome === "moved") { errStreak = 0; schedule(rand(cfg.delayMin, cfg.delayMax)); }
        else if (outcome === "idle") { schedule(3000); }
        else { errStreak++; schedule(Math.min(30000, 1000 * Math.pow(2, Math.min(errStreak, 5)))); }
      }
    }
  }

  function onMoveOk(state, res, isBomb) {
    if (res.entry) lastHarvest = Object.assign({}, state, { entry: res.entry });
    else lastHarvest = null;
    var pts = Number(res.result && res.result.points) || 0;
    stats.moves++; stats.points += pts; if (pts > stats.best) stats.best = pts;
    if (isBomb) stats.bombs++;
    failStreak = 0; errStreak = 0; lastProgress = now(); lastError = "";
    log((isBomb ? "BOMB +" : "+") + pts + "  (ходов " + stats.moves + ")");
    if (cfg.maxMoves > 0 && stats.moves >= cfg.maxMoves) { log("лимит ходов — стоп"); api.stop(); }
  }

  // ---------- доп. автоматизации ----------
  async function doDaily() {
    var r = await call("GET", "/v1/daily");
    if (!r.ok || !r.data) { extra.daily = now() + 60000; return; }
    var d = r.data;
    if (d.claimedToday || (d.policy && d.policy.config && d.policy.config.enabled === false)) { extra.daily = now() + 10 * 60000; return; }
    var c = await call("POST", "/v1/daily/claim", {});
    if (c.ok) { stats.claims++; log("daily: награда забрана"); extra.daily = now() + 10 * 60000; }
    else { note("daily " + c.status); extra.daily = now() + 5 * 60000; }
  }

  async function doFarm() {
    var r = await call("GET", "/v1/farming");
    if (!r.ok || !r.data) { extra.farm = now() + 30000; return; }
    var f = r.data, res = f.resources || {};
    var energy = Number(res.energy) || 0;
    var serverNow = res.serverTime ? Date.parse(res.serverTime) : now();
    var nextIn = Infinity;
    var stations = f.stations || [];
    for (var i = 0; i < stations.length; i++) {
      var st = stations[i];
      if (!st.ownedLevel || st.enabled === false) continue;
      if (st.autoFarm && st.autoFarm.active && Date.parse(st.autoFarm.expiresAt) > serverNow) continue;
      var s = st.activeSession;
      if (s) {
        var left = Date.parse(s.endsAt) - serverNow;
        if (left > 0) { nextIn = Math.min(nextIn, left); continue; }
        var c = await call("POST", "/v1/farming/sessions/" + s.id + "/claim", {});
        if (c.ok) { stats.claims++; log("фарм: забрал " + (s.rewardTokens != null ? s.rewardTokens : "") + " · " + (st.name || st.id)); }
        else { note("фарм claim " + c.status); continue; }
      }
      var lv = (st.levels || []).filter(function (l) { return l.level === st.ownedLevel; })[0];
      if (!lv || energy < lv.startEnergy) continue;
      var g = await call("POST", "/v1/farming/stations/" + st.id + "/start", {});
      if (g.ok) {
        energy -= lv.startEnergy;
        var dur = g.data && g.data.result && g.data.result.durationSeconds;
        nextIn = Math.min(nextIn, (dur || 120) * 1000);
        log("фарм: старт · " + (st.name || st.id));
      } else note("фарм start " + g.status);
    }
    var wait = nextIn === Infinity ? 300000 : nextIn + 3000;
    extra.farm = now() + Math.max(15000, Math.min(wait, 600000));
  }

  async function doTasks() {
    var r = await call("GET", "/v1/tasks");
    extra.tasks = now() + 10 * 60000;
    if (!r.ok || !r.data) return;
    var items = r.data.items || [], n = 0;
    for (var i = 0; i < items.length && n < 15; i++) {
      var it = items[i];
      var pr = it.progress || {};
      var kind = pr.kind || it.kind;
      if (!it.id || it.enabled === false || pr.status === "CLAIMED") continue;
      if (kind === "WATCH_AD") continue; // просмотр рекламы не подменяем
      if (taskTried[it.id] && now() - taskTried[it.id] < 30 * 60000) continue;
      if (it.ready === false) continue;
      taskTried[it.id] = now(); n++;
      var c = await call("POST", "/v1/tasks/" + it.id + "/claim", {});
      if (c.ok) { stats.claims++; log("задание: награда забрана"); }
      await sleep(300);
    }
  }

  async function doWheel() {
    var r = await call("GET", "/v1/lucky-wheel");
    extra.wheel = now() + 10 * 60000;
    if (!r.ok || !r.data) return;
    var eds = r.data.editions || [];
    for (var i = 0; i < eds.length; i++) {
      var ed = eds[i];
      if (!ed.enabled || !ed.spins || !(ed.spins.free > 0)) continue; // только бесплатные спины
      var sp = await call("POST", "/v1/lucky-wheel/" + ed.id + "/spin", { requestId: uuid(), revision: ed.revision });
      if (sp.ok) {
        var lbl = sp.data && sp.data.spin && sp.data.spin.reward && sp.data.spin.reward.label;
        stats.claims++; log("колесо: " + (lbl || "приз"));
        extra.wheel = now() + 3000; // ревизия изменилась — перечитаем
      } else note("колесо " + sp.status);
      break;
    }
  }

  async function runExtras() {
    if (extraBusy || !cfg.enabled) return;
    extraBusy = true;
    try {
      var t = now();
      if (cfg.autoDaily && t >= extra.daily) await doDaily();
      if (cfg.autoFarm && t >= extra.farm) await doFarm();
      if (cfg.autoTasks && t >= extra.tasks) await doTasks();
      if (cfg.autoWheel && t >= extra.wheel) await doWheel();
    } catch (e) { warn("extras: " + e); }
    finally { extraBusy = false; }
  }

  // ---------- watchdog / wake lock ----------
  var tick = null;
  function onTick() {
    if (!cfg.enabled) return;
    if (cfg.maxMinutes > 0 && stats.startedAt && now() - stats.startedAt >= cfg.maxMinutes * 60000) {
      log("лимит времени — стоп"); api.stop(); return;
    }
    // зависание: давно не было прогресса, а бот не занят
    if (!busy && now() - lastProgress > 90000 && cfg.autoJoin) {
      stuckResets++; lastProgress = now(); lastHarvest = null;
      note("watchdog: сбрасываю состояние (" + stuckResets + ")");
      schedule(100);
      if (cfg.reloadOnStuck && stuckResets >= 5) { try { location.reload(); } catch (e) {} }
    }
    if (busy && now() - lastProgress > 120000) { busy = false; lastHarvest = null; schedule(100); }
    runExtras();
    updateUI();
  }

  async function lockScreen() {
    if (!cfg.wakeLock || wakeLockObj || !navigator.wakeLock) return;
    try { wakeLockObj = await navigator.wakeLock.request("screen"); wakeLockObj.addEventListener("release", function () { wakeLockObj = null; }); } catch (e) {}
  }
  function unlockScreen() { try { if (wakeLockObj) wakeLockObj.release(); } catch (e) {} wakeLockObj = null; }
  document.addEventListener("visibilitychange", function () { if (cfg.enabled && document.visibilityState === "visible") lockScreen(); });

  // ---------- реклама: нажимаем кнопку «Watch ad» в задании ----------
  // Ничего не отправляем на сервер сами: показ и засчитывание делает приложение.
  var adsInfo = "открой задание с рекламой";
  var adsClickedAt = 0, adsLastClick = 0, adsProgAtClick = 0, adsNoProgress = 0;
  function adsRoot() { return document.querySelector(".watch-ad-task"); }
  function adsProgress() {
    var root = adsRoot(); if (!root) return null;
    var strong = root.querySelector(".task-requirement strong") || root;
    var m = /(\d+)\s*\/\s*(\d+)/.exec(strong.textContent || "");
    return m ? { done: +m[1], total: +m[2] } : null;
  }
  function adsTick() {
    if (!cfg.autoAds) return;
    var root = adsRoot();
    var btn = root && root.querySelector("button.primary, button.button");
    var p = adsProgress();
    if (!root || !btn || !p) { adsInfo = "открой задание с рекламой"; return; }
    if (p.done >= p.total) { adsInfo = "готово " + p.done + "/" + p.total; cfg.autoAds = false; saveCfg(); log("реклама: " + adsInfo); return; }
    if (document.visibilityState !== "visible") { adsInfo = "жду экран · " + p.done + "/" + p.total; return; }
    if (!wakeLockObj && cfg.wakeLock) lockScreen();
    if (adsClickedAt) {
      if (p.done > adsProgAtClick) { adsNoProgress = 0; adsClickedAt = 0; }
      else if (now() - adsClickedAt > 90000) {
        adsNoProgress++; adsClickedAt = 0;
        if (adsNoProgress >= 3) { adsInfo = "не засчитывается — стоп"; cfg.autoAds = false; saveCfg(); warn("реклама не засчитывается — выключил"); return; }
      } else { adsInfo = "идёт реклама… " + p.done + "/" + p.total; return; }
    }
    if (btn.disabled || btn.getAttribute("aria-busy") === "true") { adsInfo = "кулдаун · " + p.done + "/" + p.total; return; }
    if (now() - adsLastClick < 4000) return;
    adsLastClick = now(); adsClickedAt = now(); adsProgAtClick = p.done;
    adsInfo = "запускаю · " + p.done + "/" + p.total;
    btn.click();
  }
  setInterval(adsTick, 1000);

  // ---------- панель ----------
  var panel, logEl, statusEl, statsEl, bodyEl, bubbleEl, startBtn, stopBtn, logWrap;
  var speedBtns = {}, toggleBtns = {};
  var ui = { collapsed: false, logOpen: false, x: null, y: null };
  try { Object.assign(ui, JSON.parse(localStorage.getItem("faroBot:ui") || "{}")); } catch (e) {}
  function saveUi() { try { localStorage.setItem("faroBot:ui", JSON.stringify(ui)); } catch (e) {} }

  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(text, css, fn) {
    var b = el("button", "border:0;border-radius:8px;font:600 12px system-ui,sans-serif;padding:8px 6px;color:#fff;touch-action:manipulation;" + (css || ""), text);
    b.addEventListener("click", function (ev) { ev.stopPropagation(); fn(); });
    return b;
  }

  function ensureUI() {
    if (panel && document.body && document.body.contains(panel)) return;
    if (!document.body) return;
    panel = el("div", "position:fixed;z-index:2147483646;font:12px/1.3 system-ui,sans-serif;color:#d8f0d8;touch-action:none;");
    panel.id = "faro-bot-panel";

    bubbleEl = el("div", "width:46px;height:46px;border-radius:50%;background:rgba(16,28,22,.95);border:1px solid #3a6a4a;display:none;align-items:center;justify-content:center;font-size:22px;box-shadow:0 6px 18px rgba(0,0,0,.5);", "🌾");
    bodyEl = el("div", "width:232px;padding:10px;border-radius:14px;background:rgba(16,28,22,.95);border:1px solid #3a6a4a;box-shadow:0 8px 24px rgba(0,0,0,.5);");

    var head = el("div", "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;");
    head.appendChild(el("b", "font-size:13px;", "FaroBot " + VERSION));
    var minBtn = btn("–", "background:#345;padding:2px 10px;font-size:14px;", function () { ui.collapsed = true; saveUi(); layout(); });
    head.appendChild(minBtn);
    bodyEl.appendChild(head);

    statusEl = el("div", "font-size:12px;margin-bottom:2px;", "idle");
    statsEl = el("div", "font-size:11px;opacity:.85;margin-bottom:8px;white-space:pre-line;", "");
    bodyEl.appendChild(statusEl); bodyEl.appendChild(statsEl);

    var row = el("div", "display:flex;gap:6px;margin-bottom:8px;");
    startBtn = btn("START", "flex:1;background:#2a8;", function () { api.start(); });
    stopBtn = btn("STOP", "flex:1;background:#844;", function () { api.stop(); });
    row.appendChild(startBtn); row.appendChild(stopBtn);
    bodyEl.appendChild(row);

    var srow = el("div", "display:flex;gap:4px;margin-bottom:8px;");
    Object.keys(SPEEDS).forEach(function (k) {
      var b = btn(SPEED_LABELS[k], "flex:1;padding:6px 2px;", function () { api.speed(k); });
      speedBtns[k] = b; srow.appendChild(b);
    });
    bodyEl.appendChild(srow);

    var grid = el("div", "display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:8px;");
    TOGGLES.forEach(function (t) {
      var b = btn(t[1], "padding:6px 2px;font-size:11px;", function () { cfg[t[0]] = !cfg[t[0]]; saveCfg(); if (t[0] === "wakeLock") { cfg.wakeLock ? lockScreen() : unlockScreen(); } updateUI(); });
      toggleBtns[t[0]] = b; grid.appendChild(b);
    });
    bodyEl.appendChild(grid);

    var logBtn = btn("Лог ▾", "background:#234;width:100%;padding:4px;font-size:11px;", function () { ui.logOpen = !ui.logOpen; saveUi(); layout(); });
    bodyEl.appendChild(logBtn);
    logWrap = el("div", "display:none;margin-top:6px;");
    logEl = el("div", "font-size:10px;max-height:130px;overflow:auto;line-height:1.35;opacity:.9;");
    logWrap.appendChild(logEl);
    bodyEl.appendChild(logWrap);

    panel.appendChild(bubbleEl); panel.appendChild(bodyEl);
    document.body.appendChild(panel);

    // перетаскивание
    var drag = null, moved = false;
    function down(ev) {
      var p = ev.touches ? ev.touches[0] : ev;
      var r = panel.getBoundingClientRect();
      drag = { dx: p.clientX - r.left, dy: p.clientY - r.top }; moved = false;
    }
    function move(ev) {
      if (!drag) return;
      var p = ev.touches ? ev.touches[0] : ev;
      moved = true;
      ui.x = Math.max(0, Math.min(window.innerWidth - 50, p.clientX - drag.dx));
      ui.y = Math.max(0, Math.min(window.innerHeight - 50, p.clientY - drag.dy));
      layout();
      if (ev.cancelable) ev.preventDefault();
    }
    function up() { if (drag && moved) saveUi(); drag = null; }
    head.addEventListener("touchstart", down, { passive: true });
    bubbleEl.addEventListener("touchstart", down, { passive: true });
    head.addEventListener("mousedown", down); bubbleEl.addEventListener("mousedown", down);
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("mousemove", move);
    document.addEventListener("touchend", up); document.addEventListener("mouseup", up);
    bubbleEl.addEventListener("click", function () { if (moved) return; ui.collapsed = false; saveUi(); layout(); });

    layout(); updateUI();
  }

  function layout() {
    if (!panel) return;
    if (ui.x == null) { panel.style.right = "8px"; panel.style.bottom = "90px"; panel.style.left = ""; panel.style.top = ""; }
    else { panel.style.left = ui.x + "px"; panel.style.top = ui.y + "px"; panel.style.right = ""; panel.style.bottom = ""; }
    bodyEl.style.display = ui.collapsed ? "none" : "block";
    bubbleEl.style.display = ui.collapsed ? "flex" : "none";
    logWrap.style.display = ui.logOpen ? "block" : "none";
  }

  function uiLog(msg, isErr) {
    try {
      ensureUI();
      if (!logEl) return;
      var line = el("div", isErr ? "color:#f99;" : "", new Date().toTimeString().slice(0, 8) + " " + msg);
      logEl.insertBefore(line, logEl.firstChild);
      while (logEl.children.length > 40) logEl.removeChild(logEl.lastChild);
    } catch (e) {}
  }

  function fmtTime(ms) {
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    return (m >= 60 ? Math.floor(m / 60) + "ч " : "") + (m % 60) + "м " + (s % 60) + "с";
  }

  function updateUI() {
    try {
      ensureUI();
      if (!statusEl) return;
      var t = ensureToken();
      statusEl.textContent = cfg.enabled ? (busy ? "▶ ходит…" : "▶ работаю") + (errStreak > 1 ? " · ошибки×" + errStreak : "") : "■ стоп · токен " + (t ? "ok" : "нет");
      statusEl.style.color = cfg.enabled ? "#9f9" : "#d8f0d8";
      var el_ = stats.startedAt ? now() - stats.startedAt : 0;
      var ppm = el_ > 30000 ? Math.round(stats.points / (el_ / 60000)) : 0;
      statsEl.textContent = "ходов " + stats.moves + " · бомб " + stats.bombs + " · очки " + stats.points +
        "\n" + ppm + "/мин · лучший +" + stats.best + " · " + (stats.startedAt ? fmtTime(el_) : "—") +
        "\nзаходов " + stats.joins + " · клеймов " + stats.claims + " · сессий↻ " + stats.refreshes +
        (cfg.autoAds ? "\nреклама: " + adsInfo : "");
      startBtn.style.opacity = cfg.enabled ? ".45" : "1";
      stopBtn.style.opacity = cfg.enabled ? "1" : ".45";
      Object.keys(speedBtns).forEach(function (k) { speedBtns[k].style.background = cfg.speed === k ? "#2a8" : "#345"; });
      TOGGLES.forEach(function (tg) { toggleBtns[tg[0]].style.background = cfg[tg[0]] ? "#2a6a4a" : "#3a3a3a"; toggleBtns[tg[0]].style.opacity = cfg[tg[0]] ? "1" : ".7"; });
    } catch (e) {}
  }

  // ---------- публичный API ----------
  var api = {
    version: VERSION,
    cfg: cfg,
    stats: stats,
    start: function () {
      ensureUI();
      stopFlag = false; cfg.enabled = true;
      stats.moves = 0; stats.bombs = 0; stats.points = 0; stats.best = 0; stats.startedAt = now();
      failStreak = 0; errStreak = 0; lastProgress = now(); stuckResets = 0;
      extra.daily = extra.farm = extra.tasks = extra.wheel = 0;
      try { localStorage.setItem("faroBot:run", "1"); } catch (e) {}
      ensureToken(); lockScreen();
      if (!tick) tick = setInterval(onTick, 15000);
      log("START v" + VERSION + " · скорость: " + cfg.speed);
      updateUI();
      schedule(200);
      runExtras();
      return "started";
    },
    stop: function () {
      stopFlag = true; cfg.enabled = false;
      if (timer) clearTimeout(timer); timer = null;
      busy = false;
      try { localStorage.setItem("faroBot:run", "0"); } catch (e) {}
      unlockScreen();
      log("STOP");
      updateUI();
      return "stopped";
    },
    status: function () {
      return {
        version: VERSION, enabled: cfg.enabled, busy: busy, speed: cfg.speed, hasToken: !!ensureToken(),
        round: lastHarvest && lastHarvest.round && lastHarvest.round.status,
        score: lastHarvest && lastHarvest.entry && lastHarvest.entry.score,
        ads: { on: cfg.autoAds, info: adsInfo, progress: adsProgress() },
        stats: stats, margin: margin, fallMs: fallMs, lastError: lastError,
      };
    },
    speed: function (mode) {
      if (!SPEEDS[mode]) return "safe | normal | fast";
      cfg.speed = mode; Object.assign(cfg, SPEEDS[mode]); saveCfg(); updateUI();
      return mode;
    },
    set: function (opts) { Object.assign(cfg, opts); saveCfg(); updateUI(); return cfg; },
    extras: function () { extra.daily = extra.farm = extra.tasks = extra.wheel = 0; var was = cfg.enabled; cfg.enabled = true; return runExtras().then(function () { cfg.enabled = was; }); },
    refreshSession: refreshSession,
    show: function () { ui.collapsed = false; saveUi(); layout(); },
    hide: function () { ui.collapsed = true; saveUi(); layout(); },
  };

  window.__FARO_BOT__ = api;
  ensureUI();
  setInterval(function () { ensureUI(); updateUI(); }, 2000);
  console.log("%c" + TAG + " v" + VERSION + " готов — панель справа, START на ней", "color:#6f6;font-weight:bold");

  // автопродолжение, если скрипт запущен заново (после перезагрузки страницы)
  try {
    if (cfg.autoResume && localStorage.getItem("faroBot:run") === "1") {
      setTimeout(function () { if (!cfg.enabled) { log("автопродолжение"); api.start(); } }, 2500);
    }
  } catch (e) {}
})();
