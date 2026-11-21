/**
 * Faro Harvest Tournament Auto-Bot v1.1
 *
 * Как пользоваться:
 * 1. Открой Faro → Турнир урожая (чтобы поле загрузилось)
 * 2. Вставь этот скрипт в консоль (eruda / MiniApp Injector / DevTools)
 * 3. Появится зелёная панель справа — нажми START
 *
 * Или в консоли:
 *   __FARO_BOT__.start()
 *   __FARO_BOT__.stop()
 *   __FARO_BOT__.status()
 */
(function () {
  "use strict";
  if (window.__FARO_BOT__ && window.__FARO_BOT__.version === "1.1.1") {
    console.log("[FaroBot] already v1.1");
    return;
  }

  const VERSION = "1.1.1";
  const TAG = "[FaroBot]";

  const cfg = {
    enabled: false,
    minChain: 3,
    preferCoins: true,
    preferLong: true,
    delayMin: 800,
    delayMax: 1600,
    thinkMin: 250,
    thinkMax: 700,
    maxMoves: 300,
    log: true,
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
          if (obj && typeof obj.token === "string" && obj.token.length >= 32) {
            return obj.token;
          }
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
          h.Authorization ||
          h.authorization;
        if (auth && String(auth).indexOf("Bearer ") === 0) {
          token = String(auth);
        }
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

  var DIRS = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1],          [0, 1],
    [1, -1],  [1, 0], [1, 1],
  ];
  function idx(r, c) { return r * 6 + c; }
  function rc(i) { return [Math.floor(i / 6), i % 6]; }
  function inB(r, c) { return r >= 0 && r < 6 && c >= 0 && c < 6; }

  function findGroups(board) {
    var vis = new Uint8Array(36);
    var groups = [];
    for (var s = 0; s < 36; s++) {
      if (vis[s]) continue;
      var type = board[s];
      if (type == null || type < 0) continue;
      var stack = [s];
      var cells = [];
      vis[s] = 1;
      while (stack.length) {
        var cur = stack.pop();
        cells.push(cur);
        var pair = rc(cur);
        var r = pair[0], c = pair[1];
        for (var di = 0; di < DIRS.length; di++) {
          var nr = r + DIRS[di][0], nc = c + DIRS[di][1];
          if (!inB(nr, nc)) continue;
          var ni = idx(nr, nc);
          if (vis[ni] || board[ni] !== type) continue;
          vis[ni] = 1;
          stack.push(ni);
        }
      }
      if (cells.length >= cfg.minChain) {
        groups.push({ tiles: cells, type: type, len: cells.length, hasCoin: type === 3 });
      }
    }
    return groups;
  }

  function rank(groups) {
    return groups.slice().sort(function (a, b) {
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
      warn("нет токена — открой Faro и зайди в Турнир урожая");
      return null;
    }
    try {
      var res = await _fetch("/api/v1/harvest", { cache: "no-store", headers: h });
      if (res.status === 401) {
        token = null;
        warn("401 — токен устарел, перезайди в Faro");
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
        warn("move " + res.status + " " + String(txt).slice(0, 120));
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
      if (st && st !== "ACTIVE" && st !== "RUNNING" && st !== "PLAYING") {
        log("раунд: " + round.status);
        return;
      }

      var board = entry.board;
      if (!Array.isArray(board) || board.length < 36) {
        warn("плохой board len=" + (board && board.length));
        return;
      }

      if (round.config && round.config.minimumChain) {
        cfg.minChain = round.config.minimumChain;
      }

      var groups = rank(findGroups(board));
      if (!groups.length) {
        log("ходов нет");
        return;
      }

      var best = groups[0];
      log("ход #" + (movesDone + 1) + " type=" + best.type + " len=" + best.len);

      await sleep(rand(cfg.thinkMin, cfg.thinkMax));

      var result = await submitMove(round.id, entry.sequence, "COLLECT", best.tiles.slice());
      if (!result) {
        lastHarvest = null;
        var fresh = await getState();
        if (fresh && fresh.entry && fresh.round) {
          var g2 = rank(findGroups(fresh.entry.board));
          if (g2.length) {
            result = await submitMove(
              fresh.round.id,
              fresh.entry.sequence,
              "COLLECT",
              g2[0].tiles.slice()
            );
          }
        }
      }

      if (result) {
        if (result.entry) lastHarvest = Object.assign({}, state, { entry: result.entry });
        else lastHarvest = null;
        movesDone++;
        var pts = result.result && result.result.points;
        log("OK +" + (pts != null ? pts : "?") + "  total=" + movesDone);
        lastError = "";
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
      "position:fixed;right:8px;bottom:80px;z-index:2147483646;width:180px;padding:10px;" +
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
    while (logEl.children.length > 30) logEl.removeChild(logEl.lastChild);
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
      log("START");
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
        lastError: lastError,
      };
    },
    forceMove: async function () {
      lastHarvest = null;
      return playOnce();
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
    "%c" + TAG + " v" + VERSION + " ready — нажми START на панели или __FARO_BOT__.start()",
    "color:#6f6;font-weight:bold"
  );
})();
