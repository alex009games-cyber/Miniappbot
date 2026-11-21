/**
 * Faro Harvest Tournament Auto-Bot v1.4.0
 *
 * Как пользоваться:
 * 1. Открой Faro → Турнир урожая
 * 2. Вставь скрипт в консоль (eruda / Injector)
 * 3. Нажми START на зелёной панели
 *
 *   __FARO_BOT__.start() / .stop() / .status()
 */
(function () {
  "use strict";
  if (window.__FARO_BOT__ && window.__FARO_BOT__.version === "1.4.0") {
    console.log("[FaroBot] already v1.4.0");
    return;
  }

  const VERSION = "1.4.0";
  const TAG = "[FaroBot]";

  const cfg = {
    enabled: false,
    minChain: 3,
    useBombs: true, // жать на бомбы (tile type 5) как только появились
    preferCoins: true,
    preferLong: true,
    delayMin: 120,
    delayMax: 300,
    thinkMin: 20,
    thinkMax: 80,
    maxMoves: 1000,
    log: true,
    diagonal: true, // overridden from round.config.diagonal
  };

  let token = null;
  let lastHarvest = null;
  let busy = false;
  let movesDone = 0;
  let stopFlag = false;
  let timer = null;
  let lastError = "";

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

  function readStoredSession() {
    var keys = ["faro:session"];
    var stores = [];
    try { stores.push(localStorage); } catch (e) {}
    try { stores.push(sessionStorage); } catch (e) {}
    var si, ki, store, key, raw, obj;
    for (si = 0; si < stores.length; si++) {
      store = stores[si];
      for (ki = 0; ki < keys.length; ki++) {
        key = keys[ki];
        try {
          raw = store.getItem(key);
          if (!raw) continue;
          obj = JSON.parse(raw);
          if (obj && typeof obj.token === "string" && obj.token.length >= 32) return obj.token;
        } catch (e) {}
      }
    }
    for (si = 0; si < stores.length; si++) {
      store = stores[si];
      try {
        for (ki = 0; ki < store.length; ki++) {
          key = store.key(ki);
          if (!key || !/faro|session|auth|token/i.test(key)) continue;
          raw = store.getItem(key);
          if (!raw) continue;
          try {
            obj = JSON.parse(raw);
            if (obj && obj.token && String(obj.token).length >= 32) return String(obj.token);
          } catch (e) {
            if (/^[a-f0-9]{64}$/i.test(raw)) return raw;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  function ensureToken() {
    if (token) return token;
    token = readStoredSession();
    if (token) log("token from storage");
    return token;
  }

  var _fetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    try {
      var h = (init && init.headers) || (input && input.headers);
      if (h) {
        var auth =
          (typeof h.get === "function" && (h.get("Authorization") || h.get("authorization"))) ||
          h.Authorization || h.authorization;
        if (auth && String(auth).indexOf("Bearer ") === 0) token = String(auth);
      }
    } catch (e) {}

    var res = await _fetch(input, init);

    if (
      /\/(?:api\/)?v1\/harvest(\?|$|\/?$)/.test(url) &&
      !/\/moves|\/invoice|\/shop|\/ad-|\/orders|\/discovery/.test(url)
    ) {
      try {
        var data = await res.clone().json();
        if (data && (data.entry || data.round)) {
          lastHarvest = data;
          log("state ok seq=" + (data.entry && data.entry.sequence));
          if (cfg.enabled && !busy) schedule(400);
        }
      } catch (e) {}
    }
    return res;
  };

  // adjacency: orthogonal always; diagonal if cfg.diagonal
  function neighbors(i, diagonal) {
    var r = Math.floor(i / 6), c = i % 6;
    var out = [];
    var drs = diagonal ? [-1, 0, 1] : [-1, 0, 1];
    var dcs = diagonal ? [-1, 0, 1] : [-1, 0, 1];
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

  /**
   * Build ordered simple paths of same type (path = each step adjacent).
   * Returns array of { tiles: number[], type, len, hasCoin }
   */
  function findPaths(board, minChain, diagonal) {
    var results = [];
    var seenKey = {};

    function keyOf(path) {
      // order-independent key to avoid duplicates of same set
      return path.slice().sort(function (a, b) { return a - b; }).join(",");
    }

    // DFS from each start, build simple paths
    function dfs(path, type, used) {
      if (path.length >= minChain) {
        var k = keyOf(path);
        if (!seenKey[k]) {
          seenKey[k] = 1;
          results.push({
            tiles: path.slice(),
            type: type,
            len: path.length,
            hasCoin: type === 3,
          });
        }
      }
      if (path.length >= 12) return; // safety
      var last = path[path.length - 1];
      var nbs = neighbors(last, diagonal);
      for (var i = 0; i < nbs.length; i++) {
        var ni = nbs[i];
        if (used[ni]) continue;
        if (board[ni] !== type) continue;
        if (board[ni] === 5) continue; // bomb
        used[ni] = 1;
        path.push(ni);
        dfs(path, type, used);
        path.pop();
        used[ni] = 0;
      }
    }

    for (var start = 0; start < 36; start++) {
      var type = board[start];
      if (type == null || type < 0 || type === 5) continue;
      var used = new Uint8Array(36);
      used[start] = 1;
      dfs([start], type, used);
    }

    // keep only maximal-ish: prefer longer; drop paths that are strict subsets of a longer one we already have
    results.sort(function (a, b) { return b.len - a.len; });
    var filtered = [];
    var covered = {};
    for (var ri = 0; ri < results.length; ri++) {
      var p = results[ri];
      var k = keyOf(p.tiles);
      // skip if all tiles already covered by a longer path of same type
      var allCovered = p.tiles.every(function (t) { return covered[p.type + ":" + t]; });
      if (allCovered && p.len < 8) continue;
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

  function authHeaders() {
    var t = ensureToken();
    if (!t) return null;
    var bearer = t.indexOf("Bearer ") === 0 ? t : "Bearer " + t;
    return {
      Authorization: bearer,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Faro-Precision": "4",
    };
  }

  async function getState() {
    var h = authHeaders();
    if (!h) {
      warn("нет токена — открой Faro и Турнир урожая");
      return null;
    }
    try {
      var res = await _fetch("/api/v1/harvest", { cache: "no-store", headers: h });
      if (res.status === 401) {
        token = null;
        warn("401 — токен устарел, перезайди");
        return null;
      }
      if (!res.ok) {
        warn("GET /api/v1/harvest " + res.status);
        return null;
      }
      var data = await res.json();
      lastHarvest = data;
      return data;
    } catch (e) {
      warn("getState: " + e);
      return null;
    }
  }

  async function submitMove(roundId, sequence, kind, tiles) {
    var h = authHeaders();
    if (!h) return null;
    var body = {
      requestId: (crypto.randomUUID && crypto.randomUUID()) || (Date.now() + "-" + Math.random()),
      sequence: sequence,
      kind: kind,
      tiles: tiles,
    };
    try {
      var res = await _fetch("/api/v1/harvest/" + roundId + "/moves", {
        method: "POST",
        headers: h,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        var txt = await res.text().catch(function () { return ""; });
        warn("move " + res.status + " " + String(txt).slice(0, 140));
        return null;
      }
      return await res.json();
    } catch (e) {
      warn("submit: " + e);
      return null;
    }
  }

  function rand(a, b) { return a + Math.random() * (b - a); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function schedule(ms) {
    if (timer) clearTimeout(timer);
    if (stopFlag || !cfg.enabled) return;
    timer = setTimeout(function () {
      playOnce().catch(function (e) { warn(e); });
    }, ms);
  }

  async function playOnce() {
    if (busy || stopFlag || !cfg.enabled) return;
    busy = true;
    updateUI();
    try {
      var state = lastHarvest;
      if (!state || !state.entry || !state.round) state = await getState();
      if (!state || !state.entry || !state.round) {
        log("нет активного раунда");
        return;
      }

      var round = state.round;
      var entry = state.entry;
      var st = String(round.status || "").toUpperCase();
      var blocked = ["CLOSED", "ENDED", "FINISHED", "BREAK", "WAITING", "FULL", "CANCELLED"];
      if (st && blocked.indexOf(st) >= 0) {
        log("раунд недоступен: " + round.status);
        return;
      }

      var board = entry.board;
      if (!Array.isArray(board) || board.length < 36) {
        warn("плохой board len=" + (board && board.length));
        return;
      }

      // --- BOMB: если на поле есть бомба, жмём её первой ---
      if (cfg.useBombs) {
        var bombIdx = board.indexOf(5);
        if (bombIdx >= 0) {
          log("бомба на клетке " + bombIdx);
          await sleep(rand(cfg.thinkMin, cfg.thinkMax));
          var bres = await submitMove(round.id, entry.sequence, "BOMB", [bombIdx]);
          if (bres) {
            if (bres.entry) lastHarvest = Object.assign({}, state, { entry: bres.entry });
            else lastHarvest = null;
            movesDone++;
            var bpts = bres.result && bres.result.points;
            log("BOMB +" + (bpts != null ? bpts : "?") + "  total=" + movesDone);
            lastError = "";
            return;
          }
          lastHarvest = null;
          log("бомба не сработала, играю цепочки");
        }
      }

      var conf = round.config || {};
      if (conf.minimumChain) cfg.minChain = conf.minimumChain;
      if (typeof conf.diagonal === "boolean") cfg.diagonal = conf.diagonal;

      var paths = rank(findPaths(board, cfg.minChain, cfg.diagonal));
      if (!paths.length) {
        // retry with opposite diagonal setting
        paths = rank(findPaths(board, cfg.minChain, !cfg.diagonal));
        if (paths.length) {
          cfg.diagonal = !cfg.diagonal;
          log("переключил diagonal=" + cfg.diagonal);
        }
      }
      if (!paths.length) {
        log("ходов нет");
        return;
      }

      // try up to 3 candidate paths if server rejects
      var tried = 0;
      var result = null;
      for (var pi = 0; pi < paths.length && pi < 5; pi++) {
        var best = paths[pi];
        log("ход #" + (movesDone + 1) + " type=" + best.type + " len=" + best.len + " path=" + best.tiles.join(","));
        await sleep(rand(cfg.thinkMin, cfg.thinkMax));

        // refresh sequence before each attempt if needed
        if (pi > 0) {
          var fresh = await getState();
          if (fresh && fresh.entry) {
            state = fresh;
            entry = fresh.entry;
            round = fresh.round;
            board = entry.board;
            // re-check path still valid
            var still = best.tiles.every(function (ti, idx) {
              if (board[ti] !== best.type) return false;
              if (idx === 0) return true;
              var prev = best.tiles[idx - 1];
              var nbs = neighbors(prev, cfg.diagonal);
              return nbs.indexOf(ti) >= 0;
            });
            if (!still) continue;
          }
        }

        result = await submitMove(round.id, entry.sequence, "COLLECT", best.tiles.slice());
        tried++;
        if (result) break;
        // if invalid combo — try next path; if sequence error — refresh
        lastHarvest = null;
      }

      if (result) {
        if (result.entry) lastHarvest = Object.assign({}, state, { entry: result.entry });
        else lastHarvest = null;
        movesDone++;
        var pts = result.result && result.result.points;
        log("OK +" + (pts != null ? pts : "?") + "  total=" + movesDone);
        lastError = "";
      } else {
        log("не удалось после " + tried + " попыток");
      }

      if (movesDone >= cfg.maxMoves) {
        log("лимит ходов, стоп");
        api.stop();
      }
    } finally {
      busy = false;
      updateUI();
      if (cfg.enabled && !stopFlag) schedule(rand(cfg.delayMin, cfg.delayMax));
    }
  }

  var panel, logEl, statusEl;
  function ensureUI() {
    if (panel && document.body.contains(panel)) return;
    panel = document.createElement("div");
    panel.id = "faro-bot-panel";
    panel.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px">FaroBot ' + VERSION + "</div>" +
      '<div id="faro-bot-status" style="font-size:11px;opacity:.9;margin-bottom:8px">idle</div>' +
      '<div style="display:flex;gap:6px;margin-bottom:8px">' +
      '<button id="faro-bot-start" style="flex:1;padding:6px;border:0;border-radius:8px;background:#2a8;color:#fff;font-weight:700">START</button>' +
      '<button id="faro-bot-stop" style="flex:1;padding:6px;border:0;border-radius:8px;background:#844;color:#fff;font-weight:700">STOP</button>' +
      "</div>" +
      '<div id="faro-bot-log" style="font-size:10px;max-height:120px;overflow:auto;line-height:1.35;opacity:.85"></div>';
    panel.style.cssText =
      "position:fixed;right:8px;bottom:80px;z-index:2147483646;width:190px;padding:10px;" +
      "border-radius:12px;background:rgba(16,28,22,.92);color:#d8f0d8;" +
      "font:12px/1.3 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);border:1px solid #3a6a4a;";
    document.body.appendChild(panel);
    logEl = panel.querySelector("#faro-bot-log");
    statusEl = panel.querySelector("#faro-bot-status");
    panel.querySelector("#faro-bot-start").onclick = function () { api.start(); };
    panel.querySelector("#faro-bot-stop").onclick = function () { api.stop(); };
  }

  function uiLog(msg, isErr) {
    ensureUI();
    if (!logEl) return;
    var line = document.createElement("div");
    line.textContent = msg;
    if (isErr) line.style.color = "#f99";
    logEl.insertBefore(line, logEl.firstChild);
    while (logEl.children.length > 40) logEl.removeChild(logEl.lastChild);
  }

  function updateUI() {
    ensureUI();
    if (!statusEl) return;
    var t = ensureToken();
    statusEl.textContent = cfg.enabled
      ? (busy ? "ходит..." : "работаю · moves=" + movesDone)
      : "стоп · token=" + (t ? "ok" : "нет");
  }

  var api = {
    version: VERSION,
    cfg: cfg,
    start: function () {
      ensureUI();
      stopFlag = false;
      cfg.enabled = true;
      movesDone = 0;
      ensureToken();
      log("START v" + VERSION);
      updateUI();
      schedule(300);
      getState().then(function () { schedule(200); });
      return "started";
    },
    stop: function () {
      stopFlag = true;
      cfg.enabled = false;
      if (timer) clearTimeout(timer);
      timer = null;
      busy = false;
      log("STOP");
      updateUI();
      return "stopped";
    },
    status: function () {
      return {
        version: VERSION,
        enabled: cfg.enabled,
        busy: busy,
        movesDone: movesDone,
        hasToken: !!ensureToken(),
        hasState: !!(lastHarvest && lastHarvest.entry),
        score: lastHarvest && lastHarvest.entry && lastHarvest.entry.score,
        diagonal: cfg.diagonal,
        minChain: cfg.minChain,
        lastError: lastError,
      };
    },
    forceMove: async function () {
      lastHarvest = null;
      return playOnce();
    },
    speed: function (mode) {
      var P = {
        safe:  { delayMin: 800, delayMax: 1600, thinkMin: 250, thinkMax: 700 },
        fast:  { delayMin: 120, delayMax: 300,  thinkMin: 20,  thinkMax: 80 },
        turbo: { delayMin: 0,   delayMax: 40,   thinkMin: 0,   thinkMax: 10 },
      };
      if (!P[mode]) return "safe | fast | turbo";
      Object.assign(cfg, P[mode]);
      return mode;
    },
    set: function (opts) {
      Object.assign(cfg, opts);
      return cfg;
    },
  };

  window.__FARO_BOT__ = api;
  ensureUI();
  updateUI();
  ensureToken();
  console.log(
    "%c" + TAG + " v" + VERSION + " ready — START на панели или __FARO_BOT__.start()",
    "color:#6f6;font-weight:bold"
  );
})();
