/* =========================================================
   자산뷰어 PWA - app.js

   CONFIG.apiUrl에 Apps Script Web App 주소를 넣으면 실제 데이터 사용.
   비워두면 MOCK_DATA로 화면 확인.
========================================================= */

let CONFIG = {
  apiUrl: "",
  token: "",
  smallWeightThreshold: 0.01
};

/**
 * 개발 편의용 외부 설정 파일.
 *
 * GitHub 루트의 config.json만 수정하면
 * Apps Script URL / token을 바꿀 수 있습니다.
 *
 * Date.now()를 붙여서 config.json 캐시를 최대한 피합니다.
 */
async function loadConfig() {
  const res = await fetch("./config.json?v=" + Date.now(), {
    cache: "no-store"
  });

  if (!res.ok) {
    throw new Error("config.json을 불러오지 못했습니다.");
  }

  const externalConfig = await res.json();

  CONFIG = {
    ...CONFIG,
    ...externalConfig
  };
}

const NAV_ICONS = {
  quote: { off: "./assets/icons/nav/quote-off.png", on: "./assets/icons/nav/quote-on.png" },
  asset: { off: "./assets/icons/nav/asset-off.png", on: "./assets/icons/nav/asset-on.png" },
  weight: { off: "./assets/icons/nav/weight-off.png", on: "./assets/icons/nav/weight-on.png" },
  trend: { off: "./assets/icons/nav/trend-off.png", on: "./assets/icons/nav/trend-on.png" },
  sync: { off: "./assets/icons/nav/refreshtotal-off.png", on: "./assets/icons/nav/refreshtotal-on.png" },
  refresh: { off: "./assets/icons/nav/refresh-off.png", on: "./assets/icons/nav/refresh-on.png" }
};

const state = {
  activeTab: "quote",
  trendPeriod: "month",
  trendPeriodByAccount: {},
  data: null,
  touchedTrendPoint: null,
  trendMode: "trend",
  trendHistoryDate: "",
  snapshotDetail: null,
  snapshotDetailDate: "",
  isRefreshing: false,
  snapshotsLoaded: false
};

const TREND_PERIODS = [
  { key: "month", label: "이달" },
  { key: "oneMonth", label: "한달" },
  { key: "sixMonths", label: "6달" },
  { key: "year", label: "올해" },
  { key: "oneYear", label: "1년" },
  { key: "threeYears", label: "3년" },
  { key: "fiveYears", label: "5년" },
  { key: "max", label: "최대" }
];


/* =========================================================
   Local cache / progress helpers
========================================================= */

const LOCAL_DB = {
  name: "stock-viewer-cache-v1",
  version: 1,
  store: "kv",
  keys: {
    baseData: "baseData",
    snapshots: "snapshots"
  }
};

function todayLocalKey_() {
  return dateKey(new Date());
}

function openLocalDb_() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB를 사용할 수 없습니다."));
      return;
    }

    const req = indexedDB.open(LOCAL_DB.name, LOCAL_DB.version);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LOCAL_DB.store)) {
        db.createObjectStore(LOCAL_DB.store);
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB 열기 실패"));
  });
}

async function idbGet_(key) {
  const db = await openLocalDb_();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_DB.store, "readonly");
    const store = tx.objectStore(LOCAL_DB.store);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error("IndexedDB 읽기 실패"));
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

async function idbSet_(key, value) {
  const db = await openLocalDb_();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_DB.store, "readwrite");
    const store = tx.objectStore(LOCAL_DB.store);
    const req = store.put(value, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error || new Error("IndexedDB 저장 실패"));
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

function renderProgress(title, lines = []) {
  const safeLines = (lines || []).map(line => `<li>${escapeHtml(line)}</li>`).join("");
  const screen = document.getElementById("screen");
  if (!screen) return;

  screen.innerHTML = `
    <div class="loading-screen loading-progress">
      <div class="loading-progress-title">${escapeHtml(title || "처리 중")}</div>
      <ol class="loading-progress-list">${safeLines}</ol>
    </div>
  `;
  updateNav();
}

function makeProgress_(title) {
  const lines = [];
  return message => {
    lines.push(message);
    renderProgress(title, lines);
  };
}

async function loadJsonpAction_(action, params = {}) {
  const url = new URL(CONFIG.apiUrl);
  url.searchParams.set("action", action);
  if (CONFIG.token) url.searchParams.set("token", CONFIG.token);

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
  });

  const data = await loadJsonp(url.toString());
  if (data?.ok === false) throw new Error(data.error || "API 오류");
  return data;
}

async function fetchBaseDataFromGoogle_(addProgress) {
  addProgress("AccountPositions를 구글시트로부터 읽고 있습니다.");
  addProgress("Symbols를 구글시트로부터 읽고 있습니다.");

  const data = await loadJsonpAction_("baseData");

  addProgress("AccountPositions와 Symbols를 IndexedDB에 저장하고 있습니다.");
  const base = normalizeBaseData_(data);
  await idbSet_(LOCAL_DB.keys.baseData, {
    savedAt: new Date().toISOString(),
    savedDate: todayLocalKey_(),
    base
  });

  return base;
}

async function readBaseDataFromIndexedDb_(addProgress) {
  addProgress("AccountPositions를 IndexedDB로부터 읽고 있습니다.");
  addProgress("Symbols를 IndexedDB로부터 읽고 있습니다.");

  const cached = await idbGet_(LOCAL_DB.keys.baseData);
  if (!cached?.base) throw new Error("IndexedDB에 AccountPositions/Symbols 캐시가 없습니다.");
  return normalizeBaseData_(cached.base);
}

async function loadSnapshotsWithCache_(addProgress) {
  addProgress("SnapshotSummary 캐시를 확인하고 있습니다.");

  const today = todayLocalKey_();
  const cached = await idbGet_(LOCAL_DB.keys.snapshots).catch(() => null);

  if (cached?.loadedDate === today && Array.isArray(cached.snapshots)) {
    addProgress("SnapshotSummary를 IndexedDB로부터 읽고 있습니다.");
    return cached.snapshots;
  }

  addProgress("SnapshotSummary를 구글시트로부터 읽고 있습니다.");
  const data = await loadJsonpAction_("snapshots");
  const snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];

  addProgress("SnapshotSummary를 IndexedDB에 저장하고 있습니다.");
  await idbSet_(LOCAL_DB.keys.snapshots, {
    loadedDate: today,
    loadedAt: new Date().toISOString(),
    snapshots
  });

  return snapshots;
}

async function readSnapshotsFromIndexedDb_(addProgress) {
  addProgress("SnapshotSummary를 IndexedDB로부터 읽고 있습니다.");
  const cached = await idbGet_(LOCAL_DB.keys.snapshots);
  return Array.isArray(cached?.snapshots) ? cached.snapshots : [];
}

function normalizeBaseData_(data) {
  const positions = data.positions || data.accountPositions || [];
  const symbols = data.symbols || {};
  const accountBasisMap = data.accountBasisMap || buildAccountBasisMapFromPositions_(positions);
  const totalBasis = data.totalBasis !== undefined
    ? Number(data.totalBasis || 0)
    : Object.values(accountBasisMap).reduce((sum, n) => sum + Number(n || 0), 0);
  const accounts = data.accounts || getAccountsFromPositions_(positions);
  const quoteTargets = data.quoteTargets || collectQuoteTargetsFromBase_(positions, symbols);

  return {
    generatedAt: data.generatedAt || new Date().toISOString(),
    positions,
    symbols,
    accounts,
    totalBasis,
    accountBasisMap,
    quoteTargets
  };
}

function buildAccountBasisMapFromPositions_(positions) {
  const map = {};
  (positions || []).forEach(p => {
    if (String(p.symbol || "") !== "원금") return;
    map[p.account] = (map[p.account] || 0) + Number(p.quantity || 0);
  });
  return map;
}

function getAccountsFromPositions_(positions) {
  const seen = {};
  const out = [];
  (positions || []).forEach(p => {
    if (!p.account || seen[p.account]) return;
    seen[p.account] = true;
    out.push({ account: p.account, colorKey: accountClass(p.account) });
  });
  return out;
}

function fallbackSymbolClient_(symbol) {
  const s = String(symbol || "").trim();
  const currency = s.startsWith("CASH_USD") ? "USD" : "KRW";
  return {
    symbol: s,
    name: s === "CASH_KRW" ? "원화 현금" : s === "CASH_USD" ? "달러 현금" : s,
    exchange: s.startsWith("CASH_") ? "CASH" : "",
    assetType: s.startsWith("CASH_") ? "현금" : "",
    currency
  };
}

function collectQuoteTargetsFromBase_(positions, symbols) {
  const seen = {};
  const list = [];
  (positions || []).forEach(p => {
    const symbol = String(p.symbol || "").trim();
    if (!symbol || symbol === "원금" || isCash(symbol) || seen[symbol]) return;
    const meta = symbols[symbol] || fallbackSymbolClient_(symbol);
    seen[symbol] = true;
    list.push({
      symbol,
      name: meta.name || symbol,
      exchange: meta.exchange || "",
      assetType: meta.assetType || "",
      currency: meta.currency || "KRW"
    });
  });
  return list;
}

function buildHoldingsFromBase_(base, quoteData = {}) {
  const positions = base.positions || [];
  const symbols = base.symbols || {};
  const quotes = quoteData.quotes || {};
  const usdKrw = Number(quoteData.usdKrw || base.usdKrw || 0);

  return positions
    .filter(p => String(p.symbol || "") !== "원금")
    .map(p => {
      const symbol = String(p.symbol || "").trim();
      const meta = symbols[symbol] || fallbackSymbolClient_(symbol);
      const quote = quotes[symbol] || {};
      const currency = String(meta.currency || "KRW").toUpperCase();
      const quantity = Number(p.quantity || 0);
      const avgPrice = Number(p.avgPrice || 0);

      let fxRate = currency === "USD"
        ? Number(quote.fxRate || usdKrw || p.fxRate || 0)
        : 1;
      if (!fxRate) fxRate = Number(p.fxRate || 1);

      let currentPrice = Number(quote.currentPrice || 0);
      let dayChangeAmount = Number(quote.dayChangeAmount || 0);
      let dayChangeRate = Number(quote.dayChangeRate || 0);

      if (isCash(symbol)) {
        currentPrice = 1;
        dayChangeAmount = 0;
        dayChangeRate = 0;
      }

      const principal = avgPrice * quantity;
      const principalKrw = principal * fxRate;
      const valueKrw = isCash(symbol)
        ? quantity * fxRate
        : currentPrice * quantity * fxRate;
      const profit = isCash(symbol) ? 0 : valueKrw - principalKrw;
      const profitRate = principalKrw ? profit / principalKrw : 0;

      return {
        account: p.account,
        accountNo: p.accountNo || "",
        accountName: p.accountName || "",
        symbol,
        name: meta.name || symbol,
        exchange: meta.exchange || "",
        assetType: meta.assetType || "",
        currency,
        avgPrice,
        quantity,
        currentPrice,
        dayChangeAmount,
        dayChangeRate,
        fxRate,
        valueKrw,
        principal,
        principalKrw,
        profit,
        profitRate
      };
    })
    .filter(x => Math.abs(Number(x.quantity || 0)) > 0.000001);
}

