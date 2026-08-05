'use strict';

const DATA_URL = './public/data/live.json';
const ANALYSIS_URL = './public/data/analysis.json';
const CACHE_KEY = 'capitol-pulse-data-cache-v1';
const ANALYSIS_CACHE_KEY = 'capitol-pulse-analysis-cache-v1';
const FAVORITES_KEY = 'capitol-pulse-favorites-v1';
const PAGE_SIZE = 30;

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
  selectedPolitician: 'all',
  visible: PAGE_SIZE,
  favorites: readFavorites(),
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

function applyPayload(payload, cached = false) {
  state.trades = payload.trades.filter((trade) => trade && trade.id && trade.politician);
  state.metadata = payload.metadata || {};
  state.visible = PAGE_SIZE;
  renderAll();
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

function analysisCard(stock) {
  const signalClass = String(stock.signal || '').toLowerCase();
  const filingUrl = safeUrl(stock.politicianSignal?.sourceUrl);
  const marketUrl = safeUrl(stock.marketSourceUrl);
  const factors = (stock.factors || []).map((item) => `<li class="factor ${escapeHtml(item.status)}">
    <span class="factor-mark" aria-hidden="true">${item.status === 'good' ? '✓' : item.status === 'bad' ? '×' : '?'}</span>
    <div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></div>
  </li>`).join('');
  return `<article class="analysis-card">
    <div class="analysis-card-head">
      <div class="analysis-symbol"><span>${escapeHtml(stock.symbol)}</span><small>${escapeHtml(stock.company)}</small></div>
      <span class="signal ${signalClass}">${escapeHtml(stock.signalLabel)} · ${Number(stock.score) || 0}/5</span>
    </div>
    <div class="politician-signal ${stock.politicianSignal?.action === 'Purchase' ? 'purchase' : 'sale'}">
      <span>${escapeHtml(stock.politician)}</span>
      <strong>${escapeHtml(actionLabel(stock.politicianSignal?.action))} · ${escapeHtml(stock.politicianSignal?.amount || 'bedrag onbekend')}</strong>
      <small>Transactie ${escapeHtml(formatDate(stock.politicianSignal?.transactionDate))}; openbaar ${escapeHtml(formatDate(stock.politicianSignal?.disclosureDate))}.</small>
    </div>
    <div class="market-line">
      <div><span>Laatste koers</span><strong>${formatCurrency(stock.market?.price, stock.currency)}</strong></div>
      <div><span>Koersdatum</span><strong>${escapeHtml(formatDate(stock.market?.priceDate))}</strong></div>
      <div><span>Volatiliteit</span><strong>${formatCompactNumber(stock.market?.annualizedVolatilityPct)}%</strong></div>
    </div>
    <ul class="factor-list">${factors}</ul>
    ${positionPlan(stock)}
    <div class="analysis-links">
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

elements.searchInput.addEventListener('input', resetAndRender);
[elements.chamberFilter, elements.typeFilter, elements.favoriteFilter, elements.sortFilter]
  .forEach((element) => element.addEventListener('change', resetAndRender));
elements.loadMoreButton.addEventListener('click', () => { state.visible += PAGE_SIZE; renderTrades(); });
elements.refreshButton.addEventListener('click', () => Promise.all([
  loadData({ manual: true }),
  loadAnalysis({ manual: true }),
]));
elements.analysisBudget.addEventListener('input', () => renderAnalysis());
elements.analysisRisk.addEventListener('change', () => renderAnalysis());
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

Promise.all([loadData(), loadAnalysis()]);
