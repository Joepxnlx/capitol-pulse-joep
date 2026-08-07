'use strict';

const DATA_URL = './public/data/live.json';
const ANALYSIS_URL = './public/data/analysis.json';
const MARKET_URL = './public/data/sp500.json';
const CACHE_KEY = 'capitol-pulse-data-cache-v1';
const ANALYSIS_CACHE_KEY = 'capitol-pulse-analysis-cache-v1';
const MARKET_CACHE_KEY = 'capitol-pulse-market-cache-v1';
const FAVORITES_KEY = 'capitol-pulse-favorites-v1';
const JOURNAL_KEY = 'capitol-pulse-journal-v1';
const PAGE_SIZE = 30;
const MARKET_PAGE_SIZE = 24;

const $ = (id) => document.getElementById(id);
const elements = {
  dataStatus: $('dataStatus'),
  statusTitle: $('statusTitle'),
  statusText: $('statusText'),
  refreshButton: $('refreshButton'),
  installButton: $('installButton'),
  searchInput: $('searchInput'),
  chamberFilter: $('chamberFilter'),
  typeFilter: $('typeFilter'),
  favoriteFilter: $('favoriteFilter'),
  sortFilter: $('sortFilter'),
  statTotal: $('statTotal'),
  statPurchases: $('statPurchases'),
  statSales: $('statSales'),
  statDelay: $('statDelay'),
  decisionCounts: $('decisionCounts'),
  decisionBoard: $('decisionBoard'),
  notificationFrequency: $('notificationFrequency'),
  notificationActiveDays: $('notificationActiveDays'),
  marketFreshness: $('marketFreshness'),
  marketStats: $('marketStats'),
  marketCongressStats: $('marketCongressStats'),
  marketSearch: $('marketSearch'),
  marketSector: $('marketSector'),
  marketSignal: $('marketSignal'),
  marketCongress: $('marketCongress'),
  marketRisk: $('marketRisk'),
  marketSort: $('marketSort'),
  marketStatus: $('marketStatus'),
  marketCompare: $('marketCompare'),
  marketList: $('marketList'),
  marketLoadMore: $('marketLoadMore'),
  journalForm: $('journalForm'),
  journalSymbol: $('journalSymbol'),
  journalSymbols: $('journalSymbols'),
  journalType: $('journalType'),
  journalDate: $('journalDate'),
  journalQuantity: $('journalQuantity'),
  journalPrice: $('journalPrice'),
  journalFees: $('journalFees'),
  journalFormStatus: $('journalFormStatus'),
  journalStats: $('journalStats'),
  journalPositions: $('journalPositions'),
  journalHistory: $('journalHistory'),
  journalExportButton: $('journalExportButton'),
  portfolioInsights: $('portfolioInsights'),
  resultCount: $('resultCount'),
  tradesList: $('tradesList'),
  loadMoreButton: $('loadMoreButton'),
  favoritesSummary: $('favoritesSummary'),
  lastUpdated: $('lastUpdated'),
  analysisFreshness: $('analysisFreshness'),
  politicianChoices: $('politicianChoices'),
  analysisBudget: $('analysisBudget'),
  analysisRisk: $('analysisRisk'),
  analysisStatus: $('analysisStatus'),
  analysisCards: $('analysisCards'),
  detailDialog: $('detailDialog'),
  detailContent: $('detailContent'),
  closeDialogButton: $('closeDialogButton'),
};

const state = {
  trades: [],
  metadata: {},
  analysis: null,
  marketScan: null,
  congressByTicker: new Map(),
  selectedPolitician: 'all',
  visible: PAGE_SIZE,
  marketVisible: MARKET_PAGE_SIZE,
  marketCompare: [],
  favorites: readFavorites(),
  journal: readJournal(),
  installPrompt: null,
};

function readFavorites() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '{}');
    return {
      politicians: Array.isArray(parsed.politicians) ? parsed.politicians.filter(Boolean) : [],
      tickers: Array.isArray(parsed.tickers) ? parsed.tickers.filter(Boolean) : [],
    };
  } catch {
    return { politicians: [], tickers: [] };
  }
}

function readJournal() {
  try {
    const parsed = JSON.parse(localStorage.getItem(JOURNAL_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((entry) => (
      entry && entry.id && entry.symbol && ['BUY', 'SELL'].includes(entry.type)
      && Number(entry.quantity) > 0 && Number(entry.price) > 0
    )) : [];
  } catch {
    return [];
  }
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function safeUrl(value = '') {
  try {
    const url = new URL(value, window.location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = parseDate(value);
  return date
    ? new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date)
    : 'Onbekend';
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Bijwerktijd onbekend'
    : `Dataset bijgewerkt ${new Intl.DateTimeFormat('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }).format(date)}`;
}

function formatCurrency(value, currency = 'USD') {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'Niet beschikbaar';
  try {
    return new Intl.NumberFormat('nl-NL', { style: 'currency', currency, maximumFractionDigits: 2 }).format(number);
  } catch {
    return `${currency} ${number.toFixed(2)}`;
  }
}

function formatCompactNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('nl-NL', { maximumFractionDigits: 1 }) : '–';
}

function isPurchase(value = '') { return /purchase|buy|aankoop/i.test(value); }
function isSale(value = '') { return /sale|sell|verkoop/i.test(value); }
function typeLabel(value = '') {
  if (isPurchase(value)) return 'Aankoop';
  if (isSale(value)) return 'Verkoop';
  if (/exchange/i.test(value)) return 'Omwisseling';
  return value || 'Overig';
}

function delayFor(trade) {
  if (Number.isFinite(trade.reportingDelayDays)) return trade.reportingDelayDays;
  const transaction = parseDate(trade.transactionDate);
  const disclosure = parseDate(trade.disclosureDate);
  return transaction && disclosure ? Math.round((disclosure - transaction) / 86400000) : null;
}

function midpoint(trade) {
  const low = Number(trade.amountMin) || 0;
  const high = Number(trade.amountMax) || low;
  return (low + high) / 2;
}

function setStatus(mode, title, text) {
  elements.dataStatus.classList.toggle('live', mode === 'live');
  elements.dataStatus.classList.toggle('error', mode === 'error');
  elements.statusTitle.textContent = title;
  elements.statusText.textContent = text;
}

async function fetchPayload() {
  const response = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.trades) || payload.trades.length === 0) {
    throw new Error('De dataset bevat geen transacties.');
  }
  return payload;
}

async function fetchAnalysisPayload() {
  const response = await fetch(`${ANALYSIS_URL}?v=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.stocks) || payload.stocks.length === 0) {
    throw new Error('De analyse bevat geen aandelen.');
  }
  return payload;
}

async function fetchMarketPayload() {
  const response = await fetch(`${MARKET_URL}?v=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.stocks) || payload.stocks.length === 0) {
    throw new Error('De eerste volledige S&P 500-scan wordt nog opgebouwd.');
  }
  return payload;
}

function readCachedPayload() {
  try {
    const payload = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return payload && Array.isArray(payload.trades) && payload.trades.length ? payload : null;
  } catch {
    return null;
  }
}

function readCachedAnalysis() {
  try {
    const payload = JSON.parse(localStorage.getItem(ANALYSIS_CACHE_KEY) || 'null');
    return payload && Array.isArray(payload.stocks) && payload.stocks.length ? payload : null;
  } catch {
    return null;
  }
}

function readCachedMarket() {
  try {
    const payload = JSON.parse(localStorage.getItem(MARKET_CACHE_KEY) || 'null');
    return payload && Array.isArray(payload.stocks) && payload.stocks.length ? payload : null;
  } catch {
    return null;
  }
}

function normalizedTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/-/g, '.');
}

function indexCongressTrades() {
  const index = new Map();
  state.trades.forEach((trade) => {
    const symbol = normalizedTicker(trade.symbol);
    if (!symbol) return;
    if (!index.has(symbol)) index.set(symbol, []);
    index.get(symbol).push(trade);
  });
  index.forEach((trades) => trades.sort((left, right) => (
    String(right.disclosureDate || '').localeCompare(String(left.disclosureDate || ''))
    || String(right.transactionDate || '').localeCompare(String(left.transactionDate || ''))
    || String(right.id || '').localeCompare(String(left.id || ''))
  )));
  state.congressByTicker = index;
}

function congressActivity(symbol) {
  const trades = state.congressByTicker.get(normalizedTicker(symbol)) || [];
  const purchases = trades.filter((trade) => isPurchase(trade.type)).length;
  const sales = trades.filter((trade) => isSale(trade.type)).length;
  const politicians = [...new Set(trades.map((trade) => trade.politician).filter(Boolean))];
  const latest = trades[0] || null;
  return {
    trades,
    purchases,
    sales,
    politicians,
    latest,
    netCount: purchases - sales,
    latestIsPurchase: Boolean(latest && isPurchase(latest.type)),
    latestIsSale: Boolean(latest && isSale(latest.type)),
  };
}