function buildDataFromBase_(base, snapshots = [], quoteData = {}) {
  const holdings = buildHoldingsFromBase_(base, quoteData);
  return {
    generatedAt: quoteData.generatedAt || base.generatedAt || new Date().toISOString(),
    usdKrw: Number(quoteData.usdKrw || base.usdKrw || 0),
    positions: base.positions || [],
    symbols: base.symbols || {},
    quoteTargets: base.quoteTargets || collectQuoteTargetsFromBase_(base.positions || [], base.symbols || {}),
    accounts: base.accounts || getAccountsFromPositions_(base.positions || []),
    holdings,
    totalBasis: Number(base.totalBasis || 0),
    accountBasisMap: base.accountBasisMap || {},
    snapshots: snapshots || [],
    debugTiming: quoteData.debugTiming || {}
  };
}

async function fetchQuotesForBase_(base, addProgress) {
  const targets = base.quoteTargets || collectQuoteTargetsFromBase_(base.positions || [], base.symbols || {});
  addProgress("한투 API로 시세를 갱신하고 있습니다.");

  if (!CONFIG.apiUrl) {
    await wait(250);
    const mock = clone(MOCK_DATA);
    return {
      generatedAt: new Date().toISOString(),
      usdKrw: detectUsdKrwFromHoldings_(mock.holdings),
      quotes: buildMockQuoteMap_(mock.holdings)
    };
  }

  return await loadJsonpAction_("quotes", { symbols: targets });
}

async function loadAppData_(mode = "startup") {
  const isSync = mode === "sync";
  const title = isSync ? "동기화 중" : "앱을 시작하는 중";
  const addProgress = makeProgress_(title);

  if (isSync) state.isRefreshing = "sync";

  try {
    let base;
    let snapshots;

    if (CONFIG.apiUrl) {
      base = await fetchBaseDataFromGoogle_(addProgress);
      snapshots = await loadSnapshotsWithCache_(addProgress);
    } else {
      addProgress("MOCK_DATA를 사용하고 있습니다.");
      await wait(250);
      base = normalizeBaseData_({
        positions: MOCK_DATA.holdings.map(h => ({
          account: h.account,
          symbol: h.symbol,
          avgPrice: h.avgPrice,
          quantity: h.quantity
        })).concat(Object.entries(MOCK_DATA.accountBasisMap || {}).map(([account, basis]) => ({
          account,
          symbol: "원금",
          avgPrice: 1,
          quantity: basis
        }))),
        symbols: Object.fromEntries((MOCK_DATA.holdings || []).map(h => [h.symbol, {
          symbol: h.symbol,
          name: h.name,
          exchange: h.exchange,
          assetType: h.assetType,
          currency: h.currency
        }])),
        accounts: MOCK_DATA.accounts,
        totalBasis: MOCK_DATA.totalBasis,
        accountBasisMap: MOCK_DATA.accountBasisMap
      });
      snapshots = MOCK_DATA.snapshots || [];
    }

    state.data = buildDataFromBase_(base, snapshots, {});
    state.snapshotsLoaded = true;

    const quoteData = await fetchQuotesForBase_(base, addProgress);
    state.data = buildDataFromBase_(base, snapshots, quoteData);

    addProgress("화면을 갱신하고 있습니다.");
    state.isRefreshing = false;
    render();
  } catch (err) {
    state.isRefreshing = false;
    renderError(err.message || String(err));
  }
}

async function refreshFromLocalCache_() {
  const addProgress = makeProgress_("새로고침 중");
  state.isRefreshing = "refresh";

  try {
    const base = await readBaseDataFromIndexedDb_(addProgress);
    let snapshots = [];
    try {
      snapshots = await readSnapshotsFromIndexedDb_(addProgress);
    } catch (_) {
      snapshots = state.data?.snapshots || [];
    }

    state.data = buildDataFromBase_(base, snapshots, {});
    state.snapshotsLoaded = true;

    const quoteData = await fetchQuotesForBase_(base, addProgress);
    state.data = buildDataFromBase_(base, snapshots, quoteData);

    addProgress("화면을 갱신하고 있습니다.");
    state.isRefreshing = false;
    render();
  } catch (err) {
    state.isRefreshing = false;
    renderError(err.message || String(err));
  }
}

const MOCK_DATA = {
  totalBasis: 420000000,
  accountBasisMap: {
    "색시-세공연저": 10000000,
    "색시-안세공연저": 120000000,
    "신랑-ISA": 20000000,
    "신랑-일반1": 20000000,
    "신랑-일반2": 50000000
  },
  accounts: [
    { account: "색시-세공연저", colorKey: "blue" },
    { account: "색시-안세공연저", colorKey: "blue" },
    { account: "신랑-ISA", colorKey: "orange" },
    { account: "신랑-일반1", colorKey: "orange" },
    { account: "신랑-일반2", colorKey: "orange" }
  ],
  holdings: [
    h("색시-세공연저", "QLD", "ProShares Ultra QQQ", "AMS", "미국ETF", "USD", 62, 1000, 546.71, -7.46, -0.017, 1400),
    cash("색시-세공연저", "CASH_KRW", "원화 현금", "KRW", 1350000, 1),
    cash("색시-세공연저", "CASH_USD", "달러 현금", "USD", 550, 1400),
    h("색시-안세공연저", "426030", "TIME 미국나스닥100액티브", "KRX", "국내ETF", "KRW", 32000, 5000, 46750, 750, 0.043, 1),
    h("신랑-ISA", "000660", "SK하이닉스", "KRX", "국내주식", "KRW", 1300000, 10, 1119000, -123000, -0.143, 1),
    h("신랑-ISA", "VOO", "Vanguard 500 Index Fund", "AMS", "미국ETF", "USD", 600, 10, 490, 4.1, 0.008, 1400),
    h("신랑-ISA", "005930", "삼성전자", "KRX", "국내주식", "KRW", 200000, 10, 82000, 1000, 0.012, 1),
    h("신랑-일반1", "000250", "삼천당제약", "KRX", "국내주식", "KRW", 150000, 10, 175000, 3000, 0.017, 1),
    cash("신랑-일반1", "CASH_USD", "달러 현금", "USD", 10000, 1400),
    h("신랑-일반2", "457790", "PLUS 태양광&ESS", "KRX", "국내ETF", "KRW", 55000, 1000, 44700, -400, -0.009, 1),
    h("신랑-일반2", "426030", "TIME 미국나스닥100액티브", "KRX", "국내ETF", "KRW", 34000, 20, 46750, 750, 0.043, 1)
  ],
  snapshots: makeMockSnapshots()
};

function h(account, symbol, name, exchange, assetType, currency, avgPrice, quantity, currentPrice, dayChangeAmount, dayChangeRate, fxRate) {
  const principal = avgPrice * quantity;
  const principalKrw = principal * fxRate;
  const valueKrw = currentPrice * quantity * fxRate;
  const profit = valueKrw - principalKrw;
  return { account, symbol, name, exchange, assetType, currency, avgPrice, quantity, currentPrice, dayChangeAmount, dayChangeRate, fxRate, valueKrw, principal, principalKrw, profit, profitRate: principalKrw ? profit / principalKrw : 0 };
}

function cash(account, symbol, name, currency, quantity, fxRate) {
  return { account, symbol, name, exchange: "CASH", assetType: "현금", currency, avgPrice: 1, quantity, currentPrice: 1, dayChangeAmount: 0, dayChangeRate: 0, fxRate, valueKrw: quantity * fxRate, principal: quantity, principalKrw: quantity * fxRate, profit: 0, profitRate: 0 };
}

async function bootApp() {
  setupNav();

  /*
    개발 중에는 service worker를 꺼둡니다.
    캐시 때문에 app.js / style.css 수정이 반영되지 않는 문제를 줄이기 위함입니다.
    앱이 완성된 뒤 다시 켜도 됩니다.
  */
  // registerServiceWorker();

  try {
    await loadConfig();
    await loadAppData_("startup");
  } catch (err) {
    renderError(err.message || String(err));
  }
}

/*
  index.html에서 app.js를 동적으로 불러오면
  DOMContentLoaded 이벤트가 이미 지나간 뒤 app.js가 실행될 수 있습니다.
  그 경우 기존 DOMContentLoaded 리스너는 실행되지 않아
  "자산뷰어를 불러오는 중..."에서 멈춥니다.
*/
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootApp);
} else {
  bootApp();
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try { await navigator.serviceWorker.register("./service-worker.js"); } catch (e) { console.warn(e); }
}

function setupNav() {
  ensureSyncNavButton();

  document.querySelectorAll(".nav-item[data-tab]").forEach(btn => {
    btn.addEventListener("click", async () => {
      state.activeTab = btn.dataset.tab;
      state.touchedTrendPoint = null;

      if (state.activeTab === "trend" && !state.snapshotsLoaded) {
        await loadSnapshotsIfNeeded();
      }

      render();
    });
  });

  const syncBtn = document.querySelector(".nav-sync");
  if (syncBtn) syncBtn.addEventListener("click", () => loadAppData_("sync"));

  const refreshBtn = document.querySelector(".nav-refresh");
  if (refreshBtn) refreshBtn.addEventListener("click", () => refreshQuotesOnly());

  updateNav();
}

function ensureSyncNavButton() {
  const nav = document.querySelector(".bottom-nav");
  const refreshBtn = document.querySelector(".nav-refresh");
  if (!nav || !refreshBtn) return;

  const refreshLabel = refreshBtn.querySelector(".nav-label");
  if (refreshLabel) refreshLabel.textContent = "새로고침";
  refreshBtn.setAttribute("aria-label", "새로고침");

  if (document.querySelector(".nav-sync")) return;

  const syncBtn = document.createElement("button");
  syncBtn.className = "nav-item nav-sync";
  syncBtn.type = "button";
  syncBtn.setAttribute("aria-label", "동기화");
  syncBtn.innerHTML = `
    <img class="nav-icon" data-icon="sync" alt="" />
    <span class="nav-label">동기화</span>
  `;

  nav.insertBefore(syncBtn, refreshBtn);
}

async function loadDashboard(force = false) {
  await loadAppData_(force ? "sync" : "startup");
}


async function loadSnapshotsIfNeeded() {
  if (state.snapshotsLoaded || !state.data) return;

  const addProgress = makeProgress_("추이 데이터를 준비하는 중");

  try {
    const snapshots = CONFIG.apiUrl
      ? await loadSnapshotsWithCache_(addProgress)
      : (MOCK_DATA.snapshots || []);

    state.data = {
      ...state.data,
      snapshots
    };
  } catch (err) {
    console.warn("snapshots load failed", err);
    state.data = {
      ...state.data,
      snapshots: state.data.snapshots || []
    };
  } finally {
    state.snapshotsLoaded = true;
  }
}

async function loadSnapshotDetailForDate(date = "") {
  if (!state.data) return;

  const targetDate = date || state.trendHistoryDate || latestSnapshotDate_();

  if (
    state.snapshotDetail &&
    state.snapshotDetailDate &&
    (!targetDate || state.snapshotDetailDate === targetDate)
  ) {
    return;
  }

  const detail = buildSnapshotDetailFromCachedSnapshots_(targetDate);
  state.snapshotDetail = detail;
  state.snapshotDetailDate = detail?.date || targetDate || "";
  state.trendHistoryDate = state.snapshotDetailDate;
}

