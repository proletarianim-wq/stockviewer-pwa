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
  data: null,
  touchedTrendPoint: null,
  isRefreshing: false
};

const TREND_PERIODS = [
  { key: "year", label: "올해" },
  { key: "month", label: "이달" },
  { key: "oneMonth", label: "한달" },
  { key: "sixMonths", label: "6달" },
  { key: "oneYear", label: "1년" },
  { key: "max", label: "최대" }
];

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
    await loadDashboard();
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
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab;
      state.touchedTrendPoint = null;
      render();
    });
  });

  const syncBtn = document.querySelector(".nav-sync");
  if (syncBtn) syncBtn.addEventListener("click", () => loadDashboard(true));

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
  if (force) state.isRefreshing = "sync";

  renderLoading(force ? "전체 데이터 갱신중" : "자산뷰어를 불러오는 중...");

  try {
    if (CONFIG.apiUrl) {
      const url = new URL(CONFIG.apiUrl);
      url.searchParams.set("action", "dashboard");
      if (CONFIG.token) url.searchParams.set("token", CONFIG.token);

      const data = await loadJsonp(url.toString());

      if (data.ok === false) throw new Error(data.error || "API 오류");
      state.data = data;
    } else {
      await wait(250);
      state.data = clone(MOCK_DATA);
    }

    state.isRefreshing = false;
    render();
  } catch (err) {
    state.isRefreshing = false;
    renderError(err.message || String(err));
  }
}

/*
async function refreshQuotesOnly() {
  if (!state.data || !holdings().length) {
    await loadDashboard(true);
    return;
  }

  state.isRefreshing = "refresh";
  renderLoading("시세 갱신중");

    try {
    if (CONFIG.apiUrl) {
      const url = new URL(CONFIG.apiUrl);
      url.searchParams.set("action", "quotes");
      if (CONFIG.token) url.searchParams.set("token", CONFIG.token);
      url.searchParams.set("symbols", JSON.stringify(quoteTargetsFromCurrentHoldings()));

      const data = await loadJsonp(url.toString());
      if (data.ok === false) throw new Error(data.error || "API 오류");

      applyQuoteRefresh(data);
    } else {
      await wait(250);
      const mock = clone(MOCK_DATA);
      applyQuoteRefresh({
        generatedAt: new Date().toISOString(),
        usdKrw: detectUsdKrwFromHoldings_(mock.holdings),
        quotes: buildMockQuoteMap_(mock.holdings)
      });
    }

    state.isRefreshing = false;
    render();
  } catch (err) {
    state.isRefreshing = false;
    renderError(err.message || String(err));
  }
}
*/