function applyPayload(payload, cached = false) {
  state.trades = payload.trades.filter((trade) => trade && trade.id && trade.politician);
  state.metadata = payload.metadata || {};
  indexCongressTrades();
  state.visible = PAGE_SIZE;
  renderAll();
  if (state.marketScan) renderMarketScan();
  if (cached) {
    setStatus('error', 'Offline gegevens', 'De laatste lokaal bewaarde dataset wordt getoond.');
  } else {
    setStatus('live', 'Feed beschikbaar', `${state.trades.toLocaleString ? state.trades.length.toLocaleString('nl-NL') : state.trades.length} openbare transacties geladen.`);
  }
}

async function loadData({ manual = false } = {}) {
  elements.refreshButton.disabled = true;
  if (!state.trades.length || manual) {
    setStatus('loading', manual ? 'Vernieuwen…' : 'Gegevens laden…', 'De nieuwste openbaar gemaakte transacties worden opgehaald.');
  }
  try {
    const payload = await fetchPayload();
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(payload)); } catch { /* Opslag kan vol of geblokkeerd zijn. */ }
    applyPayload(payload);
  } catch (error) {
    const cached = readCachedPayload();
    if (cached && !state.trades.length) {
      applyPayload(cached, true);
    } else if (state.trades.length) {
      setStatus('error', 'Vernieuwen mislukt', 'De huidige gegevens blijven staan. Probeer het later opnieuw.');
    } else {
      setStatus('error', 'Gegevens niet bereikbaar', 'Er is nog geen lokale dataset beschikbaar. Probeer het later opnieuw.');
      elements.tradesList.innerHTML = '<div class="empty">De transacties konden niet worden geladen.</div>';
    }
    console.error('Capitol Pulse kon de dataset niet laden:', error);
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function loadAnalysis({ manual = false } = {}) {
  if (manual) elements.analysisStatus.textContent = 'Analyse vernieuwen…';
  try {
    const payload = await fetchAnalysisPayload();
    state.analysis = payload;
    try { localStorage.setItem(ANALYSIS_CACHE_KEY, JSON.stringify(payload)); } catch { /* Niet essentieel. */ }
    renderAnalysis();
  } catch (error) {
    const cached = readCachedAnalysis();
    if (cached) {
      state.analysis = cached;
      renderAnalysis(true);
    } else {
      elements.analysisFreshness.textContent = 'Niet beschikbaar';
      elements.analysisStatus.textContent = 'De aandelenanalyse kon niet worden geladen. De transacties blijven wel beschikbaar.';
      elements.analysisCards.innerHTML = '';
    }
    console.error('Capitol Pulse kon de aandelenanalyse niet laden:', error);
  }
}

async function loadMarketScan({ manual = false } = {}) {
  if (manual) elements.marketStatus.textContent = 'Volledige marktscan vernieuwen…';
  try {
    const payload = await fetchMarketPayload();
    state.marketScan = payload;
    state.marketVisible = MARKET_PAGE_SIZE;
    try { localStorage.setItem(MARKET_CACHE_KEY, JSON.stringify(payload)); } catch { /* Niet essentieel. */ }
    renderMarketScan();
  } catch (error) {
    const cached = readCachedMarket();
    if (cached) {
      state.marketScan = cached;
      renderMarketScan(true);
    } else {
      elements.marketFreshness.textContent = 'Eerste scan in voorbereiding';
      elements.marketStatus.textContent = 'De automatische GitHub-workflow bouwt de eerste volledige S&P 500-scan. Probeer het over enkele minuten opnieuw.';
      elements.marketStats.innerHTML = '';
      elements.marketCongressStats.innerHTML = '';
      elements.marketList.innerHTML = '<div class="empty">Nog geen marktscan beschikbaar. De congresanalyse en transacties blijven gewoon werken.</div>';
    }
    console.error('Capitol Pulse kon de S&P 500-scan niet laden:', error);
  }
}

function actionLabel(value) {
  return value === 'Purchase' ? 'Aankoop' : value === 'Sale' ? 'Verkoop' : value || 'Onbekend';
}

function renderPoliticianChoices() {
  if (!state.analysis) return;
  const people = state.analysis.featuredPoliticians || [];
  const choices = [{ name: 'all', label: 'Alle vijf' }, ...people.map((person) => ({
    name: person.name,
    label: person.name,
  }))];
  elements.politicianChoices.innerHTML = choices.map((choice) => `
    <button class="politician-choice ${state.selectedPolitician === choice.name ? 'active' : ''}" type="button" data-analysis-politician="${escapeHtml(choice.name)}">
      ${escapeHtml(choice.label)}
    </button>`).join('');
  elements.politicianChoices.querySelectorAll('[data-analysis-politician]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedPolitician = button.dataset.analysisPolitician;
      renderAnalysis();
    });
  });
}

const FACTOR_THRESHOLDS = {
  growth: 'Omzetgroei ≥ 3% én nettowinstgroei ≥ 0% jaar-op-jaar',
  profitability: 'Nettomarge over vier kwartalen ≥ 8%',
  cashflow: 'Vrije-kasstroommarge positief en ≥ 5%',
  valuation: 'K/W > 0 en ≤ 35 én schuld/eigen vermogen ≤ 3',
  trend: 'Koers > SMA200, SMA50 > SMA200, RSI 40–72 en volatiliteit ≤ 55%',
};

function stockDecision(stock) {
  const score = Number(stock.score) || 0;
  const failed = (stock.factors || []).filter((factor) => factor.status !== 'good').map((factor) => factor.label);
  const sold = stock.politicianSignal?.action === 'Sale';
  if (stock.signal === 'BUY' && !sold && score === 5) {
    return { key: 'buy', label: 'Koopkandidaat', reason: 'Recente openbare aankoop en alle vijf controles zijn groen.' };
  }
  if (sold) {
    return { key: 'no', label: 'Niet kopen', reason: 'De nieuwste congresmelding voor dit aandeel is een verkoop.' };
  }
  if (stock.signal === 'WAIT' || score === 4) {
    return { key: 'wait', label: 'Wachten', reason: failed.length ? `Nog niet groen: ${failed.join(', ')}.` : 'Wacht op een volledige 5/5-bevestiging.' };
  }
  return {
    key: 'no',
    label: 'Niet kopen',
    reason: failed.length ? `Afgewezen op: ${failed.join(', ')}.` : 'Geen geldige recente aankoop met volledige 5/5-bevestiging.',
  };
}