function buildMockSnapshotDetail_(date = "") {
  const d = date || todayKey();
  const accounts = accountNames().map((account, idx) => ({
    account,
    accountNo: splitAccountLabel(account).no,
    colorKey: accountClass(account, idx),
    summary: summary(account)
  }));

  return {
    ok: true,
    date: d,
    availableDates: [d],
    total: summary("전체계좌"),
    accounts,
    holdings: clone(holdings())
  };
}



async function refreshQuotesOnly() {
  if (!CONFIG.apiUrl) {
    await loadAppData_("startup");
    return;
  }

  await refreshFromLocalCache_();
}


function quoteTargetsFromCurrentHoldings() {
  const map = {};

  holdings().forEach(i => {
    const symbol = String(i.symbol || "").trim();
    if (!symbol || isCash(symbol) || map[symbol]) return;

    map[symbol] = {
      symbol,
      name: i.name || symbol,
      exchange: i.exchange || "",
      assetType: i.assetType || "",
      currency: i.currency || "KRW"
    };
  });

  return Object.values(map);
}

function applyQuoteRefresh(data) {
  if (state.data?.positions && state.data?.symbols) {
    const base = normalizeBaseData_(state.data);
    state.data = buildDataFromBase_(base, state.data.snapshots || [], data || {});
    return;
  }

  const quotes = data?.quotes || {};
  const usdKrw = Number(data?.usdKrw || state.data?.usdKrw || 0);

  state.data = {
    ...state.data,
    generatedAt: data?.generatedAt || new Date().toISOString(),
    usdKrw: usdKrw || state.data?.usdKrw
  };

  state.data.holdings = holdings().map(item => updateHoldingWithQuote(item, quotes, usdKrw));
}

function updateHoldingWithQuote(item, quotes, usdKrw) {
  const symbol = String(item.symbol || "");
  const quote = quotes[symbol] || {};
  const currency = String(item.currency || "KRW").toUpperCase();
  const quantity = Number(item.quantity || 0);
  const avgPrice = Number(item.avgPrice || 0);
  const principal = avgPrice * quantity;

  let fxRate = currency === "USD"
    ? Number(quote.fxRate || usdKrw || item.fxRate || 0)
    : 1;

  if (!fxRate) fxRate = Number(item.fxRate || 1);

  let currentPrice = Number(quote.currentPrice || 0) || Number(item.currentPrice || 0);
  let dayChangeAmount = quote.dayChangeAmount !== undefined
    ? Number(quote.dayChangeAmount || 0)
    : Number(item.dayChangeAmount || 0);
  let dayChangeRate = quote.dayChangeRate !== undefined
    ? Number(quote.dayChangeRate || 0)
    : Number(item.dayChangeRate || 0);

  if (isCash(symbol)) {
    currentPrice = 1;
    dayChangeAmount = 0;
    dayChangeRate = 0;
  }

  const principalKrw = principal * fxRate;
  const valueKrw = isCash(symbol)
    ? quantity * fxRate
    : currentPrice * quantity * fxRate;
  const profit = isCash(symbol) ? 0 : valueKrw - principalKrw;
  const profitRate = principalKrw ? profit / principalKrw : 0;

  return {
    ...item,
    currentPrice,
    dayChangeAmount,
    dayChangeRate,
    fxRate,
    valueKrw,
    principal,
    principalKrw,
    profit,
    profitRate
  };
}

function buildMockQuoteMap_(items) {
  const map = {};
  (items || []).forEach(i => {
    if (isCash(i.symbol) || map[i.symbol]) return;
    map[i.symbol] = {
      symbol: i.symbol,
      currentPrice: i.currentPrice,
      dayChangeAmount: i.dayChangeAmount,
      dayChangeRate: i.dayChangeRate,
      fxRate: i.fxRate
    };
  });
  return map;
}

function detectUsdKrwFromHoldings_(items) {
  const found = (items || []).find(i => String(i.currency || "").toUpperCase() === "USD" && Number(i.fxRate || 0));
  return Number(found?.fxRate || 0);
}

/**
 * Apps Script JSONP 호출 함수.
 *
 * fetch()는 CORS 때문에 실패할 수 있어서,
 * <script src="...&callback=..."> 방식으로 데이터를 받습니다.
 */

/*
function loadJsonp(url) {
  return new Promise((resolve, reject) => {
    const callbackName =
      "__stockviewer_cb_" +
      Date.now() +
      "_" +
      Math.floor(Math.random() * 1000000);

    let script;

    const cleanup = () => {
      try {
        delete window[callbackName];
      } catch (_) {
        window[callbackName] = undefined;
      }

      if (script && script.parentNode) {
        script.parentNode.removeChild(script);
      }
    };

    window[callbackName] = data => {
      cleanup();
      resolve(data);
    };

    script = document.createElement("script");

    const sep = url.includes("?") ? "&" : "?";
    script.src =
      url +
      sep +
      "callback=" +
      encodeURIComponent(callbackName) +
      "&_=" +
      Date.now();

    script.onerror = () => {
      cleanup();
      reject(new Error("JSONP 호출 실패"));
    };

    document.body.appendChild(script);
  });
}
*/

function loadJsonp(url) {
  const t0 = performance.now();
  const log = label => {
    console.log(`[jsonp] ${label}: ${Math.round(performance.now() - t0)}ms`);
  };

  return new Promise((resolve, reject) => {
    log("start");

    const callbackName =
      "__stockviewer_cb_" +
      Date.now() +
      "_" +
      Math.floor(Math.random() * 1000000);

    let script;
    let settled = false;

    const cleanup = () => {
      log("cleanup start");

      try {
        delete window[callbackName];
      } catch (_) {
        window[callbackName] = undefined;
      }

      if (script && script.parentNode) {
        script.parentNode.removeChild(script);
      }

      log("cleanup done");
    };

    window[callbackName] = data => {
      if (settled) return;
      settled = true;

      log("jsonp callback received");
      console.log("[jsonp] response keys", Object.keys(data || {}));
      console.log("[jsonp] server debugTiming", data?.debugTiming);

      cleanup();
      log("resolve");
      resolve(data);
    };

    log("callback registered");

    script = document.createElement("script");
    log("script created");

    const sep = url.includes("?") ? "&" : "?";
    script.src =
      url +
      sep +
      "callback=" +
      encodeURIComponent(callbackName) +
      "&_=" +
      Date.now();

    console.log("[jsonp] request url", script.src);
    log("script src set");

    script.onload = () => {
      log("script onload");
    };

    script.onerror = () => {
      if (settled) return;
      settled = true;

      log("script onerror");
      cleanup();
      reject(new Error("JSONP 호출 실패"));
    };

    document.body.appendChild(script);
    log("script appended");
  });
}


function renderLoading(msg) {
  document.getElementById("screen").innerHTML = `<div class="loading-screen">${escapeHtml(msg)}</div>`;
  updateNav();
}

function renderError(msg) {
  document.getElementById("screen").innerHTML = `<div class="loading-screen loss">오류: ${escapeHtml(msg)}</div>`;
  updateNav();
}

function render() {
  if (!state.data) return;
  updateNav();

  const screen = document.getElementById("screen");
  if (state.activeTab === "quote") screen.innerHTML = renderTopCard() + renderQuoteTab();
  if (state.activeTab === "asset") screen.innerHTML = renderAssetTab();
  if (state.activeTab === "weight") screen.innerHTML = renderWeightTab();
  if (state.activeTab === "trend") {
    screen.innerHTML = renderTrendTab();
    attachTrendEvents();
  }
}

function updateNav() {
  document.querySelectorAll(".nav-icon").forEach(img => {
    const key = img.dataset.icon;

    const active = state.isRefreshing
      ? key === state.isRefreshing
      : key === state.activeTab;

    img.src = NAV_ICONS[key]?.[active ? "on" : "off"] || "";
  });

  document.querySelectorAll(".nav-item").forEach(btn => {
    const tab = btn.dataset.tab;
    const icon = btn.querySelector(".nav-icon")?.dataset.icon;

    const active = state.isRefreshing
      ? icon === state.isRefreshing
      : tab === state.activeTab;

    btn.classList.toggle("active", active);
  });
}

/* =========================================================
   Data helpers
========================================================= */

function holdings() {
  return (state.data?.holdings || []).filter(x => Math.abs(Number(x.quantity || 0)) > 0.000001);
}

function accountNames() {
  const names = [];
  (state.data?.accounts || []).forEach(a => {
    if (a.account && !names.includes(a.account)) names.push(a.account);
  });
  holdings().forEach(h => {
    if (h.account && !names.includes(h.account)) names.push(h.account);
  });
  return names;
}

function itemsFor(account) {
  if (account === "전체계좌") return aggregateBySymbol(holdings());
  return holdings().filter(h => h.account === account);
}

function aggregateBySymbol(items) {
  const map = {};
  items.forEach(i => {
    if (!map[i.symbol]) {
      map[i.symbol] = { ...i, account: "전체계좌", quantity: 0, valueKrw: 0, principal: 0, principalKrw: 0, profit: 0 };
    }
    map[i.symbol].quantity += Number(i.quantity || 0);
    map[i.symbol].valueKrw += Number(i.valueKrw || 0);
    map[i.symbol].principal += Number(i.principal || 0);
    map[i.symbol].principalKrw += Number(i.principalKrw || 0);
    map[i.symbol].profit += Number(i.profit || 0);
  });

  return Object.values(map).map(i => {
    if (!isCash(i.symbol) && i.quantity) i.avgPrice = i.principal / i.quantity;
    i.profitRate = i.principalKrw ? i.profit / i.principalKrw : 0;
    return i;
  });
}

function summary(account = "전체계좌") {
  const items = itemsFor(account);
  const total = sum(items, "valueKrw");
  const principalKrw = sum(items, "principalKrw");
  const evalProfit = total - principalKrw;
  const basis = account === "전체계좌" ? Number(state.data?.totalBasis || 0) : Number(state.data?.accountBasisMap?.[account] || 0);
  const day = dayProfit(items);

  return {
    total,
    principalKrw,
    evalProfit,
    evalProfitRate: principalKrw ? evalProfit / principalKrw : 0,
    basis,
    accountProfit: total - basis,
    accountProfitRate: basis ? (total - basis) / basis : 0,
    dayProfit: day.amount,
    dayProfitRate: day.rate
  };
}

function dayProfit(items) {
  let amount = 0, prevValue = 0;
  items.forEach(i => {
    if (isCash(i.symbol)) return;
    const r = Number(i.dayChangeRate || 0);
    const value = Number(i.valueKrw || 0);
    if (r <= -0.99) return;
    const prev = value / (1 + r);
    amount += value - prev;
    prevValue += prev;
  });
  return { amount, rate: prevValue ? amount / prevValue : 0 };
}

function sorted(items) {
  return [...items].sort((a, b) => {
    if (isCash(a.symbol) && !isCash(b.symbol)) return 1;
    if (!isCash(a.symbol) && isCash(b.symbol)) return -1;
    return Number(b.valueKrw || 0) - Number(a.valueKrw || 0);
  });
}