async function refreshQuotesOnly() {
  const t0 = performance.now();
  const stamp = label => {
    console.log(`[refresh] ${label}: ${Math.round(performance.now() - t0)}ms`);
  };

  console.log("[refresh] start");

  if (!state.data || !holdings().length) {
    stamp("no data, fallback to loadDashboard");
    await loadDashboard(true);
    stamp("fallback dashboard done");
    return;
  }

  state.isRefreshing = "refresh";
  renderLoading("시세 갱신중");
  stamp("after renderLoading");

  try {
    if (CONFIG.apiUrl) {
      const targets = quoteTargetsFromCurrentHoldings();
      stamp(`after quoteTargetsFromCurrentHoldings, count=${targets.length}`);
      console.log("[refresh] targets", targets);

      const url = new URL(CONFIG.apiUrl);
      url.searchParams.set("action", "quotes");
      if (CONFIG.token) url.searchParams.set("token", CONFIG.token);
      url.searchParams.set("symbols", JSON.stringify(targets));

      stamp("before loadJsonp");
      const data = await loadJsonp(url.toString());
      stamp("after loadJsonp");

      if (data.ok === false) throw new Error(data.error || "API 오류");

      console.log("[refresh] response keys", Object.keys(data || {}));
      console.log("[refresh] quotes count", Object.keys(data.quotes || {}).length);

      applyQuoteRefresh(data);
      stamp("after applyQuoteRefresh");
    } else {
      stamp("mock start");

      await wait(250);
      const mock = clone(MOCK_DATA);

      applyQuoteRefresh({
        generatedAt: new Date().toISOString(),
        usdKrw: detectUsdKrwFromHoldings_(mock.holdings),
        quotes: buildMockQuoteMap_(mock.holdings)
      });

      stamp("mock after applyQuoteRefresh");
    }

    state.isRefreshing = false;

    stamp("before render");
    render();
    stamp("after render");
  } catch (err) {
    state.isRefreshing = false;
    console.error("[refresh] error", err);
    stamp("error before renderError");
    renderError(err.message || String(err));
    stamp("error after renderError");
  }
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
  const s = summary("전체계좌");
  const points = state.data?.snapshots || [];
  const selected = state.touchedTrendPoint || points[points.length - 1] || {
    date: "",
    totalAsset: s.total,
    principal: s.basis,
    profit: s.accountProfit,
    profitRate: s.accountProfitRate
  };

  return `
    <section class="trend-card">
      <div class="trend-head">
        <div class="amount-main">${formatWon(selected.totalAsset)}</div>
        <div class="principal-line">${formatWon(selected.principal)} <span class="pill-label">원금</span></div>
      </div>

      <div class="trend-periods">
        ${TREND_PERIODS.map(p => `<button class="trend-period-btn ${p.key === state.trendPeriod ? "active" : ""}" data-trend-period="${p.key}" type="button">${p.label}</button>`).join("")}
      </div>

      <div class="chart-wrap" id="assetChart">
        ${renderLineChart(points, selected)}
        <div class="chart-axis-label top">자산</div>
        <div class="chart-axis-label bottom">0원</div>
      </div>

      <div class="profit-rate-title">수익률</div>
      <div class="muted" style="padding:30px 0 48px;text-align:center;">
        SnapshotSummary가 쌓이면 수익률 그래프를 표시합니다.
      </div>
    </section>
  `;
}

function attachTrendEvents() {
  document.querySelectorAll("[data-trend-period]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.trendPeriod = btn.dataset.trendPeriod;
      render();
    });
  });

  const chart = document.getElementById("assetChart");
  if (!chart) return;

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
}

function handleChartPointer(e) {
  const points = state.data?.snapshots || [];
  if (!points.length) return;

  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const idx = Math.round(ratio * (points.length - 1));
  state.touchedTrendPoint = points[idx];
  render();
}

function renderLineChart(points, selected) {
  if (!points.length) return `<svg class="chart-svg"></svg>`;

  const width = 600, height = 220, padX = 34, padY = 20;
  const max = Math.max(...points.map(p => Number(p.totalAsset || 0))) * 1.05;
  const min = 0;

  const xy = points.map((p, i) => {
    const x = padX + (i / Math.max(1, points.length - 1)) * (width - padX * 2);
    const y = height - padY - ((Number(p.totalAsset || 0) - min) / Math.max(1, max - min)) * (height - padY * 2);
    return { ...p, x, y };
  });

  const assetLine = xy.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
  const principalLine = xy.map((p, i) => {
    const y = height - padY - ((Number(p.principal || 0) - min) / Math.max(1, max - min)) * (height - padY * 2);
    return `${i ? "L" : "M"} ${p.x} ${y}`;
  }).join(" ");

  const idx = selected ? Math.max(0, points.findIndex(p => p.date === selected.date)) : points.length - 1;
  const sp = xy[idx >= 0 ? idx : points.length - 1];

  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <line x1="${padX}" y1="${padY}" x2="${width - padX}" y2="${padY}" stroke="#eee" stroke-dasharray="5 5"/>
      <line x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}" stroke="#eee"/>
      <path d="${principalLine}" fill="none" stroke="#d7dce1" stroke-width="3" stroke-dasharray="4 4"/>
      <path d="${assetLine}" fill="none" stroke="#f24a73" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      ${sp ? `<line x1="${sp.x}" y1="${padY}" x2="${sp.x}" y2="${height - padY}" stroke="#ccd1d7" stroke-width="2"/><circle cx="${sp.x}" cy="${sp.y}" r="6" fill="#f24a73"/>` : ""}
    </svg>
  `;
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