function renderDecisionBoard() {
  if (!state.analysis) {
    elements.decisionCounts.innerHTML = '';
    elements.decisionBoard.innerHTML = '<div class="empty">De beslissamenvatting wordt geladen.</div>';
    return;
  }
  const order = { buy: 0, wait: 1, no: 2 };
  const stocks = [...state.analysis.stocks].sort((left, right) => {
    const category = order[stockDecision(left).key] - order[stockDecision(right).key];
    return category || (Number(right.score) || 0) - (Number(left.score) || 0) || left.symbol.localeCompare(right.symbol);
  });
  const counts = stocks.reduce((result, stock) => {
    result[stockDecision(stock).key] += 1;
    return result;
  }, { buy: 0, wait: 0, no: 0 });
  elements.decisionCounts.innerHTML = `
    <div class="decision-count buy"><strong>${counts.buy}</strong><span>Koopkandidaat</span></div>
    <div class="decision-count wait"><strong>${counts.wait}</strong><span>Wachten</span></div>
    <div class="decision-count no"><strong>${counts.no}</strong><span>Niet kopen</span></div>`;

  elements.decisionBoard.innerHTML = stocks.map((stock) => {
    const decision = stockDecision(stock);
    const strategy = stock.strategy || {};
    const buyPlan = decision.key === 'buy' ? `
      <div class="decision-plan">
        <span>Instap tot <strong>${formatCurrency(strategy.entryHigh, stock.currency)}</strong></span>
        <span>Stop <strong>${formatCurrency(strategy.stopLoss, stock.currency)}</strong></span>
        <span>Doel <strong>${formatCurrency(strategy.takeProfit, stock.currency)}</strong></span>
      </div>` : '';
    return `<article class="decision-card ${decision.key}">
      <div class="decision-card-head">
        <div><strong>${escapeHtml(stock.symbol)}</strong><span>${escapeHtml(stock.company)}</span></div>
        <span class="decision-label">${decision.label}</span>
      </div>
      <p>${escapeHtml(decision.reason)}</p>
      <small>${escapeHtml(stock.politician)} · ${actionLabel(stock.politicianSignal?.action)} · score ${Number(stock.score) || 0}/5 · koers ${formatCurrency(stock.market?.price, stock.currency)}</small>
      ${buyPlan}
      <div class="decision-actions">
        <button class="button button-secondary" type="button" data-focus-analysis="${escapeHtml(stock.id || `${stock.politician}:${stock.symbol}`)}">Bekijk onderbouwing</button>
        ${decision.key === 'buy' ? `<button class="button" type="button" data-journal-buy="${escapeHtml(stock.symbol)}">Aankoop registreren</button>` : ''}
      </div>
    </article>`;
  }).join('');

  elements.decisionBoard.querySelectorAll('[data-focus-analysis]').forEach((button) => {
    button.addEventListener('click', () => {
      const stock = state.analysis.stocks.find((item) => (item.id || `${item.politician}:${item.symbol}`) === button.dataset.focusAnalysis);
      if (!stock) return;
      state.selectedPolitician = stock.politician;
      renderAnalysis();
      document.querySelector(`[data-analysis-id="${CSS.escape(button.dataset.focusAnalysis)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  elements.decisionBoard.querySelectorAll('[data-journal-buy]').forEach((button) => {
    button.addEventListener('click', () => prepareJournalEntry(button.dataset.journalBuy, 'BUY'));
  });
}

function renderNotificationInsights() {
  if (!state.trades.length) return;
  const people = new Set((state.analysis?.featuredPoliticians || []).map((person) => person.name));
  const symbols = new Set((state.analysis?.stocks || []).map((stock) => stock.symbol));
  const relevant = state.trades.filter((trade) => people.has(trade.politician) || symbols.has(trade.symbol));
  const dates = relevant.map((trade) => trade.disclosureDate).filter((date) => parseDate(date)).sort();
  if (!dates.length) {
    elements.notificationFrequency.textContent = 'Niet genoeg gegevens om een ritme te berekenen.';
    elements.notificationActiveDays.textContent = '0';
    return;
  }
  const latest = parseDate(dates[dates.length - 1]);
  const from = new Date(latest.getTime() - 27 * 86400000);
  const activeDates = new Set(relevant.filter((trade) => {
    const date = parseDate(trade.disclosureDate);
    return date && date >= from && date <= latest;
  }).map((trade) => trade.disclosureDate));
  const perWeek = activeDates.size / 4;
  const readable = perWeek < 0.75 ? 'minder dan één' : perWeek < 1.5 ? 'ongeveer één' : `ongeveer ${perWeek.toLocaleString('nl-NL', { maximumFractionDigits: 1 })}`;
  elements.notificationFrequency.textContent = `${readable} meldingsdagen per week, op basis van de laatste 28 dagen.`;
  elements.notificationActiveDays.textContent = `${activeDates.size} in 28 dagen`;
}

function formatSignedPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'Niet beschikbaar';
  return `${number > 0 ? '+' : ''}${number.toLocaleString('nl-NL', { maximumFractionDigits: 1 })}%`;
}

function currentMarketStock(symbol) {
  const normalized = String(symbol || '').toUpperCase();
  return state.marketScan?.stocks.find((stock) => stock.symbol === normalized)
    || state.analysis?.stocks.find((stock) => stock.symbol === normalized)
    || null;
}

function filteredMarketStocks() {
  if (!state.marketScan) return [];
  const query = elements.marketSearch.value.trim().toLocaleLowerCase('nl-NL');
  const sector = elements.marketSector.value;
  const signal = elements.marketSignal.value;
  const congressFilter = elements.marketCongress.value;
  const maximumRisk = elements.marketRisk.value === 'all' ? null : Number(elements.marketRisk.value);
  const rows = state.marketScan.stocks.filter((stock) => {
    const activity = congressActivity(stock.symbol);
    const searchable = `${stock.symbol} ${stock.company} ${activity.politicians.join(' ')}`.toLocaleLowerCase('nl-NL');
    if (query && !searchable.includes(query)) return false;
    if (sector !== 'all' && stock.sector !== sector) return false;
    if (signal === 'favorites' && !state.favorites.tickers.includes(stock.symbol)) return false;
    if (!['all', 'favorites'].includes(signal) && stock.status !== signal) return false;
    if (congressFilter === 'activity' && !activity.trades.length) return false;
    if (congressFilter === 'purchases' && !activity.purchases) return false;
    if (congressFilter === 'sales' && !activity.sales) return false;
    if (congressFilter === 'latest-buy' && !activity.latestIsPurchase) return false;
    if (congressFilter === 'net-buy' && activity.netCount <= 0) return false;
    if (congressFilter === 'combined' && !(stock.status === 'CANDIDATE' && activity.latestIsPurchase)) return false;
    if (congressFilter === 'none' && activity.trades.length) return false;
    if (maximumRisk !== null && Number(stock.annualizedVolatilityPct) > maximumRisk) return false;
    return true;
  });
  const sort = elements.marketSort.value;
  rows.sort((left, right) => {
    const leftActivity = congressActivity(left.symbol);
    const rightActivity = congressActivity(right.symbol);
    if (sort === 'congress-latest') return String(rightActivity.latest?.disclosureDate || '').localeCompare(String(leftActivity.latest?.disclosureDate || '')) || left.symbol.localeCompare(right.symbol);
    if (sort === 'congress-volume') return rightActivity.trades.length - leftActivity.trades.length || left.symbol.localeCompare(right.symbol);
    if (sort === 'congress-net') return rightActivity.netCount - leftActivity.netCount || rightActivity.purchases - leftActivity.purchases || left.symbol.localeCompare(right.symbol);
    if (sort === 'relative') return (Number(right.relativeStrengthPctPoints) || -999) - (Number(left.relativeStrengthPctPoints) || -999);
    if (sort === 'return') return (Number(right.oneYearReturnPct) || -999) - (Number(left.oneYearReturnPct) || -999);
    if (sort === 'risk') return (Number(left.annualizedVolatilityPct) || 999) - (Number(right.annualizedVolatilityPct) || 999);
    if (sort === 'symbol') return left.symbol.localeCompare(right.symbol);
    return (Number(right.score) || 0) - (Number(left.score) || 0)
      || (Number(right.relativeStrengthPctPoints) || -999) - (Number(left.relativeStrengthPctPoints) || -999)
      || left.symbol.localeCompare(right.symbol);
  });
  return rows;
}

function congressTradeRow(trade) {
  const sourceUrl = safeUrl(trade.sourceUrl);
  const delay = delayFor(trade);
  const actionClass = isPurchase(trade.type) ? 'purchase' : isSale(trade.type) ? 'sale' : '';
  return `<article class="congress-trade-row">
    <div class="congress-trade-main">
      <span class="badge ${actionClass}">${escapeHtml(typeLabel(trade.type))}</span>
      <div><strong>${escapeHtml(trade.politician)}</strong><small>${escapeHtml(trade.chamber)} · ${escapeHtml(trade.owner || 'Eigenaar onbekend')}</small></div>
    </div>
    <div class="congress-trade-dates">
      <strong>${escapeHtml(trade.amount || 'Bedrag onbekend')}</strong>
      <small>Transactie ${escapeHtml(formatDate(trade.transactionDate))} · melding ${escapeHtml(formatDate(trade.disclosureDate))}${Number.isFinite(delay) ? ` · ${delay} dgn later` : ''}</small>
      ${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Filingbron ↗</a>` : '<small>Bronlink niet beschikbaar</small>'}
    </div>
  </article>`;
}

function congressBlock(stock, activity) {
  if (!activity.trades.length) {
    return `<div class="congress-empty">
      <strong>Geen congresmelding in de huidige feed</strong>
      <span>Voor ${escapeHtml(stock.symbol)} is binnen de ${state.trades.length.toLocaleString('nl-NL')} geladen recente openbaarmakingen geen aankoop of verkoop gevonden.</span>
    </div>`;
  }
  const latest = activity.latest;
  const combined = stock.status === 'CANDIDATE' && activity.latestIsPurchase;
  const recentRows = activity.trades.slice(0, 5).map(congressTradeRow).join('');
  const remaining = Math.max(0, activity.trades.length - 5);
  return `<div class="congress-summary ${combined ? 'combined' : ''}">
    <div class="congress-summary-head">
      <div><span>Openbare Congresactiviteit</span><strong>${combined ? 'Congreskoop + technisch 6/6' : `${activity.trades.length} melding${activity.trades.length === 1 ? '' : 'en'}`}</strong></div>
      ${combined ? '<span class="combined-badge">Dubbel signaal</span>' : ''}
    </div>
    <div class="congress-counts">
      <span><strong>${activity.purchases}</strong> aankopen</span>
      <span><strong>${activity.sales}</strong> verkopen</span>
      <span><strong>${activity.politicians.length}</strong> politici</span>
    </div>
    <p>Laatste: <strong>${escapeHtml(typeLabel(latest.type))}</strong> door ${escapeHtml(latest.politician)} · openbaar ${escapeHtml(formatDate(latest.disclosureDate))}.</p>
  </div>
  <details class="congress-details" ${combined ? 'open' : ''}>
    <summary>Bekijk recente aankopen en verkopen</summary>
    <div class="congress-trade-list">${recentRows}</div>
    ${remaining ? `<p class="congress-more">Nog ${remaining} melding${remaining === 1 ? '' : 'en'} beschikbaar via “Toon alle meldingen”.</p>` : ''}
    <button class="button button-secondary" type="button" data-market-trades="${escapeHtml(stock.symbol)}">Toon alle meldingen voor ${escapeHtml(stock.symbol)}</button>
  </details>`;
}

function marketCard(stock) {
  const favorite = state.favorites.tickers.includes(stock.symbol);
  const compared = state.marketCompare.includes(stock.symbol);
  const statusClass = String(stock.status || '').toLowerCase();
  const sourceUrl = safeUrl(stock.marketSourceUrl);
  const activity = congressActivity(stock.symbol);
  const combined = stock.status === 'CANDIDATE' && activity.latestIsPurchase;
  const checks = (stock.checks || []).map((item) => `
    <li class="scan-check ${item.passed ? 'good' : 'bad'}" title="${escapeHtml(item.threshold)}">
      <span>${item.passed ? '✓' : '×'}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></div>
    </li>`).join('');
  const plan = stock.strategy?.active ? `<div class="scan-plan">
    <div><span>Instapvoorbeeld</span><strong>${formatCurrency(stock.strategy.entry, stock.currency)}</strong></div>
    <div><span>Stop-loss</span><strong>${formatCurrency(stock.strategy.stopLoss, stock.currency)}</strong></div>
    <div><span>2R-doel</span><strong>${formatCurrency(stock.strategy.takeProfit, stock.currency)}</strong></div>
  </div>` : '';
  return `<article class="market-card ${statusClass} ${combined ? 'congress-confirmed' : ''}">
    <div class="market-card-head">
      <div class="market-symbol"><strong>${escapeHtml(stock.symbol)}</strong><span>${escapeHtml(stock.company)}</span><small>${escapeHtml(stock.sector)}</small></div>
      <div class="market-score"><strong>${Number(stock.score) || 0}/6</strong><span>${escapeHtml(stock.signalLabel)}</span></div>
    </div>
    <div class="market-metrics">
      <div><span>Koers</span><strong>${formatCurrency(stock.price, stock.currency)}</strong></div>
      <div><span>1 jaar</span><strong class="${resultClass(stock.oneYearReturnPct)}">${formatSignedPercent(stock.oneYearReturnPct)}</strong></div>
      <div><span>vs. S&P</span><strong class="${resultClass(stock.relativeStrengthPctPoints)}">${formatSignedPercent(stock.relativeStrengthPctPoints)}</strong></div>
      <div><span>Volatiliteit</span><strong>${formatCompactNumber(stock.annualizedVolatilityPct)}%</strong></div>
    </div>
    <details class="scan-details" ${stock.status === 'CANDIDATE' ? 'open' : ''}>
      <summary>Bekijk de zes controles</summary>
      <ul>${checks}</ul>
    </details>
    ${plan}
    ${congressBlock(stock, activity)}
    <div class="market-actions">
      <button class="icon-button market-star ${favorite ? 'active' : ''}" type="button" data-market-favorite="${escapeHtml(stock.symbol)}" aria-label="${favorite ? 'Stop met ticker volgen' : 'Volg ticker'}">★</button>
      <button class="button button-secondary compare-button ${compared ? 'active' : ''}" type="button" data-market-compare="${escapeHtml(stock.symbol)}">${compared ? 'In vergelijking' : 'Vergelijk'}</button>
      ${stock.status === 'CANDIDATE' ? `<button class="button" type="button" data-market-journal="${escapeHtml(stock.symbol)}">Registreer koop</button>` : ''}
      ${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Marktbron ↗</a>` : ''}
    </div>
  </article>`;
}

function renderMarketComparison() {
  const selected = state.marketCompare.map((symbol) => currentMarketStock(symbol)).filter(Boolean);
  elements.marketCompare.classList.toggle('hidden', !selected.length);
  if (!selected.length) {
    elements.marketCompare.innerHTML = '';
    return;
  }
  const rows = [
    ['Score', (stock) => `${stock.score}/6`],
    ['Koers', (stock) => formatCurrency(stock.price, stock.currency)],
    ['1-jaarsrendement', (stock) => formatSignedPercent(stock.oneYearReturnPct)],
    ['Sterkte versus S&P', (stock) => formatSignedPercent(stock.relativeStrengthPctPoints)],
    ['RSI', (stock) => formatCompactNumber(stock.rsi14)],
    ['Volatiliteit', (stock) => `${formatCompactNumber(stock.annualizedVolatilityPct)}%`],
    ['Congresmeldingen', (stock) => {
      const activity = congressActivity(stock.symbol);
      return `${activity.purchases} koop / ${activity.sales} verkoop`;
    }],
    ['Laatste congresactie', (stock) => {
      const latest = congressActivity(stock.symbol).latest;
      return latest ? `${typeLabel(latest.type)} · ${latest.politician}` : 'Geen in huidige feed';
    }],
    ['Sector', (stock) => stock.sector],
  ];
  elements.marketCompare.innerHTML = `
    <div class="compare-heading"><div><p class="eyebrow">Naast elkaar</p><h3>Vergelijk maximaal drie aandelen</h3></div><button class="button button-secondary" id="clearMarketCompare" type="button">Wis vergelijking</button></div>
    <div class="compare-table" style="--compare-count:${selected.length}">
      <div class="compare-label"></div>${selected.map((stock) => `<strong>${escapeHtml(stock.symbol)}</strong>`).join('')}
      ${rows.map(([label, formatter]) => `<span class="compare-label">${label}</span>${selected.map((stock) => `<span>${escapeHtml(formatter(stock))}</span>`).join('')}`).join('')}
    </div>`;
  document.getElementById('clearMarketCompare').addEventListener('click', () => {
    state.marketCompare = [];
    renderMarketScan();
  });
}

function toggleMarketCompare(symbol) {
  const index = state.marketCompare.indexOf(symbol);
  if (index >= 0) state.marketCompare.splice(index, 1);
  else if (state.marketCompare.length < 3) state.marketCompare.push(symbol);
  else {
    elements.marketStatus.textContent = 'Je kunt maximaal drie aandelen tegelijk vergelijken. Verwijder er eerst één.';
    return;
  }
  renderMarketScan();
}

function renderMarketScan(cached = false) {
  if (!state.marketScan) return;
  const metadata = state.marketScan.metadata || {};
  const sectors = [...new Set(state.marketScan.stocks.map((stock) => stock.sector).filter(Boolean))].sort();
  const selectedSector = elements.marketSector.value;
  elements.marketSector.innerHTML = '<option value="all">Alle sectoren</option>'
    + sectors.map((sector) => `<option value="${escapeHtml(sector)}">${escapeHtml(sector)}</option>`).join('');
  elements.marketSector.value = sectors.includes(selectedSector) ? selectedSector : 'all';
  const candidates = state.marketScan.stocks.filter((stock) => stock.status === 'CANDIDATE').length;
  const watches = state.marketScan.stocks.filter((stock) => stock.status === 'WATCH').length;
  const marketActivities = state.marketScan.stocks.map((stock) => ({ stock, activity: congressActivity(stock.symbol) }));
  const stocksWithActivity = marketActivities.filter((item) => item.activity.trades.length).length;
  const congressPurchases = marketActivities.reduce((sum, item) => sum + item.activity.purchases, 0);
  const congressSales = marketActivities.reduce((sum, item) => sum + item.activity.sales, 0);
  const combinedSignals = marketActivities.filter((item) => item.stock.status === 'CANDIDATE' && item.activity.latestIsPurchase).length;
  elements.marketFreshness.textContent = `${cached ? 'Lokale kopie · ' : ''}${metadata.scanDate ? `Koersen ${formatDate(metadata.scanDate)}` : formatDateTime(metadata.updatedAt)}`;
  elements.marketStats.innerHTML = `
    <article><span>Geanalyseerd</span><strong>${state.marketScan.stocks.length.toLocaleString('nl-NL')}</strong><small>S&P 500-noteringen</small></article>
    <article class="candidate"><span>Technische kandidaten</span><strong>${candidates}</strong><small>alle zes controles groen</small></article>
    <article class="watch"><span>Bijna bevestigd</span><strong>${watches}</strong><small>vijf van zes groen</small></article>
    <article><span>SPY in één jaar</span><strong class="${resultClass(metadata.benchmarkOneYearReturnPct)}">${formatSignedPercent(metadata.benchmarkOneYearReturnPct)}</strong><small>benchmark voor relatieve sterkte</small></article>`;
  elements.marketCongressStats.innerHTML = `
    <article><span>S&P-aandelen met melding</span><strong>${stocksWithActivity.toLocaleString('nl-NL')}</strong><small>binnen de huidige openbare feed</small></article>
    <article class="purchase"><span>Congresaankopen</span><strong>${congressPurchases.toLocaleString('nl-NL')}</strong><small>openbaar gemaakte regels</small></article>
    <article class="sale"><span>Congresverkopen</span><strong>${congressSales.toLocaleString('nl-NL')}</strong><small>openbaar gemaakte regels</small></article>
    <article class="combined"><span>Congreskoop + 6/6</span><strong>${combinedSignals.toLocaleString('nl-NL')}</strong><small>laatste actie koop én technisch groen</small></article>`;
  const rows = filteredMarketStocks();
  const visible = rows.slice(0, state.marketVisible);
  elements.marketStatus.textContent = `${rows.length.toLocaleString('nl-NL')} resultaten · ${stocksWithActivity} S&P-aandelen met congresmelding · ${combinedSignals} gecombineerde signalen`;
  elements.marketList.innerHTML = visible.length ? visible.map(marketCard).join('') : '<div class="empty">Geen aandelen gevonden voor deze filters.</div>';
  elements.marketLoadMore.classList.toggle('hidden', state.marketVisible >= rows.length);
  renderMarketComparison();
  elements.marketList.querySelectorAll('[data-market-favorite]').forEach((button) => {
    button.addEventListener('click', () => toggleFavorite('tickers', button.dataset.marketFavorite));
  });
  elements.marketList.querySelectorAll('[data-market-compare]').forEach((button) => {
    button.addEventListener('click', () => toggleMarketCompare(button.dataset.marketCompare));
  });
  elements.marketList.querySelectorAll('[data-market-journal]').forEach((button) => {
    button.addEventListener('click', () => prepareJournalEntry(button.dataset.marketJournal, 'BUY'));
  });
  elements.marketList.querySelectorAll('[data-market-trades]').forEach((button) => {
    button.addEventListener('click', () => {
      elements.searchInput.value = button.dataset.marketTrades;
      state.visible = PAGE_SIZE;
      renderTrades();
      document.getElementById('transacties')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  renderJournal();
}

function journalCalculations() {
  const books = new Map();
  const sorted = [...state.journal].sort((left, right) => (
    String(left.date).localeCompare(String(right.date)) || Number(left.createdAt || 0) - Number(right.createdAt || 0)
  ));
  sorted.forEach((entry) => {
    const symbol = String(entry.symbol).toUpperCase();
    const book = books.get(symbol) || { symbol, lots: [], realized: 0, lastPrice: Number(entry.price) };
    const quantity = Number(entry.quantity);
    const price = Number(entry.price);
    const fees = Math.max(0, Number(entry.fees) || 0);
    book.lastPrice = price;
    if (entry.type === 'BUY') {
      book.lots.push({ quantity, unitCost: ((quantity * price) + fees) / quantity });
    } else {
      let remaining = quantity;
      let cost = 0;
      while (remaining > 0.0000001 && book.lots.length) {
        const lot = book.lots[0];
        const used = Math.min(remaining, lot.quantity);
        cost += used * lot.unitCost;
        lot.quantity -= used;
        remaining -= used;
        if (lot.quantity < 0.0000001) book.lots.shift();
      }
      book.realized += (quantity * price) - fees - cost;
    }
    books.set(symbol, book);
  });

  let realized = 0;
  let openCost = 0;
  let marketValue = 0;
  const positions = [...books.values()].map((book) => {
    realized += book.realized;
    const quantity = book.lots.reduce((sum, lot) => sum + lot.quantity, 0);
    const cost = book.lots.reduce((sum, lot) => sum + lot.quantity * lot.unitCost, 0);
    const currentStock = currentMarketStock(book.symbol);
    const current = currentStock?.price ?? currentStock?.market?.price;
    const marketPrice = Number(current) > 0 ? Number(current) : book.lastPrice;
    const value = quantity * marketPrice;
    openCost += cost;
    marketValue += value;
    return {
      symbol: book.symbol,
      quantity,
      cost,
      averageCost: quantity ? cost / quantity : 0,
      marketPrice,
      marketValue: value,
      unrealized: value - cost,
      realized: book.realized,
      sector: currentStock?.sector || 'Niet in S&P 500-scan',
    };
  }).filter((position) => position.quantity > 0.0000001).sort((left, right) => right.marketValue - left.marketValue);
  return { positions, realized, openCost, marketValue, unrealized: marketValue - openCost };
}

function resultClass(value) {
  return Number(value) > 0.004 ? 'positive' : Number(value) < -0.004 ? 'negative' : 'neutral';
}

function renderPortfolioInsights(result) {
  if (!result.positions.length || result.marketValue <= 0) {
    elements.portfolioInsights.innerHTML = `<div class="portfolio-empty">
      <strong>Spreidingsmeter</strong><span>Na je eerste aankoop zie je hier sectorverdeling en concentratierisico.</span>
    </div>`;
    return;
  }
  const sectors = new Map();
  result.positions.forEach((position) => {
    sectors.set(position.sector, (sectors.get(position.sector) || 0) + position.marketValue);
  });
  const sectorRows = [...sectors.entries()].map(([sector, value]) => ({
    sector,
    value,
    percent: value / result.marketValue * 100,
  })).sort((left, right) => right.value - left.value);
  const largest = [...result.positions].sort((left, right) => right.marketValue - left.marketValue)[0];
  const largestPercent = largest.marketValue / result.marketValue * 100;
  const largestSector = sectorRows[0];
  const warnings = [];
  if (largestPercent > 35) warnings.push(`${largest.symbol} vormt ${largestPercent.toFixed(0)}% van je open portefeuille.`);
  if (largestSector.percent > 45) warnings.push(`${largestSector.sector} vormt ${largestSector.percent.toFixed(0)}% van je open portefeuille.`);
  if (result.positions.length < 3) warnings.push('Minder dan drie open aandelen geeft beperkte spreiding.');
  elements.portfolioInsights.innerHTML = `
    <div class="portfolio-insight-head">
      <div><p class="eyebrow">Risico-overzicht</p><h3>Sectorverdeling en concentratie</h3></div>
      <span class="diversification-score ${warnings.length ? 'attention' : 'good'}">${warnings.length ? `${warnings.length} aandachtspunt${warnings.length === 1 ? '' : 'en'}` : 'Redelijk gespreid'}</span>
    </div>
    <div class="sector-bars">${sectorRows.map((row) => `
      <div class="sector-bar"><div><span>${escapeHtml(row.sector)}</span><strong>${row.percent.toLocaleString('nl-NL', { maximumFractionDigits: 1 })}%</strong></div><i><b style="width:${Math.min(100, row.percent)}%"></b></i></div>`).join('')}</div>
    <div class="portfolio-warnings">${warnings.length ? warnings.map((warning) => `<p>⚠ ${escapeHtml(warning)}</p>`).join('') : '<p>Geen grote concentratie volgens de eenvoudige 35%/45%-waarschuwingsgrenzen.</p>'}</div>`;
}

function saveJournal() {
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(state.journal));
  renderJournal();
}

function renderJournal() {
  const result = journalCalculations();
  const total = result.realized + result.unrealized;
  elements.journalStats.innerHTML = `
    <article><span>In open posities</span><strong>${formatCurrency(result.openCost)}</strong><small>FIFO-aankoopwaarde incl. kosten</small></article>
    <article><span>Huidige waarde</span><strong>${formatCurrency(result.marketValue)}</strong><small>laatste beschikbare analysekoers</small></article>
    <article><span>Open resultaat</span><strong class="${resultClass(result.unrealized)}">${formatCurrency(result.unrealized)}</strong><small>nog niet gerealiseerd</small></article>
    <article><span>Totaal resultaat</span><strong class="${resultClass(total)}">${formatCurrency(total)}</strong><small>${result.openCost ? formatSignedPercent(total / result.openCost * 100) : '0%'} · ${formatCurrency(result.realized)} gerealiseerd</small></article>`;

  renderPortfolioInsights(result);

  elements.journalPositions.innerHTML = result.positions.length ? result.positions.map((position) => `
    <article class="position-row">
      <div><strong>${escapeHtml(position.symbol)}</strong><span>${formatCompactNumber(position.quantity)} stuks · gemiddeld ${formatCurrency(position.averageCost)}</span></div>
      <div><strong>${formatCurrency(position.marketValue)}</strong><span class="${resultClass(position.unrealized)}">${formatCurrency(position.unrealized)} open</span></div>
      <button class="button button-secondary" type="button" data-journal-sell="${escapeHtml(position.symbol)}">Verkoop registreren</button>
    </article>`).join('') : '<div class="empty compact-empty">Nog geen open posities. Registreer eerst een aankoop.</div>';

  const history = [...state.journal].sort((left, right) => (
    String(right.date).localeCompare(String(left.date)) || Number(right.createdAt || 0) - Number(left.createdAt || 0)
  ));
  elements.journalHistory.innerHTML = history.length ? history.map((entry) => {
    const cash = Number(entry.quantity) * Number(entry.price) + (entry.type === 'BUY' ? Number(entry.fees || 0) : -Number(entry.fees || 0));
    return `<article class="history-row">
      <span class="history-type ${entry.type.toLowerCase()}">${entry.type === 'BUY' ? 'Koop' : 'Verkoop'}</span>
      <div><strong>${escapeHtml(entry.symbol)} · ${formatCompactNumber(entry.quantity)} × ${formatCurrency(entry.price)}</strong><span>${escapeHtml(formatDate(entry.date))} · totaal ${formatCurrency(cash)} · kosten ${formatCurrency(entry.fees || 0)}</span></div>
      <button class="icon-button delete-entry" type="button" data-journal-delete="${escapeHtml(entry.id)}" aria-label="Verwijder transactie">×</button>
    </article>`;
  }).join('') : '<div class="empty compact-empty">Nog geen transacties opgeslagen.</div>';

  const symbols = [...new Set([
    ...(state.analysis?.stocks || []).map((stock) => stock.symbol),
    ...(state.marketScan?.stocks || []).map((stock) => stock.symbol),
  ])].sort();
  elements.journalSymbols.innerHTML = symbols.map((symbol) => `<option value="${escapeHtml(symbol)}"></option>`).join('');
  elements.journalPositions.querySelectorAll('[data-journal-sell]').forEach((button) => {
    button.addEventListener('click', () => prepareJournalEntry(button.dataset.journalSell, 'SELL'));
  });
  elements.journalHistory.querySelectorAll('[data-journal-delete]').forEach((button) => {
    button.addEventListener('click', () => {
      state.journal = state.journal.filter((entry) => entry.id !== button.dataset.journalDelete);
      saveJournal();
      elements.journalFormStatus.textContent = 'Transactie verwijderd en resultaten opnieuw berekend.';
    });
  });
}

function prepareJournalEntry(symbol, type) {
  const normalized = String(symbol || '').trim().toUpperCase();
  const stock = currentMarketStock(normalized);
  const position = journalCalculations().positions.find((item) => item.symbol === normalized);
  elements.journalSymbol.value = normalized;
  elements.journalType.value = type;
  const stockPrice = stock?.strategy?.entryHigh ?? stock?.strategy?.entry ?? stock?.market?.price ?? stock?.price;
  elements.journalPrice.value = Number(type === 'BUY' ? stockPrice || 0 : stockPrice || position?.marketPrice || 0).toFixed(2);
  elements.journalQuantity.value = type === 'SELL' && position ? Number(position.quantity.toFixed(6)) : '';
  elements.journalFormStatus.textContent = `${type === 'BUY' ? 'Aankoop' : 'Verkoop'} voor ${normalized} voorbereid. Vul het werkelijk uitgevoerde aantal en de echte prijs in.`;
  document.getElementById('dagboek').scrollIntoView({ behavior: 'smooth', block: 'start' });
  elements.journalQuantity.focus({ preventScroll: true });
}

function exportJournal() {
  if (!state.journal.length) {
    elements.journalFormStatus.textContent = 'Er zijn nog geen transacties om te exporteren.';
    return;
  }
  const rows = [['datum', 'ticker', 'soort', 'aantal', 'prijs_usd', 'kosten_usd'], ...state.journal.map((entry) => [
    entry.date, entry.symbol, entry.type, entry.quantity, entry.price, entry.fees || 0,
  ])];
  const csv = rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `capitol-pulse-dagboek-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  elements.journalFormStatus.textContent = 'CSV-back-up gedownload.';
}

function positionPlan(stock) {
  if (stock.strategy?.exitReason) {
    const reasonLabels = {
      target: 'Verkoopdoel bereikt',
      stop: 'Stop-loss bereikt',
      model: '5/5-bevestiging vervallen',
    };
    return `<div class="no-position exit-position">
      <strong>${escapeHtml(reasonLabels[stock.strategy.exitReason] || 'Modelpositie beëindigd')}</strong>
      <span>Signaalkoers ${formatCurrency(stock.strategy.exitPrice ?? stock.market?.price, stock.currency)} · oorspronkelijke stop ${formatCurrency(stock.strategy.stopLoss, stock.currency)} · verkoopdoel ${formatCurrency(stock.strategy.takeProfit, stock.currency)}. Controleer je eigen order; uitvoering is niet automatisch.</span>
    </div>`;
  }
  if (!stock.strategy?.active) {
    return '<div class="no-position"><strong>Geen modelpositie</strong><span>De aankoopregel is niet volledig bevestigd; er wordt geen instapbedrag berekend.</span></div>';
  }
  const budget = Math.max(0, Number(elements.analysisBudget.value) || 0);
  const riskPercent = Math.max(0, Number(elements.analysisRisk.value) || 0);
  const entry = Number(stock.strategy.entryHigh);
  const stop = Number(stock.strategy.stopLoss);
  const riskPerShare = entry - stop;
  const riskBudget = budget * riskPercent / 100;
  const riskShares = riskPerShare > 0 ? Math.floor(riskBudget / riskPerShare) : 0;
  const cashShares = entry > 0 ? Math.floor(budget / entry) : 0;
  const shares = Math.max(0, Math.min(riskShares, cashShares));
  const investment = shares * entry;
  const maximumLoss = shares * riskPerShare;
  return `<div class="position-plan">
    <div><span>Instapzone</span><strong>${formatCurrency(stock.strategy.entryLow, stock.currency)} – ${formatCurrency(stock.strategy.entryHigh, stock.currency)}</strong></div>
    <div><span>Stop-loss</span><strong>${formatCurrency(stock.strategy.stopLoss, stock.currency)}</strong></div>
    <div><span>Verkoopdoel (2R)</span><strong>${formatCurrency(stock.strategy.takeProfit, stock.currency)}</strong></div>
    <div><span>Voorbeeldpositie</span><strong>${shares ? `${shares} ${shares === 1 ? 'aandeel' : 'aandelen'} · ${formatCurrency(investment, stock.currency)}` : '0 hele aandelen'}</strong></div>
    <small>Modelrisico bij stop: ${formatCurrency(maximumLoss, stock.currency)} van ${formatCurrency(budget, stock.currency)}. Fractionele aandelen en kosten zijn niet meegerekend.</small>
  </div>`;
}

function metric(label, value, suffix = '') {
  const number = Number(value);
  return `<div><span>${escapeHtml(label)}</span><strong>${Number.isFinite(number) ? `${formatCompactNumber(number)}${suffix}` : 'Niet beschikbaar'}</strong></div>`;
}

function analysisCard(stock) {
  const signalClass = String(stock.signal || '').toLowerCase();
  const filingUrl = safeUrl(stock.politicianSignal?.sourceUrl);
  const marketUrl = safeUrl(stock.marketSourceUrl);
  const decision = stockDecision(stock);
  const factors = (stock.factors || []).map((item) => `<li class="factor ${escapeHtml(item.status)}">
    <span class="factor-mark" aria-hidden="true">${item.status === 'good' ? '✓' : item.status === 'bad' ? '×' : '?'}</span>
    <div>
      <strong>${escapeHtml(item.label)}</strong>
      <small>${escapeHtml(item.detail)}</small>
      <em>Grens: ${escapeHtml(FACTOR_THRESHOLDS[item.key] || 'Voldoende betrouwbare data en een positieve beoordeling')}</em>
    </div>
  </li>`).join('');
  const market = stock.market || {};
  const fundamentals = stock.fundamentals || {};
  const analysisId = stock.id || `${stock.politician}:${stock.symbol}`;
  return `<article class="analysis-card" data-analysis-id="${escapeHtml(analysisId)}">
    <div class="analysis-card-head">
      <div class="analysis-symbol"><span>${escapeHtml(stock.symbol)}</span><small>${escapeHtml(stock.company)}</small></div>
      <span class="signal ${signalClass}">${escapeHtml(stock.signalLabel)} · ${Number(stock.score) || 0}/5</span>
    </div>
    <div class="analysis-verdict ${decision.key}"><strong>${decision.label}</strong><span>${escapeHtml(decision.reason)}</span></div>
    <div class="politician-signal ${stock.politicianSignal?.action === 'Purchase' ? 'purchase' : 'sale'}">
      <span>${escapeHtml(stock.politician)}</span>
      <strong>${escapeHtml(actionLabel(stock.politicianSignal?.action))} · ${escapeHtml(stock.politicianSignal?.amount || 'bedrag onbekend')}</strong>
      <small>Transactie ${escapeHtml(formatDate(stock.politicianSignal?.transactionDate))}; openbaar ${escapeHtml(formatDate(stock.politicianSignal?.disclosureDate))}.</small>
    </div>
    <div class="market-line">
      <div><span>Laatste koers</span><strong>${formatCurrency(market.price, stock.currency)}</strong></div>
      <div><span>Koersdatum</span><strong>${escapeHtml(formatDate(market.priceDate))}</strong></div>
      <div><span>52-weeks bereik</span><strong>${formatCurrency(market.fiftyTwoWeekLow, stock.currency)} – ${formatCurrency(market.fiftyTwoWeekHigh, stock.currency)}</strong></div>
    </div>
    <details class="analysis-depth" ${decision.key === 'buy' ? 'open' : ''}>
      <summary>Bekijk alle waarden en grenswaarden</summary>
      <div class="metric-section">
        <h4>Koers, trend en risico</h4>
        <div class="metric-grid">
          ${metric('Koers', market.price)}${metric('50-daags gemiddelde', market.sma50)}${metric('200-daags gemiddelde', market.sma200)}
          ${metric('RSI (14 dagen)', market.rsi14)}${metric('Volatiliteit op jaarbasis', market.annualizedVolatilityPct, '%')}${metric('ATR (14 dagen)', market.atr14)}
        </div>
      </div>
      <div class="metric-section">
        <h4>Bedrijfsfundamenten</h4>
        <div class="metric-grid">
          ${metric('Omzetgroei jaar-op-jaar', fundamentals.revenueGrowthYoYPct, '%')}${metric('Winstgroei jaar-op-jaar', fundamentals.netIncomeGrowthYoYPct, '%')}
          ${metric('Nettomarge', fundamentals.netMarginPct, '%')}${metric('Vrije-kasstroommarge', fundamentals.freeCashFlowMarginPct, '%')}
          ${metric('Koers/winst', fundamentals.peRatio)}${metric('Schuld/eigen vermogen', fundamentals.debtToEquity)}
        </div>
      </div>
      <ul class="factor-list">${factors}</ul>
    </details>
    ${positionPlan(stock)}
    <div class="analysis-links">
      ${decision.key === 'buy' ? `<button class="button" type="button" data-journal-buy="${escapeHtml(stock.symbol)}">Werkelijke aankoop registreren</button>` : ''}
      ${filingUrl ? `<a href="${escapeHtml(filingUrl)}" target="_blank" rel="noopener noreferrer">Openbare filing ↗</a>` : ''}
      ${marketUrl ? `<a href="${escapeHtml(marketUrl)}" target="_blank" rel="noopener noreferrer">Marktbron ↗</a>` : ''}
    </div>
  </article>`;
}

function renderAnalysis(cached = false) {
  if (!state.analysis) return;
  renderPoliticianChoices();
  const stocks = state.analysis.stocks.filter((stock) => (
    state.selectedPolitician === 'all' || stock.politician === state.selectedPolitician
  ));
  const buys = stocks.filter((stock) => stock.signal === 'BUY').length;
  elements.analysisFreshness.textContent = `${cached ? 'Lokale kopie · ' : ''}${formatDateTime(state.analysis.metadata?.updatedAt)}`;
  elements.analysisStatus.textContent = `${stocks.length} analyses · ${buys} koopkandida${buys === 1 ? 'at' : 'ten'} · alleen 5/5 wordt actief`;
  elements.analysisCards.innerHTML = stocks.length
    ? stocks.map(analysisCard).join('')
    : '<div class="empty">Voor deze politicus zijn geen recente gewone aandelen met volledige marktdata gevonden.</div>';
  elements.analysisCards.querySelectorAll('[data-journal-buy]').forEach((button) => {
    button.addEventListener('click', () => prepareJournalEntry(button.dataset.journalBuy, 'BUY'));
  });
  renderDecisionBoard();
  renderNotificationInsights();
  renderJournal();
}

function filteredTrades() {
  const query = elements.searchInput.value.trim().toLocaleLowerCase('nl-NL');
  const chamber = elements.chamberFilter.value;
  const type = elements.typeFilter.value;
  const favoriteMode = elements.favoriteFilter.value;

  const rows = state.trades.filter((trade) => {
    const searchable = [trade.politician, trade.symbol, trade.assetDescription, trade.state, trade.chamber]
      .join(' ')
      .toLocaleLowerCase('nl-NL');
    if (query && !searchable.includes(query)) return false;
    if (chamber !== 'all' && trade.chamber !== chamber) return false;
    if (type === 'Purchase' && !isPurchase(trade.type)) return false;
    if (type === 'Sale' && !isSale(trade.type)) return false;
    if (favoriteMode === 'favorites' && !isFavorite(trade)) return false;
    if (favoriteMode === 'late' && !(delayFor(trade) > 45)) return false;
    return true;
  });

  const sort = elements.sortFilter.value;
  rows.sort((left, right) => {
    if (sort === 'transaction-desc') return String(right.transactionDate).localeCompare(String(left.transactionDate));
    if (sort === 'delay-desc') return (delayFor(right) ?? -1) - (delayFor(left) ?? -1);
    if (sort === 'amount-desc') return midpoint(right) - midpoint(left);
    return String(right.disclosureDate).localeCompare(String(left.disclosureDate));
  });
  return rows;
}

function isFavorite(trade) {
  return state.favorites.politicians.includes(trade.politician)
    || Boolean(trade.symbol && state.favorites.tickers.includes(trade.symbol));
}

function tradeCard(trade) {
  const delay = delayFor(trade);
  const politicianFavorite = state.favorites.politicians.includes(trade.politician);
  const tickerFavorite = Boolean(trade.symbol && state.favorites.tickers.includes(trade.symbol));
  const sourceUrl = safeUrl(trade.sourceUrl);
  const typeClass = isPurchase(trade.type) ? 'purchase' : isSale(trade.type) ? 'sale' : '';

  return `<article class="trade-card">
    <button class="ticker-button ${tickerFavorite ? 'active' : ''}" type="button" data-favorite-ticker="${escapeHtml(trade.symbol || '')}" aria-label="${tickerFavorite ? 'Stop met ticker volgen' : 'Volg ticker'}">${escapeHtml(trade.symbol || '—')}</button>
    <div>
      <button class="trade-person" type="button" data-detail-id="${escapeHtml(trade.id)}">${escapeHtml(trade.politician)}</button>
      <span class="trade-asset">${escapeHtml(trade.assetDescription || 'Effect niet nader omschreven')} · ${escapeHtml(trade.chamber)}</span>
      <div class="badges">
        <span class="badge ${typeClass}">${escapeHtml(typeLabel(trade.type))}</span>
        ${delay > 45 ? '<span class="badge late">Meer dan 45 dagen</span>' : ''}
      </div>
    </div>
    <div class="trade-amount"><strong>${escapeHtml(trade.amount || 'Bandbreedte onbekend')}</strong><small>Gemeld bedrag</small></div>
    <div class="trade-date">
      <strong>Melding ${escapeHtml(formatDate(trade.disclosureDate))}</strong>
      <small>Transactie ${escapeHtml(formatDate(trade.transactionDate))}${Number.isFinite(delay) ? ` · ${delay} dagen vertraging` : ''}</small>
      ${sourceUrl ? `<a class="card-source" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Bron ↗</a>` : '<small>Bron niet beschikbaar</small>'}
    </div>
    <button class="favorite-button ${politicianFavorite ? 'active' : ''}" type="button" data-favorite-politician="${escapeHtml(trade.politician)}" aria-label="${politicianFavorite ? 'Stop met politicus volgen' : 'Volg politicus'}">★</button>
  </article>`;
}

function renderTrades() {
  const rows = filteredTrades();
  elements.resultCount.textContent = `${rows.length.toLocaleString('nl-NL')} resultaten`;
  const visibleRows = rows.slice(0, state.visible);
  elements.tradesList.innerHTML = visibleRows.length
    ? visibleRows.map(tradeCard).join('')
    : '<div class="empty">Geen transacties gevonden voor deze filters.</div>';
  elements.loadMoreButton.classList.toggle('hidden', state.visible >= rows.length);

  elements.tradesList.querySelectorAll('[data-detail-id]').forEach((button) => {
    button.addEventListener('click', () => openDetail(button.dataset.detailId));
  });
  elements.tradesList.querySelectorAll('[data-favorite-politician]').forEach((button) => {
    button.addEventListener('click', () => toggleFavorite('politicians', button.dataset.favoritePolitician));
  });
  elements.tradesList.querySelectorAll('[data-favorite-ticker]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.favoriteTicker) toggleFavorite('tickers', button.dataset.favoriteTicker);
    });
  });
}

function renderStats() {
  const delays = state.trades.map(delayFor).filter(Number.isFinite);
  const averageDelay = delays.length ? Math.round(delays.reduce((sum, value) => sum + value, 0) / delays.length) : null;
  elements.statTotal.textContent = state.trades.length.toLocaleString('nl-NL');
  elements.statPurchases.textContent = state.trades.filter((trade) => isPurchase(trade.type)).length.toLocaleString('nl-NL');
  elements.statSales.textContent = state.trades.filter((trade) => isSale(trade.type)).length.toLocaleString('nl-NL');
  elements.statDelay.textContent = averageDelay === null ? '–' : `${averageDelay} dgn`;
}

function renderFavorites() {
  const chips = [
    ...state.favorites.politicians.map((value) => ({ kind: 'politicians', label: `👤 ${value}`, value })),
    ...state.favorites.tickers.map((value) => ({ kind: 'tickers', label: `# ${value}`, value })),
  ];
  elements.favoritesSummary.innerHTML = chips.length
    ? chips.map((chip) => `<span class="favorite-chip">${escapeHtml(chip.label)}<button type="button" data-remove-kind="${chip.kind}" data-remove-value="${escapeHtml(chip.value)}" aria-label="Verwijder ${escapeHtml(chip.value)}">×</button></span>`).join('')
    : '<p class="muted">Nog geen favorieten opgeslagen.</p>';
  elements.favoritesSummary.querySelectorAll('[data-remove-kind]').forEach((button) => {
    button.addEventListener('click', () => toggleFavorite(button.dataset.removeKind, button.dataset.removeValue));
  });
}

function renderAll() {
  renderStats();
  renderTrades();
  renderFavorites();
  renderNotificationInsights();
  renderJournal();
  elements.lastUpdated.textContent = formatDateTime(state.metadata.updatedAt);
}

function toggleFavorite(kind, value) {
  if (!value || !['politicians', 'tickers'].includes(kind)) return;
  const items = state.favorites[kind];
  const index = items.indexOf(value);
  if (index >= 0) items.splice(index, 1);
  else items.push(value);
  items.sort((left, right) => left.localeCompare(right));
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(state.favorites));
  renderTrades();
  renderFavorites();
  if (state.marketScan) renderMarketScan();
}

function openDetail(id) {
  const trade = state.trades.find((item) => item.id === id);
  if (!trade) return;
  const delay = delayFor(trade);
  const sourceUrl = safeUrl(trade.sourceUrl);
  elements.detailContent.innerHTML = `
    <p class="eyebrow">${escapeHtml(trade.chamber)}${trade.state ? ` · ${escapeHtml(trade.state)}` : ''}</p>
    <h2>${escapeHtml(trade.politician)}</h2>
    <p>${escapeHtml(typeLabel(trade.type))} van <strong>${escapeHtml(trade.assetDescription || trade.symbol || 'een effect')}</strong>.</p>
    <div class="detail-grid">
      <div><span>Ticker</span><strong>${escapeHtml(trade.symbol || 'Onbekend')}</strong></div>
      <div><span>Gemelde bandbreedte</span><strong>${escapeHtml(trade.amount || 'Onbekend')}</strong></div>
      <div><span>Transactiedatum</span><strong>${escapeHtml(formatDate(trade.transactionDate))}</strong></div>
      <div><span>Openbaarmakingsdatum</span><strong>${escapeHtml(formatDate(trade.disclosureDate))}</strong></div>
      <div><span>Vertraging</span><strong>${Number.isFinite(delay) ? `${delay} dagen` : 'Onbekend'}</strong></div>
      <div><span>Kamer</span><strong>${escapeHtml(trade.chamber)}</strong></div>
    </div>
    <p class="detail-note">Deze gegevens worden pas beschikbaar nadat de transactie openbaar is gemaakt. Bedragen zijn bandbreedtes uit de filing.</p>
    ${sourceUrl ? `<a class="source-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open de openbare bron ↗</a>` : '<p>Geen bronlink beschikbaar.</p>'}`;
  elements.detailDialog.showModal();
}

function resetAndRender() {
  state.visible = PAGE_SIZE;
  renderTrades();
}

function localDateInputValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function submitJournalEntry(event) {
  event.preventDefault();
  const symbol = elements.journalSymbol.value.trim().toUpperCase();
  const type = elements.journalType.value;
  const date = elements.journalDate.value;
  const quantity = Number(elements.journalQuantity.value);
  const price = Number(elements.journalPrice.value);
  const fees = Number(elements.journalFees.value || 0);
  if (!/^[A-Z0-9.-]{1,10}$/.test(symbol) || !['BUY', 'SELL'].includes(type) || !parseDate(date)
      || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0
      || !Number.isFinite(fees) || fees < 0) {
    elements.journalFormStatus.textContent = 'Controleer ticker, datum, aantal, prijs en kosten.';
    return;
  }
  if (type === 'SELL') {
    const available = journalCalculations().positions.find((position) => position.symbol === symbol)?.quantity || 0;
    if (quantity > available + 0.0000001) {
      elements.journalFormStatus.textContent = `Je kunt maximaal ${formatCompactNumber(available)} ${symbol} verkopen volgens dit dagboek.`;
      return;
    }
  }
  state.journal.push({
    id: globalThis.crypto?.randomUUID?.() || `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: Date.now(),
    date,
    symbol,
    type,
    quantity,
    price,
    fees,
  });
  saveJournal();
  elements.journalForm.reset();
  elements.journalDate.value = localDateInputValue();
  elements.journalFees.value = '0';
  elements.journalFormStatus.textContent = `${type === 'BUY' ? 'Aankoop' : 'Verkoop'} van ${formatCompactNumber(quantity)} ${symbol} opgeslagen. Resultaten zijn opnieuw berekend.`;
}

elements.searchInput.addEventListener('input', resetAndRender);
[elements.chamberFilter, elements.typeFilter, elements.favoriteFilter, elements.sortFilter]
  .forEach((element) => element.addEventListener('change', resetAndRender));
elements.loadMoreButton.addEventListener('click', () => { state.visible += PAGE_SIZE; renderTrades(); });
elements.refreshButton.addEventListener('click', () => Promise.all([
  loadData({ manual: true }),
  loadAnalysis({ manual: true }),
  loadMarketScan({ manual: true }),
]));
elements.analysisBudget.addEventListener('input', () => renderAnalysis());
elements.analysisRisk.addEventListener('change', () => renderAnalysis());
elements.journalForm.addEventListener('submit', submitJournalEntry);
elements.journalExportButton.addEventListener('click', exportJournal);
elements.marketSearch.addEventListener('input', () => { state.marketVisible = MARKET_PAGE_SIZE; renderMarketScan(); });
[elements.marketSector, elements.marketSignal, elements.marketCongress, elements.marketRisk, elements.marketSort].forEach((element) => {
  element.addEventListener('change', () => { state.marketVisible = MARKET_PAGE_SIZE; renderMarketScan(); });
});
elements.marketLoadMore.addEventListener('click', () => { state.marketVisible += MARKET_PAGE_SIZE; renderMarketScan(); });
elements.closeDialogButton.addEventListener('click', () => elements.detailDialog.close());
elements.detailDialog.addEventListener('click', (event) => {
  if (event.target === elements.detailDialog) elements.detailDialog.close();
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.installPrompt = event;
  elements.installButton.classList.remove('hidden');
});
elements.installButton.addEventListener('click', async () => {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  elements.installButton.classList.add('hidden');
});
window.addEventListener('appinstalled', () => elements.installButton.classList.add('hidden'));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js').catch((error) => {
    console.error('Service worker kon niet worden geregistreerd:', error);
  }));
}

elements.journalDate.value = localDateInputValue();
renderJournal();
Promise.all([loadData(), loadAnalysis(), loadMarketScan()]);