function investments(items) { return sorted(items).filter(i => !isCash(i.symbol)); }
function cashItems(items) { return sorted(items).filter(i => isCash(i.symbol)); }
function isCash(symbol) { return String(symbol || "").startsWith("CASH_"); }
function sum(items, key) { return items.reduce((s, i) => s + Number(i[key] || 0), 0); }

/* =========================================================
   Common components
========================================================= */

function renderTopCard() {
  return renderPortfolioSummaryCard();
}

function renderPortfolioSummaryCard(extraHtml = "", className = "") {
  const s = summary("전체계좌");
  return `
    <section class="portfolio-summary-card ${className}">
      
    <div class="top-card-title">TOTAL PORTFOLIO</div>


      <div class="top-card-body">
        <div>
          <div class="amount-main">${formatWon(s.total)}</div>
          <div class="principal-line"><span class="pill-label">원금</span>${formatWon(s.basis)}</div>
        </div>
        ${renderProfitList(s)}
      </div>
      ${extraHtml ? `<div class="portfolio-summary-extra">${extraHtml}</div>` : ""}
    </section>
  `;
}

function renderProfitList(s) {
  return `
    <div class="summary-profit-list">
      ${profitRow(s.dayProfit, s.dayProfitRate, "일간")}
      ${profitRow(s.evalProfit, s.evalProfitRate, "평가")}
      ${profitRow(s.accountProfit, s.accountProfitRate, "계좌")}
    </div>
  `;
}

function profitRow(amount, rate, label) {
  const cls = Number(amount) >= 0 ? "profit" : "loss";
  return `<div class="summary-profit-row ${cls}"><span>${formatWonSign(amount)} (${formatPlainRate(Math.abs(rate))})</span><span class="label">${label}</span></div>`;
}

function renderAccountSection(account, html, index = 0) {
  /*
    계좌 박스의 탭/테두리는 전체 탭에서 공통 회색으로 통일합니다.
    계좌별 고유색은 비중탭 상단 계좌 누적바/원형기호에서만 사용합니다.
  */
  const boxColor = "var(--color-account-all)";

  return `
    <section class="account-section ${accountClass(account, index)}" style="--account-color:${boxColor};">
      <div class="account-tab">${escapeHtml(account)}</div>
      <div class="account-box">${html}</div>
    </section>
  `;
}

function renderAllSections(renderer) {
  const arr = [renderAccountSection("전체계좌", renderer("전체계좌", 0), 0)];
  accountNames().forEach((a, i) => arr.push(renderAccountSection(a, renderer(a, i + 1), i + 1)));
  return arr.join("");
}

function accountClass(account, i = 0) {
  if (account === "전체계좌") return "is-all";
  if (String(account).includes("색시")) return "is-blue";
  if (String(account).includes("신랑")) return "is-orange";
  return i % 2 ? "is-blue" : "is-orange";
}

/* =========================================================
   Quote tab
========================================================= */

function renderQuoteTab() {
  return renderAllSections(account => {
    const items = investments(itemsFor(account));
    if (!items.length) return `<div class="muted">표시할 시세 데이터가 없습니다.</div>`;
    return items.map(renderQuoteRow).join("");
  });
}

function renderQuoteRow(i) {
  const c = Number(i.dayChangeRate || 0) >= 0 ? "profit" : "loss";
  const avgC = Number(i.profitRate || 0) >= 0 ? "avg-profit" : "avg-loss";

  return `
    <div class="quote-row">
      <div class="stock-name">${escapeHtml(i.name || i.symbol)}</div>
      <div class="quote-price">
        <div class="current-price">${formatPrice(i.currentPrice, i.currency)}</div>
        <div class="day-change ${c}">${formatChange(i.dayChangeAmount, i.currency)} (${formatPlainRate2(Math.abs(i.dayChangeRate))})</div>
      </div>
      <div class="side-pills">        
        <span class="info-pill ${avgC}">${formatPrice(i.avgPrice, i.currency).replace("$ ", "")} (${formatRate(i.profitRate)}) <span class="small-tag">평</span></span>
        <span class="info-pill">${formatQty(i.quantity, i.symbol)}</span>
      </div>
    </div>
  `;
}

/* =========================================================
   Asset tab
========================================================= */

function renderAssetTab() {
  /*
    자산탭의 최상단은 시세탭/비중탭과 같은 공통 TOTAL PORTFOLIO 카드로 표시합니다.
    아래 개별 계좌들은 기존 account-section 구조를 그대로 유지합니다.
  */
  const topHtml = renderPortfolioSummaryCard(renderAssetAccountDetails("전체계좌"), "asset-top-card");

  const accountHtml = accountNames()
    .map((a, i) => renderAccountSection(a, renderAssetAccountContent(a), i + 1))
    .join("");

  return topHtml + accountHtml;
}

function renderAssetAccountContent(account) {
  const s = summary(account);
  return `
    <div class="account-summary">
      <div>
        <div class="amount-main">${formatWon(s.total)}</div>
        <div class="principal-line"><span class="pill-label">원금</span>${formatWon(s.basis)}</div>
      </div>
      ${renderProfitList(s)}
    </div>
    ${renderAssetAccountDetails(account)}
  `;
}

function renderAssetAccountDetails(account) {
  const s = summary(account);
  const items = itemsFor(account);
  const inv = investments(items);
  const cash = cashItems(items);
  const invValue = sum(inv, "valueKrw");
  const cashValue = sum(cash, "valueKrw");
  const total = invValue + cashValue;
  const invRate = total ? invValue / total : 0;
  const cashRate = total ? cashValue / total : 0;

  return `
    <div class="asset-mix">
      <div class="mix-legend">
        <span class="mix-stock"><i class="legend-dot"></i>주식 ${formatWon(invValue)} (${formatPlainRate(invRate)})</span>
        <span class="mix-cash"><i class="legend-dot"></i>예수금 ${formatWon(cashValue)} (${formatPlainRate(cashRate)})</span>
      </div>
      <div class="mix-bar">
        <div class="stock" style="width:${invRate * 100}%"></div>
        <div class="cash" style="width:${cashRate * 100}%"></div>
      </div>
    </div>

    ${inv.map(renderAssetRow).join("")}
    ${renderCashSummaryRow(cash)}
  `;
}

function renderAssetRow(i) {
  const isC = isCash(i.symbol);
  const cls = Number(i.profit || 0) >= 0 ? "profit" : "loss";

  return `
    <div class="asset-row">
      <div class="stock-name">${escapeHtml(displayName(i))}</div>
      <div class="asset-value">
        <div class="asset-amount">${formatWon(i.valueKrw)}</div>
        <div class="asset-profit ${isC ? "muted" : cls}">
          ${isC ? formatQty(i.quantity, i.symbol) : `${formatWonSign(i.profit)} (${formatRate(i.profitRate)})`}
        </div>
      </div>
      <div class="side-pills">
        <span class="info-pill">${isC ? "현금" : formatQty(i.quantity, i.symbol)}</span>
        ${isC ? "" : `<span class="info-pill">원 ${formatNumber(i.principalKrw)}</span>`}
      </div>
    </div>
  `;
}

function formatNumber(v) {
  return Math.round(Number(v || 0)).toLocaleString("ko-KR");
}

function renderCashSummaryRow(items) {
  if (!items.length) return "";

  const krw = items.find(i => i.symbol === "CASH_KRW");
  const usd = items.find(i => i.symbol === "CASH_USD");

  const total = sum(items, "valueKrw");
  const krwAmount = Number(krw?.quantity || 0);
  const usdAmount = Number(usd?.quantity || 0);

  const fxRate = usdAmount
    ? Number(usd?.fxRate || usd?.valueKrw / usdAmount || 0)
    : 0;

  const detail = [
    krwAmount ? formatWon(krwAmount) : "",
    usdAmount ? formatUsdCash(usdAmount) : ""
  ].filter(Boolean).join(" + ");

  return `
    <div class="asset-row cash-summary-row">
      <div class="stock-name">예수금</div>

      <div class="cash-summary-value">
        <div class="cash-summary-top">
          <span class="asset-amount">${formatWon(total)}</span>
          <span class="info-pill cash-fx-pill">${fxRate ? formatFxRate(fxRate) : "현금"}</span>
        </div>
        <div class="asset-profit muted cash-detail">${detail}</div>
      </div>
    </div>
  `;
}

/* =========================================================
   Weight tab
========================================================= */

function renderWeightTab() {
  const s = summary("전체계좌");
  const total = s.total;
  const symbolColors = buildSymbolColorMap();

  const accItems = accountNames().map((name, idx) => {
    const v = summary(name).total;
    return { name, valueKrw: v, weight: total ? v / total : 0, color: accountColor(name, idx) };
  });

  const topHtml = renderPortfolioSummaryCard(
    renderStackedBar(accItems) + renderAccountWeightList(accItems),
    "weight-top-card"
  );

  return `
    ${topHtml}
    ${renderAllSections(account => renderWeightBarLayout(groupSmall(weightItemsFor(account).filter(i => Number(i.valueKrw || 0) > 0)), symbolColors))}
  `;
}

function renderStackedBar(items) {
  return `<div class="stacked-bar">${items.map(i => `<div class="stacked-segment" style="width:${i.weight * 100}%;background:${i.color};"></div>`).join("")}</div>`;
}

function renderAccountWeightList(items) {
  return `
    <div class="account-weight-list">
      ${items.map(i => renderAccountWeightLine(i)).join("")}
    </div>
  `;
}

function renderAccountWeightLine(i) {
  const account = splitAccountLabel(i.name);

  return `
    <div class="account-weight-line">
      <span class="color-dot" style="--dot-color:${i.color};"></span>
      <span class="account-weight-no">${escapeHtml(account.no)}</span>
      <span class="account-weight-name">${escapeHtml(account.name)}</span>
      <span class="account-weight-value">${formatWon(i.valueKrw)}</span>
      <span class="account-weight-rate">${formatPlainRate(i.weight)}</span>
    </div>
  `;
}

function splitAccountLabel(name) {
  const text = String(name || "").trim();
  const m = text.match(/^([A-Z])\s+(.+)$/);

  if (!m) {
    return { no: "", name: text };
  }

  return {
    no: m[1],
    name: m[2]
  };
}

function renderWeightGrid(items) {
  return `<div class="weight-grid">${items.map(i => weightLine(i.name, i.weight, i.color)).join("")}</div>`;
}

function weightLine(name, rate, color) {
  return `
    <div class="weight-item">
      <span class="color-dot" style="--dot-color:${color};"></span>
      <span class="weight-name">${escapeHtml(name)}</span>
      <span class="weight-rate">${formatPlainRate(rate)}</span>
    </div>
  `;
}

function weightItemsFor(account) {
  return combineCashForWeight(itemsFor(account));
}

function combineCashForWeight(items) {
  const list = [];
  const cashList = [];

  items.forEach(i => {
    if (isCash(i.symbol)) cashList.push(i);
    else list.push(i);
  });

  if (cashList.length) {
    list.push({
      symbol: "CASH_TOTAL",
      name: "예수금",
      exchange: "CASH",
      assetType: "현금",
      currency: "KRW",
      quantity: sum(cashList, "valueKrw"),
      currentPrice: 1,
      avgPrice: 1,
      dayChangeAmount: 0,
      dayChangeRate: 0,
      fxRate: 1,
      valueKrw: sum(cashList, "valueKrw"),
      principal: sum(cashList, "principalKrw"),
      principalKrw: sum(cashList, "principalKrw"),
      profit: 0,
      profitRate: 0
    });
  }

  return list;
}

function renderWeightBarLayout(items, symbolColors = buildSymbolColorMap()) {
  const total = sum(items, "valueKrw");
  if (!items.length || !total) return `<div class="muted">표시할 비중 데이터가 없습니다.</div>`;

  const list = sorted(items).map((i, idx) => ({
    ...i,
    weight: Number(i.valueKrw || 0) / total,
    color: symbolColor(i, symbolColors, idx)
  }));

  return `
    ${renderStackedBar(list)}
    <div class="weight-detail-list">
      ${list.map(i => renderWeightDetailLine(i)).join("")}
    </div>
  `;
}

function renderWeightDetailLine(i) {
  return `
    <div class="weight-detail-line">
      <span class="color-dot" style="--dot-color:${i.color};"></span>
      <span class="weight-detail-name">${escapeHtml(displayName(i))}</span>
      <span class="weight-detail-value">${formatWon(i.valueKrw)}</span>
      <span class="weight-detail-rate">${formatPlainRate(i.weight)}</span>
    </div>
  `;
}

function groupSmall(items) {
  const total = sum(items, "valueKrw");
  if (!total) return items;

  const big = [];
  const small = [];

  items.forEach(i => {
    const w = Number(i.valueKrw || 0) / total;

    // 비중탭에서는 원화/달러 현금을 합친 예수금 행을 항상 별도로 보여줍니다.
    if (isCash(i.symbol)) {
      big.push(i);
      return;
    }

    if (w < CONFIG.smallWeightThreshold) small.push(i);
    else big.push(i);
  });

  if (small.length) {
    big.push({
      symbol: "ETC",
      name: `기타 ${small.length}종목`,
      valueKrw: sum(small, "valueKrw"),
      currency: "KRW",
      assetType: "기타"
    });
  }

  return big;
}

/* =========================================================
   Trend tab
========================================================= */

function renderTrendTab() {
  const mode = state.trendMode || "trend";
  const modeHtml = renderTrendModeControls();

  if (mode === "historyAsset") {
    return modeHtml + renderHistoricalAssetView();
  }

  if (mode === "historyWeight") {
    return modeHtml + renderHistoricalWeightView();
  }

  const topHtml = renderPortfolioSummaryCard(renderTrendGraphPanel("전체계좌"), "trend-top-card");

  const accountHtml = accountNames()
    .map((a, i) => renderAccountSection(a, renderTrendAccountContent(a), i + 1))
    .join("");

  return modeHtml + topHtml + accountHtml;
}


function renderTrendModeControls() {
  const mode = state.trendMode || "trend";
  const isHistory = mode !== "trend";
  const dateText = formatHistoryDateLabel_(state.trendHistoryDate || latestSnapshotDate_());

  return `
    <div class="trend-mode-bar">
      <button class="trend-mode-btn ${mode === "trend" ? "active" : ""}" data-trend-mode="trend" type="button">추이</button>
      <button class="trend-mode-btn ${mode === "historyAsset" ? "active" : ""}" data-trend-mode="historyAsset" type="button">과거자산</button>
      <button class="trend-mode-btn ${mode === "historyWeight" ? "active" : ""}" data-trend-mode="historyWeight" type="button">과거비중</button>
      ${isHistory ? `
        <button class="trend-date-nav" data-history-date-step="-1" type="button">◀</button>
        <span class="trend-history-date">${dateText}</span>
        <button class="trend-date-nav" data-history-date-step="1" type="button">▶</button>
      ` : ""}
    </div>
  `;
}

function renderHistoricalAssetView() {
  const detail = snapshotDetailOrEmpty_();
  if (!detail) return `<div class="loading-screen">과거 스냅샷을 선택하세요.</div>`;

  const topHtml = renderHistoricalPortfolioSummaryCard(
    "전체계좌",
    renderHistoricalAssetAccountDetails("전체계좌"),
    "asset-top-card"
  );

  const accountHtml = historicalAccountNames_()
    .map((a, i) => renderAccountSection(a, renderHistoricalAssetAccountContent(a), i + 1))
    .join("");

  return topHtml + accountHtml;
}

function renderHistoricalWeightView() {
  const detail = snapshotDetailOrEmpty_();
  if (!detail) return `<div class="loading-screen">과거 스냅샷을 선택하세요.</div>`;

  const total = historicalSummary_("전체계좌").total;
  const symbolColors = buildHistoricalSymbolColorMap_(historicalItemsFor_("전체계좌"));

  const accItems = historicalAccountNames_().map((name, idx) => {
    const v = historicalSummary_(name).total;
    return { name, valueKrw: v, weight: total ? v / total : 0, color: accountColor(name, idx) };
  });

  const topHtml = renderHistoricalPortfolioSummaryCard(
    "전체계좌",
    renderStackedBar(accItems) + renderAccountWeightList(accItems),
    "weight-top-card"
  );

  const sections = [
    renderAccountSection(
      "전체계좌",
      renderWeightBarLayout(groupSmall(historicalItemsFor_("전체계좌").filter(i => Number(i.valueKrw || 0) > 0)), symbolColors),
      0
    )
  ];

  historicalAccountNames_().forEach((a, i) => {
    sections.push(renderAccountSection(
      a,
      renderWeightBarLayout(groupSmall(historicalItemsFor_(a).filter(i => Number(i.valueKrw || 0) > 0)), symbolColors),
      i + 1
    ));
  });

  return topHtml + sections.join("");
}

function renderHistoricalPortfolioSummaryCard(account, extraHtml = "", className = "") {
  const s = historicalSummary_(account);

  return `
    <section class="portfolio-summary-card ${className}">
      <div class="top-card-title">${account === "전체계좌" ? "TOTAL PORTFOLIO" : escapeHtml(account)}</div>
      <div class="top-card-body">
        <div>
          <div class="amount-main">${formatWon(s.total)}</div>
          <div class="principal-line"><span class="pill-label">원금</span>${formatWon(s.basis)}</div>
        </div>
        ${renderProfitList(s)}
      </div>
      ${extraHtml ? `<div class="portfolio-summary-extra">${extraHtml}</div>` : ""}
    </section>
  `;
}

function renderHistoricalAssetAccountContent(account) {
  const s = historicalSummary_(account);
  return `
    <div class="account-summary">
      <div>
        <div class="amount-main">${formatWon(s.total)}</div>
        <div class="principal-line"><span class="pill-label">원금</span>${formatWon(s.basis)}</div>
      </div>
      ${renderProfitList(s)}
    </div>
    ${renderHistoricalAssetAccountDetails(account)}
  `;
}

function renderHistoricalAssetAccountDetails(account) {
  const items = historicalItemsFor_(account);
  const inv = investments(items);
  const cash = cashItems(items);
  const invValue = sum(inv, "valueKrw");
  const cashValue = sum(cash, "valueKrw");
  const total = invValue + cashValue;
  const invRate = total ? invValue / total : 0;
  const cashRate = total ? cashValue / total : 0;

  return `
    <div class="asset-mix">
      <div class="mix-legend">
        <span class="mix-stock"><i class="legend-dot"></i>주식 ${formatWon(invValue)} (${formatPlainRate(invRate)})</span>
        <span class="mix-cash"><i class="legend-dot"></i>예수금 ${formatWon(cashValue)} (${formatPlainRate(cashRate)})</span>
      </div>
      <div class="mix-bar">
        <div class="stock" style="width:${invRate * 100}%"></div>
        <div class="cash" style="width:${cashRate * 100}%"></div>
      </div>
    </div>

    ${inv.map(renderAssetRow).join("")}
    ${renderCashSummaryRow(cash)}
  `;
}


function buildSnapshotDetailFromCachedSnapshots_(requestedDate = "") {
  const normalized = (state.data?.snapshots || [])
    .map(normalizeSnapshotDetailFromCache_)
    .filter(Boolean);

  const availableDates = Array.from(new Set(normalized.map(r => r.date))).sort();
  if (!availableDates.length) {
    return {
      ok: true,
      date: "",
      availableDates: [],
      total: null,
      accounts: [],
      holdings: []
    };
  }

  const date = requestedDate && availableDates.includes(requestedDate)
    ? requestedDate
    : availableDates[availableDates.length - 1];

  const rows = normalized.filter(r => r.date === date);
  const totalRow = rows.find(r => r.scope === "TOTAL") || null;
  const accountRows = rows.filter(r => r.scope === "ACCOUNT");
  const holdings = rows.filter(r => r.scope === "SYMBOL");

  return {
    ok: true,
    date,
    availableDates,
    total: totalRow ? totalRow.summary : null,
    accounts: accountRows.map(r => ({
      account: r.account,
      accountNo: r.accountNo,
      summary: r.summary
    })),
    holdings
  };
}

function normalizeSnapshotDetailFromCache_(r) {
  if (!r) return null;
  const date = String(r.date || r.baseDate || r["기준일"] || r["날짜"] || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const scope = String(r.scope || r["범위"] || "").toUpperCase();
  if (!scope) return null;

  const accountNo = String(r.accountNo || r.accountNumber || r["계좌번호"] || "").trim();
  const accountName = String(r.account || r["계좌"] || "").trim();
  const account = accountNo && accountName && !String(accountName).startsWith(accountNo + " ")
    ? `${accountNo} ${accountName}`
    : accountName;

  const total = Number(r.totalAsset ?? r.valueKrw ?? r.valueKRW ?? r["평가금액_KRW"] ?? r["평가금액"] ?? 0);
  const principalKrw = Number(r.principalKrw ?? r.principal ?? r["평가원금_KRW"] ?? r["평가원금"] ?? 0);
  const basis = Number(r.basis ?? r.depositPrincipal ?? r["입금원금_KRW"] ?? principalKrw ?? 0);
  const evalProfit = Number(r.evalProfit ?? r.profit ?? r["평가손익_KRW"] ?? (total - principalKrw));
  const evalProfitRate = Number(r.evalProfitRate ?? r.profitRate ?? r["평가수익률"] ?? (principalKrw ? evalProfit / principalKrw : 0));
  const accountProfit = Number(r.accountProfit ?? r["계좌수익_KRW"] ?? (total - basis));
  const accountProfitRate = Number(r.accountProfitRate ?? r["계좌수익률"] ?? (basis ? accountProfit / basis : 0));
  const dayProfit = Number(r.dayProfit ?? r["일간손익_KRW"] ?? 0);
  const dayProfitRate = Number(r.dayProfitRate ?? r["일간수익률"] ?? 0);

  if (scope === "TOTAL" || scope === "ACCOUNT") {
    return {
      date,
      scope,
      accountNo,
      account,
      summary: {
        total,
        principalKrw,
        evalProfit,
        evalProfitRate,
        basis,
        accountProfit,
        accountProfitRate,
        dayProfit,
        dayProfitRate
      }
    };
  }

  if (scope === "SYMBOL") {
    const symbol = String(r.symbol || r["종목코드"] || "").trim();
    const currency = String(r.currency || r["통화"] || "KRW").toUpperCase();
    const quantity = Number(r.quantity ?? r["수량"] ?? 0);
    const avgPrice = Number(r.avgPrice ?? r["평균단가"] ?? 0);
    const currentPrice = Number(r.currentPrice ?? r["현재가"] ?? 0);
    const fxRate = Number(r.fxRate ?? r["환율"] ?? (currency === "USD" ? 0 : 1));

    return {
      date,
      scope,
      account,
      accountNo,
      symbol,
      name: String(r.name || r["종목명"] || symbol).trim(),
      exchange: String(r.exchange || r["거래소"] || "").trim(),
      assetType: String(r.assetType || r["자산구분"] || "").trim(),
      currency,
      quantity,
      avgPrice,
      currentPrice,
      dayChangeAmount: Number(r.dayChangeAmount ?? r["일간등락금액"] ?? 0),
      dayChangeRate: dayProfitRate,
      fxRate,
      valueKrw: total,
      principal: Number(r.principal ?? r["평가원금"] ?? avgPrice * quantity),
      principalKrw,
      profit: evalProfit,
      profitRate: evalProfitRate,
      dayProfit,
      dayProfitRate
    };
  }

  return null;
}

function snapshotDetailOrEmpty_() {
  return state.snapshotDetail && state.snapshotDetail.holdings ? state.snapshotDetail : null;
}

function historicalAccountNames_() {
  const detail = snapshotDetailOrEmpty_();
  if (!detail) return [];

  const names = [];
  (detail.accounts || []).forEach(a => {
    if (a.account && !names.includes(a.account)) names.push(a.account);
  });

  (detail.holdings || []).forEach(h => {
    if (h.account && !names.includes(h.account)) names.push(h.account);
  });

  return names;
}

function historicalItemsFor_(account) {
  const detail = snapshotDetailOrEmpty_();
  const items = detail?.holdings || [];

  if (account === "전체계좌") return aggregateBySymbol(items);
  return items.filter(h => h.account === account);
}

function historicalSummary_(account) {
  const detail = snapshotDetailOrEmpty_();

  if (!detail) {
    return {
      total: 0,
      principalKrw: 0,
      evalProfit: 0,
      evalProfitRate: 0,
      basis: 0,
      accountProfit: 0,
      accountProfitRate: 0,
      dayProfit: 0,
      dayProfitRate: 0
    };
  }

  if (account === "전체계좌" && detail.total) return normalizeSummaryForClient_(detail.total);

  const found = (detail.accounts || []).find(a => a.account === account);
  if (found?.summary) return normalizeSummaryForClient_(found.summary);

  const items = historicalItemsFor_(account);
  const total = sum(items, "valueKrw");
  const principalKrw = sum(items, "principalKrw");
  const evalProfit = total - principalKrw;
  const day = dayProfit(items);
  const basis = principalKrw;

  return {
    total,
    principalKrw,
    evalProfit,
    evalProfitRate: principalKrw ? evalProfit / principalKrw : 0,
    basis,
    accountProfit: total - basis,
    accountProfitRate: basis ? (total - basis) / basis : 0,
    dayProfit: day.amount,
    dayProfitRate: day.rate
  };
}

function normalizeSummaryForClient_(s) {
  const total = Number(s.total || 0);
  const principalKrw = Number(s.principalKrw || 0);
  const evalProfit = s.evalProfit !== undefined ? Number(s.evalProfit || 0) : total - principalKrw;
  const basis = Number(s.basis || 0);
  const accountProfit = s.accountProfit !== undefined ? Number(s.accountProfit || 0) : total - basis;

  return {
    total,
    principalKrw,
    evalProfit,
    evalProfitRate: s.evalProfitRate !== undefined ? Number(s.evalProfitRate || 0) : (principalKrw ? evalProfit / principalKrw : 0),
    basis,
    accountProfit,
    accountProfitRate: s.accountProfitRate !== undefined ? Number(s.accountProfitRate || 0) : (basis ? accountProfit / basis : 0),
    dayProfit: Number(s.dayProfit || 0),
    dayProfitRate: Number(s.dayProfitRate || 0)
  };
}

function latestSnapshotDate_() {
  const dates = snapshotAvailableDates_();
  return dates[dates.length - 1] || todayKey();
}

function snapshotAvailableDates_() {
  const fromDetail = state.snapshotDetail?.availableDates || [];
  const fromSnapshots = (state.data?.snapshots || [])
    .map(s => String(s.date || s.baseDate || s["기준일"] || "").slice(0, 10))
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));

  return Array.from(new Set([...fromSnapshots, ...fromDetail])).sort();
}

function adjacentSnapshotDate_(date, step) {
  const dates = snapshotAvailableDates_();
  if (!dates.length) return "";

  const current = date || dates[dates.length - 1];
  let idx = dates.indexOf(current);

  if (idx < 0) {
    idx = dates.findIndex(d => d > current);
    if (idx < 0) idx = dates.length - 1;
  }

  const next = Math.max(0, Math.min(dates.length - 1, idx + step));
  return dates[next];
}

function formatHistoryDateLabel_(date) {
  const d = parseDateKey(date || todayKey());
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function buildHistoricalSymbolColorMap_(items) {
  const map = {};
  const list = aggregateBySymbol(items || [])
    .filter(i => !isCash(i.symbol))
    .filter(i => Number(i.valueKrw || 0) > 0)
    .sort((a, b) => Number(b.valueKrw || 0) - Number(a.valueKrw || 0));

  list.forEach((item, idx) => {
    map[String(item.symbol)] = symbolChartColor(idx);
  });

  return map;
}


function renderTrendAccountContent(account) {
  const s = summary(account);
  return `
    <div class="account-summary trend-account-summary">
      <div>
        <div class="amount-main">${formatWon(s.total)}</div>
        <div class="principal-line"><span class="pill-label">원금</span>${formatWon(s.basis)}</div>
      </div>
      ${renderProfitList(s)}
    </div>
    ${renderTrendGraphPanel(account)}
  `;
}

function trendPeriodFor(account) {
  return state.trendPeriodByAccount?.[account] || state.trendPeriod || "month";
}

function setTrendPeriodFor(account, period) {
  if (!state.trendPeriodByAccount) state.trendPeriodByAccount = {};
  state.trendPeriodByAccount[account] = period;
}

function renderTrendGraphPanel(account) {
  const period = trendPeriodFor(account);
  const raw = trendSnapshotPointsFor(account);
  const current = currentTrendPoint(account);
  const points = mergeTodayPoint(raw, current);
  const range = trendRange(period, points);
  const filtered = filterTrendPoints(points, range);
  const sampled = sampleTrendPoints(filtered, maxTrendPointCount(period));
  const selected = trendSelectedPoint(account, sampled) || sampled[sampled.length - 1] || current;

  return `
    <div class="trend-panel" data-trend-account="${escapeHtml(account)}">
      <div class="trend-periods">
        ${TREND_PERIODS.map(p => `<button class="trend-period-btn ${p.key === period ? "active" : ""}" data-trend-account="${escapeHtml(account)}" data-trend-period="${p.key}" type="button">${p.label}</button>`).join("")}
      </div>
      <div class="trend-legend">
        <span class="trend-legend-item asset"><i></i>자산</span>
        <span class="trend-legend-item principal"><i></i>원금</span>
        <span class="trend-selected-date">${selected?.date ? formatTrendDateLabel(selected.date) : ""}</span>
      </div>
      <div class="chart-wrap trend-chart-wrap" data-trend-account="${escapeHtml(account)}">
        ${renderAssetTrendChart(sampled, selected, range, period)}
      </div>
    </div>
  `;
}

function attachTrendEvents() {
  document.querySelectorAll("[data-trend-mode]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const mode = btn.dataset.trendMode || "trend";
      state.trendMode = mode;
      state.touchedTrendPoint = null;

      if (mode !== "trend") {
        await loadSnapshotDetailForDate(state.trendHistoryDate || latestSnapshotDate_());
      }

      render();
    });
  });

  document.querySelectorAll("[data-history-date-step]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const step = Number(btn.dataset.historyDateStep || 0);
      const nextDate = adjacentSnapshotDate_(state.trendHistoryDate || latestSnapshotDate_(), step);
      if (!nextDate) return;

      await loadSnapshotDetailForDate(nextDate);
      render();
    });
  });

  document.querySelectorAll("[data-trend-period]").forEach(btn => {
    btn.addEventListener("click", () => {
      const account = btn.dataset.trendAccount || "전체계좌";
      setTrendPeriodFor(account, btn.dataset.trendPeriod);
      state.touchedTrendPoint = null;
      render();
    });
  });

  document.querySelectorAll(".trend-chart-wrap").forEach(chart => {
    chart.addEventListener("pointerdown", e => {
      chart.setPointerCapture?.(e.pointerId);
      handleChartPointer(e);
    });

    chart.addEventListener("pointermove", e => {
      if (e.buttons || e.pressure > 0) handleChartPointer(e);
    });

    chart.addEventListener("pointerup", () => {
      state.touchedTrendPoint = null;
      render();
    });

    chart.addEventListener("pointercancel", () => {
      state.touchedTrendPoint = null;
      render();
    });
  });
}

function handleChartPointer(e) {
  const account = e.currentTarget.dataset.trendAccount || "전체계좌";
  const raw = trendSnapshotPointsFor(account);
  const points = mergeTodayPoint(raw, currentTrendPoint(account));
  const period = trendPeriodFor(account);
  const range = trendRange(period, points);
  const filtered = sampleTrendPoints(filterTrendPoints(points, range), maxTrendPointCount(period));
  if (!filtered.length) return;

  const rect = e.currentTarget.getBoundingClientRect();
  const plot = trendPlotGeometry_();
  const plotLeftPx = rect.width * (plot.left / plot.width);
  const plotRightPx = rect.width * (plot.right / plot.width);
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left - plotLeftPx) / Math.max(1, plotRightPx - plotLeftPx)));
  const domain = trendDomainMs_(range);
  const targetMs = domain.start + ratio * Math.max(1, domain.end - domain.start);

  let best = filtered[0];
  let bestDiff = Math.abs(parseDateKey(best.date).getTime() - targetMs);
  filtered.forEach(p => {
    const diff = Math.abs(parseDateKey(p.date).getTime() - targetMs);
    if (diff < bestDiff) {
      best = p;
      bestDiff = diff;
    }
  });

  state.touchedTrendPoint = { account, date: best.date };
  render();
}

function renderAssetTrendChart(points, selected, range, period = state.trendPeriod) {
  const plot = trendPlotGeometry_();
  const width = plot.width;
  const height = plot.height;
  const plotLeft = plot.left;
  const plotRight = plot.right;
  const padTop = plot.top;
  const plotBottom = plot.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - padTop;
  const yLabelX = plotRight + readTrendCssNumber_("--trend-y-label-gap", 9);
  const touchDotRadius = readTrendCssNumber_("--trend-touch-dot-radius", 5);
  const id = "tg" + Math.floor(Math.random() * 1000000);
  const ticks = trendTicks(period, range, points);
  const gridY = trendGridYRatios_().map(r => padTop + plotHeight * r);
  const xFor = date => plotLeft + trendDateRatio_(date, range) * plotWidth;
  const tickItems = ticks.map(t => ({ ...t, x: xFor(t.date) }));

  if (!points.length) {
    return `
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}">
        ${gridY.map(y => `<line class="trend-grid-line trend-grid-h" x1="${plotLeft}" y1="${y}" x2="${plotRight}" y2="${y}" />`).join("")}
        ${tickItems.map(t => `<line class="trend-grid-line trend-grid-v" x1="${t.x}" y1="${padTop}" x2="${t.x}" y2="${plotBottom}" />`).join("")}
        <rect class="trend-plot-border" x="${plotLeft}" y="${padTop}" width="${plotWidth}" height="${plotHeight}" />
        <!-- Y축 금액 라벨은 SVG 왜곡을 피하기 위해 HTML로 표시합니다. -->
      </svg>
      ${renderTrendYLabels_("-", "0원", yLabelX, padTop, plotBottom, width, height)}
      <div class="trend-x-labels">
        ${tickItems.map(t => `<span style="left:${(t.x / width) * 100}%">${escapeHtml(t.label)}</span>`).join("")}
      </div>
      <div class="trend-empty">SnapshotSummary가 쌓이면 그래프를 표시합니다.</div>
    `;
  }

  const maxValue = Math.max(
    ...points.map(p => Number(p.totalAsset || 0)),
    ...points.map(p => Number(p.principal || 0)),
    1
  );
  const max = niceTrendMax(maxValue * 1.1);   /*가장 큰 값이 세로축의 상단 90%쯤에 표시되도록 1.1을 곱함 */
  const min = 0;
  const yFor = value => plotBottom - ((Number(value || 0) - min) / Math.max(1, max - min)) * plotHeight;

  const xy = points.map(p => ({
    ...p,
    x: Math.max(plotLeft, Math.min(plotRight, xFor(p.date))),
    assetY: yFor(p.totalAsset),
    principalY: yFor(p.principal)
  }));

  const assetLine = makeSvgLinePath(xy, "assetY");
  const principalLine = makeSvgLinePath(xy, "principalY");
  const assetArea = makeSvgAreaPath(xy, "assetY", plotBottom);
  const principalArea = makeSvgAreaPath(xy, "principalY", plotBottom);
  const selectedPoint = selected ? xy.find(p => p.date === selected.date) : xy[xy.length - 1];

  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="${id}-asset" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--trend-asset-color)" stop-opacity="var(--trend-asset-area-opacity, 0.24)" />
          <stop offset="100%" stop-color="var(--trend-asset-color)" stop-opacity="0" />
        </linearGradient>
        <linearGradient id="${id}-principal" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--trend-principal-color)" stop-opacity="var(--trend-principal-area-opacity, 0.16)" />
          <stop offset="100%" stop-color="var(--trend-principal-color)" stop-opacity="0" />
        </linearGradient>
      </defs>

      ${gridY.map(y => `<line class="trend-grid-line trend-grid-h" x1="${plotLeft}" y1="${y}" x2="${plotRight}" y2="${y}" />`).join("")}
      ${tickItems.map(t => `<line class="trend-grid-line trend-grid-v" x1="${t.x}" y1="${padTop}" x2="${t.x}" y2="${plotBottom}" />`).join("")}
      <rect class="trend-plot-border" x="${plotLeft}" y="${padTop}" width="${plotWidth}" height="${plotHeight}" />
      <!-- Y축 금액 라벨은 SVG 왜곡을 피하기 위해 HTML로 표시합니다. -->

      <path class="trend-principal-area" d="${principalArea}" fill="url(#${id}-principal)" />
      <path class="trend-asset-area" d="${assetArea}" fill="url(#${id}-asset)" />
      <path class="trend-principal-line" d="${principalLine}" />
      <path class="trend-asset-line" d="${assetLine}" />
      ${selectedPoint ? `<line class="trend-touch-line" x1="${selectedPoint.x}" y1="${padTop}" x2="${selectedPoint.x}" y2="${plotBottom}" /><circle class="trend-touch-dot" cx="${selectedPoint.x}" cy="${selectedPoint.assetY}" r="${touchDotRadius}" />` : ""}
    </svg>
    ${renderTrendYLabels_(formatCompactWon(max), "0원", yLabelX, padTop, plotBottom, width, height)}
    <div class="trend-x-labels">
      ${tickItems.map(t => `<span style="left:${(t.x / width) * 100}%">${escapeHtml(t.label)}</span>`).join("")}
    </div>
  `;
}

function trendPlotGeometry_() {
  const width = readTrendCssNumber_("--trend-chart-viewbox-width", 600);
  const height = readTrendCssNumber_("--trend-chart-viewbox-height", 230);
  const left = readTrendCssNumber_("--trend-plot-left", 34);
  const right = readTrendCssNumber_("--trend-plot-right", 558);
  const top = readTrendCssNumber_("--trend-plot-top", 18);
  const bottom = readTrendCssNumber_("--trend-plot-bottom", 195);

  return {
    width,
    height,
    left: Math.max(0, Math.min(width - 1, left)),
    right: Math.max(left + 1, Math.min(width, right)),
    top: Math.max(0, Math.min(height - 1, top)),
    bottom: Math.max(top + 1, Math.min(height, bottom))
  };
}


function trendGridYRatios_() {
  return [
    readTrendCssNumber_("--trend-grid-y-1", 0.25),
    readTrendCssNumber_("--trend-grid-y-2", 0.5),
    readTrendCssNumber_("--trend-grid-y-3", 0.75)
  ]
    .filter(v => Number.isFinite(v))
    .map(v => Math.max(0, Math.min(1, v)));
}

function readTrendCssNumber_(name, fallback) {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();

  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function renderTrendYLabels_(topText, bottomText, x, topY, bottomY, width, height) {
  const leftPct = (x / width) * 100;
  const topPct = (topY / height) * 100;
  const bottomPct = (bottomY / height) * 100;

  return `
    <div class="trend-y-labels" aria-hidden="true">
      <span class="trend-y-label-html top" style="left:${leftPct}%;top:${topPct}%">${escapeHtml(topText)}</span>
      <span class="trend-y-label-html bottom" style="left:${leftPct}%;top:${bottomPct}%">${escapeHtml(bottomText)}</span>
    </div>
  `;
}

function trendDomainMs_(range) {
  const start = startOfDay(range.start).getTime();
  const end = startOfDay(range.end).getTime();
  return { start, end: Math.max(start + 1, end) };
}

function trendDateRatio_(date, range) {
  const domain = trendDomainMs_(range);
  return Math.max(0, Math.min(1, (parseDateKey(date).getTime() - domain.start) / Math.max(1, domain.end - domain.start)));
}

function makeSvgLinePath(points, yKey) {
  if (!points.length) return "";
  return points.map((p, i) => `${i ? "L" : "M"} ${p.x.toFixed(2)} ${Number(p[yKey]).toFixed(2)}`).join(" ");
}

function makeSvgAreaPath(points, yKey, bottomY) {
  if (!points.length) return "";
  const line = makeSvgLinePath(points, yKey);
  const first = points[0];
  const last = points[points.length - 1];
  return `${line} L ${last.x.toFixed(2)} ${bottomY} L ${first.x.toFixed(2)} ${bottomY} Z`;
}

function trendSnapshotPointsFor(account) {
  const raw = state.data?.snapshots || [];
  const normalized = raw.map(normalizeTrendSnapshot).filter(Boolean);

  return normalized
    .filter(p => {
      if (account === "전체계좌") return p.scope === "TOTAL" || !p.scope;
      return p.scope === "ACCOUNT" && trendAccountMatches_(p, account);
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function trendAccountMatches_(snapshotPoint, account) {
  const targetNo = trendAccountNo_(account);
  const targetName = trendAccountName_(account);
  const snapshotNo = String(snapshotPoint.accountNo || "").trim();
  const snapshotName = trendAccountName_(snapshotPoint.account);

  if (targetNo && snapshotNo && targetNo !== snapshotNo) return false;
  if (snapshotName && snapshotName === targetName) return true;
  if (targetNo && snapshotNo && targetNo === snapshotNo) return true;

  return String(snapshotPoint.account || "").trim() === String(account || "").trim();
}

function trendAccountNo_(account) {
  const m = String(account || "").trim().match(/^([A-Z])\s+/);
  return m ? m[1] : "";
}

function trendAccountName_(account) {
  return String(account || "").trim().replace(/^[A-Z]\s+/, "");
}

function normalizeTrendSnapshot(r) {
  if (!r) return null;
  const date = String(r.date || r.baseDate || r["기준일"] || r["날짜"] || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const scope = String(r.scope || r["범위"] || "").toUpperCase();
  const accountNo = String(r.accountNo || r.accountNumber || r["계좌번호"] || "").trim();
  const account = String(r.account || r["계좌"] || "").trim();
  const totalAsset = Number(r.totalAsset ?? r.valueKrw ?? r.valueKRW ?? r["평가금액_KRW"] ?? r["평가금액"] ?? 0);
  const principal = Number(r.principal ?? r.basis ?? r.principalKrw ?? r["입금원금_KRW"] ?? r["평가원금_KRW"] ?? 0);
  const profit = Number(r.profit ?? r.accountProfit ?? r["계좌수익_KRW"] ?? (totalAsset - principal));
  const profitRate = Number(r.profitRate ?? r.accountProfitRate ?? r["계좌수익률"] ?? (principal ? profit / principal : 0));
  const dayProfit = Number(r.dayProfit ?? r["일간손익_KRW"] ?? 0);
  const dayProfitRate = Number(r.dayProfitRate ?? r["일간수익률"] ?? 0);

  return { date, scope, accountNo, account, totalAsset, principal, profit, profitRate, dayProfit, dayProfitRate };
}

function currentTrendPoint(account) {
  const s = summary(account);
  return {
    date: todayKey(),
    scope: account === "전체계좌" ? "TOTAL" : "ACCOUNT",
    account,
    totalAsset: s.total,
    principal: s.basis,
    profit: s.accountProfit,
    profitRate: s.accountProfitRate,
    dayProfit: s.dayProfit,
    dayProfitRate: s.dayProfitRate,
    isLive: true
  };
}

function mergeTodayPoint(points, todayPoint) {
  const list = [...points];
  if (!list.some(p => p.date === todayPoint.date)) list.push(todayPoint);
  return list.sort((a, b) => a.date.localeCompare(b.date));
}

function filterTrendPoints(points, range) {
  const start = startOfDay(range.start).getTime();
  const end = endOfDay(range.end).getTime();
  return points.filter(p => {
    const t = parseDateKey(p.date).getTime();
    return t >= start && t <= end;
  });
}

function sampleTrendPoints(points, maxCount) {
  if (points.length <= maxCount) return points;
  const out = [];
  const last = points.length - 1;
  for (let i = 0; i < maxCount; i++) {
    const idx = Math.round((i / (maxCount - 1)) * last);
    const p = points[idx];
    if (!out.length || out[out.length - 1].date !== p.date) out.push(p);
  }
  return out;
}

function maxTrendPointCount(period) {
  if (period === "threeYears" || period === "fiveYears" || period === "max") return 360;
  return 1200;
}

function trendSelectedPoint(account, points) {
  const t = state.touchedTrendPoint;
  if (!t || t.account !== account) return null;
  return points.find(p => p.date === t.date) || null;
}

function trendRange(period, points = []) {
  const today = startOfDay(new Date());
  let start;
  let end = today;

  if (period === "month") {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
    // 이달 그래프의 가로축은 월 전체(1일~말일)를 기준으로 고정합니다.
    // 실제 데이터는 오늘까지만 있으므로 선은 오늘 위치까지만 그려집니다.
    end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  }
  else if (period === "oneMonth") start = addDays(today, -30);
  else if (period === "sixMonths") start = addMonths(today, -6);
  else if (period === "year") {
    start = new Date(today.getFullYear(), 0, 1);
    end = new Date(today.getFullYear(), 11, 31);
  }
  else if (period === "oneYear") start = addMonths(today, -12);
  else if (period === "threeYears") start = addMonths(today, -36);
  else if (period === "fiveYears") start = addMonths(today, -60);
  else {
    const first = points.length ? parseDateKey(points[0].date) : today;
    start = startOfDay(first);
  }

  return { start: startOfDay(start), end: endOfDay(end) };
}

function trendTicks(period, range, points = []) {
  const today = startOfDay(new Date());
  const ticks = [];

  if (period === "month") {
    const y = today.getFullYear();
    const m = today.getMonth();
    const last = new Date(y, m + 1, 0).getDate();
    [1, 5, 10, 15, 20, 25, last].forEach(d => ticks.push({ date: dateKey(new Date(y, m, Math.min(d, last))), label: d === last ? `${last}일` : `${d}일` }));
  } else if (period === "oneMonth") {
    for (let i = 0; i <= 6; i++) {
      const d = addDays(range.start, i * 5);
      ticks.push({ date: dateKey(d), label: formatMonthDay(d) });
    }
    ticks[ticks.length - 1] = { date: dateKey(range.end), label: formatMonthDay(range.end) };
  } else if (period === "sixMonths") {
    for (let i = 6; i >= 0; i--) {
      const d = addMonths(today, -i);
      ticks.push({ date: dateKey(d), label: formatMonthDay(d) });
    }
  } else if (period === "year") {
    const y = today.getFullYear();
    for (let m = 0; m < 12; m++) ticks.push({ date: dateKey(new Date(y, m, 1)), label: `${m + 1}/1` });
    ticks.push({ date: dateKey(new Date(y, 11, 31)), label: "12/31" });
  } else if (period === "oneYear") {
    for (let i = 12; i >= 0; i--) {
      const d = addMonths(today, -i);
      ticks.push({ date: dateKey(d), label: formatMonthDay(d) });
    }
  } else if (period === "threeYears") {
    for (let i = 36; i >= 0; i -= 3) {
      const d = addMonths(today, -i);
      ticks.push({ date: dateKey(d), label: formatYearMonth(d) });
    }
  } else if (period === "fiveYears") {
    for (let i = 60; i >= 0; i -= 6) {
      const d = addMonths(today, -i);
      ticks.push({ date: dateKey(d), label: formatYearMonth(d) });
    }
  } else {
    const start = range.start;
    const end = range.end;
    const span = Math.max(1, end.getTime() - start.getTime());
    for (let i = 0; i <= 6; i++) {
      const d = new Date(start.getTime() + span * (i / 6));
      ticks.push({ date: dateKey(d), label: formatYearMonth(d) });
    }
  }

  return ticks;
}

function trendTickPercent(date, range) {
  return trendDateRatio_(date, range) * 100;
}

function parseDateKey(date) {
  const s = String(date || "").slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return startOfDay(new Date());
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function todayKey() { return dateKey(new Date()); }
function dateKey(d) {
  const x = startOfDay(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function endOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addMonths(d, n) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
function formatMonthDay(d) { return `${d.getMonth() + 1}/${d.getDate()}`; }
function formatYearMonth(d) { return `${String(d.getFullYear()).slice(2)}/${String(d.getMonth() + 1).padStart(2, "0")}`; }
function formatTrendDateLabel(date) {
  const d = parseDateKey(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/*
function niceTrendMax(v) {
  const n = Number(v || 0);
  if (n <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const scaled = n / pow;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return nice * pow;
}
*/

/*
    A의 범위 : 0~1000만	A값을 올림해서 백만원 단위에 맞춤
    A의 범위 : 1000만~5000만	A값을 올림해서 5백만원 단위에 맞춤
    A의 범위 : 5000만~2억	A값을 올림해서 1000만원 단위에 맞춤
    A의 범위 : 2억~5억		A값을 올림해서 5000만원 단위에 맞춤
    A의 범위 : 5억~10억	A값을 올림해서 1억 단위에 맞춤
    A의 범위 : 10억~20억	A값을 올림해서 2억 단위에 맞춤
    A의 범위 : 20억~50억	A값을 올림해서 5억 단위에 맞춤
*/
function niceTrendMax(value) {
  const v = Number(value || 0);
  if (v <= 0) return 1;

  let step;

  if (v <= 10_000_000) {
    step = 1_000_000;
  } else if (v <= 50_000_000) {
    step = 5_000_000;
  } else if (v <= 200_000_000) {
    step = 10_000_000;
  } else if (v <= 500_000_000) {
    step = 50_000_000;
  } else if (v <= 1_000_000_000) {
    step = 100_000_000;
  } else if (v <= 2_000_000_000) {
    step = 200_000_000;
  } else if (v <= 5_000_000_000) {
    step = 500_000_000;
  } else {
    step = 1_000_000_000;
  }

  return Math.ceil(v / step) * step;
}

function formatCompactWon(v) {
  const n = Number(v || 0);
  if (n >= 1000000000000) return (n / 1000000000000).toFixed(1).replace(/\.0$/, "") + "조";
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, "") + "억";
  if (n >= 10000) return Math.round(n / 10000).toLocaleString("ko-KR") + "만";
  return Math.round(n).toLocaleString("ko-KR") + "원";
}

/* =========================================================
   Formatters / utilities
========================================================= */

function formatWon(v) { return Math.round(Number(v || 0)).toLocaleString("ko-KR") + "원"; }
function formatWonSign(v) { const n = Math.round(Number(v || 0)); return (n >= 0 ? "+" : "-") + Math.abs(n).toLocaleString("ko-KR") + "원"; }
function formatRate(v, plus = true) { const n = Number(v || 0); const t = (n * 100).toFixed(1) + "%"; return plus && n >= 0 ? "+" + t : t; }
function formatPlainRate(v) { return (Number(v || 0) * 100).toFixed(1) + "%"; }

function formatPrice(v, currency) {
  const n = Number(v || 0);
  if (currency === "USD") return "$ " + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return Math.round(n).toLocaleString("ko-KR");
}

function formatChange(v, currency) {
  const n = Number(v || 0);
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  if (currency === "USD") return sign + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sign + Math.round(abs).toLocaleString("ko-KR");
}

function formatQty(v, symbol) {
  const n = Number(v || 0);
  if (symbol === "CASH_USD") return "$ " + Math.round(n).toLocaleString("en-US");
  if (isCash(symbol)) return Math.round(n).toLocaleString("ko-KR") + "원";
  return n.toLocaleString("ko-KR") + " 주";
}

function formatUsdCash(v) {
  return "$ " + Number(v || 0).toLocaleString("en-US", {
    maximumFractionDigits: 2
  });
}

function formatFxRate(v) {
  return Number(v || 0).toLocaleString("ko-KR", {
    maximumFractionDigits: 1
  }) + " 환율";
}

function displayName(i) {
  if (i.symbol === "CASH_TOTAL") return "예수금";
  if (i.symbol === "CASH_KRW") return "원화 현금";
  if (i.symbol === "CASH_USD") return "달러 현금";
  return i.name || i.symbol;
}

function buildSymbolColorMap() {
  const map = {};
  const items = aggregateBySymbol(holdings())
    .filter(i => !isCash(i.symbol))
    .filter(i => Number(i.valueKrw || 0) > 0)
    .sort((a, b) => Number(b.valueKrw || 0) - Number(a.valueKrw || 0));

  items.forEach((item, idx) => {
    map[String(item.symbol)] = symbolChartColor(idx);
  });

  return map;
}

function symbolColor(item, colorMap = buildSymbolColorMap(), fallbackIndex = 0) {
  const symbol = String(item?.symbol || "");
  if (symbol === "ETC") return "var(--symbol-chart-etc)";
  if (isCash(symbol)) return "var(--symbol-chart-cash)";
  return colorMap[symbol] || symbolChartColor(fallbackIndex);
}

function accountColor(name, fallbackIndex = 0) {
  if (name === "전체계좌") return "var(--color-account-all)";

  const no = splitAccountLabel(name).no;
  const fixedOrder = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
  const idx = fixedOrder.indexOf(no);

  return accountChartColor(idx >= 0 ? idx : fallbackIndex);
}

function accountChartColor(i) {
  const arr = [
    "var(--account-chart-01)",
    "var(--account-chart-02)",
    "var(--account-chart-03)",
    "var(--account-chart-04)",
    "var(--account-chart-05)",
    "var(--account-chart-06)",
    "var(--account-chart-07)",
    "var(--account-chart-08)",
    "var(--account-chart-09)",
    "var(--account-chart-10)"
  ];
  return arr[Math.max(0, i) % arr.length];
}

function symbolChartColor(i) {
  const arr = [
    "var(--symbol-chart-01)",
    "var(--symbol-chart-02)",
    "var(--symbol-chart-03)",
    "var(--symbol-chart-04)",
    "var(--symbol-chart-05)",
    "var(--symbol-chart-06)",
    "var(--symbol-chart-07)",
    "var(--symbol-chart-08)",
    "var(--symbol-chart-09)",
    "var(--symbol-chart-10)",
    "var(--symbol-chart-11)",
    "var(--symbol-chart-12)"
  ];
  return arr[Math.max(0, i) % arr.length];
}

function chartColor(i) {
  return symbolChartColor(i);
}

function conic(items) {
  let cur = 0;
  const parts = items.map(i => {
    const start = cur;
    const end = cur + i.weight * 100;
    cur = end;
    return `${i.color} ${start}% ${end}%`;
  });
  return `conic-gradient(${parts.join(", ")})`;
}

function escapeHtml(t) {
  return String(t ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function clone(v) { return typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)); }

function makeMockSnapshots() {
  const arr = [];
  const start = new Date("2026-05-01");
  let total = 480000000;
  const principal = 420000000;

  for (let i = 0; i < 18; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    total += (i % 4 === 0 ? 8500000 : 2400000) - (i % 7 === 0 ? 3500000 : 0);
    arr.push({
      date: d.toISOString().slice(0, 10),
      totalAsset: total,
      principal,
      profit: total - principal,
      profitRate: principal ? (total - principal) / principal : 0
    });
  }

  return arr;
}

function formatPlainRate2(v) {
  return (Number(v || 0) * 100).toFixed(2) + "%";
}