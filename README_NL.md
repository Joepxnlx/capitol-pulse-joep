'use strict';

const DATA_URL = './data/live.json';
const FALLBACK_URL = './data/sample.json';
const PAGE_SIZE = 25;

const state = {
  trades: [], filtered: [], visible: PAGE_SIZE, dataMode: 'loading', metadata: {},
  watchlist: JSON.parse(localStorage.getItem('cp-watchlist') || '{"politicians":[],"tickers":[]}'),
  lastSeenIds: new Set(JSON.parse(localStorage.getItem('cp-seen-ids') || '[]')),
};

const $ = (id) => document.getElementById(id);
const els = {
  statusBanner: $('statusBanner'), statusTitle: $('statusTitle'), statusText: $('statusText'),
  lastUpdated: $('lastUpdated'), statToday: $('statToday'), statBuys: $('statBuys'), statSales: $('statSales'), statDelay: $('statDelay'),
  tradesList: $('tradesList'), resultCount: $('resultCount'), loadMoreBtn: $('loadMoreBtn'), refreshBtn: $('refreshBtn'),
  searchInput: $('searchInput'), chamberFilter: $('chamberFilter'), typeFilter: $('typeFilter'), viewFilter: $('viewFilter'), sortFilter: $('sortFilter'),
  watchlistSummary: $('watchlistSummary'), notificationBtn: $('notificationBtn'), installBtn: $('installBtn'),
  detailDialog: $('detailDialog'), detailContent: $('detailContent'), setupDialog: $('setupDialog'), aboutDialog: $('aboutDialog'),
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function safeUrl(value = '') {
  try { const url = new URL(value, window.location.href); return ['http:','https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}
function parseDate(value) { const d = new Date(`${value}T12:00:00Z`); return Number.isNaN(d.getTime()) ? null : d; }
function fmtDate(value) { const d = parseDate(value); return d ? new Intl.DateTimeFormat('nl-NL',{day:'numeric',month:'short',year:'numeric'}).format(d) : 'Onbekend'; }
function fmtDateTime(value) { const d = new Date(value); return Number.isNaN(d.getTime()) ? 'Onbekend' : new Intl.DateTimeFormat('nl-NL',{dateStyle:'medium',timeStyle:'short'}).format(d); }
function daysBetween(a,b) { const da=parseDate(a), db=parseDate(b); return da&&db ? Math.round((db-da)/86400000) : null; }
function todayISO() { return new Date().toISOString().slice(0,10); }
function midpoint(t) { return Number(t.amountMid || ((Number(t.amountMin)||0)+(Number(t.amountMax)||0))/2 || 0); }
function isSale(type='') { return /sale|sell/i.test(type); }
function isBuy(type='') { return /purchase|buy/i.test(type); }
function typeLabel(type='') { if(isBuy(type)) return 'Aankoop'; if(isSale(type)) return 'Verkoop'; if(/exchange/i.test(type)) return 'Omwisseling'; return type || 'Overig'; }

function scoreTrade(t, allTrades = []) {
  const amount = midpoint(t);
  const amountScore = Math.min(35, Math.log10(Math.max(amount,1000)/1000 + 1) * 18);
  const delay = Number.isFinite(t.reportingDelayDays) ? t.reportingDelayDays : daysBetween(t.transactionDate,t.disclosureDate) || 0;
  const speedScore = Math.max(0, 22 - Math.max(0,delay-10)*.5);
  const cluster = allTrades.filter(x => x.symbol && x.symbol === t.symbol && daysBetween(x.disclosureDate,t.disclosureDate) !== null && Math.abs(daysBetween(x.disclosureDate,t.disclosureDate)) <= 30).length;
  const clusterScore = Math.min(28, Math.max(0,cluster-1)*7);
  const sourceScore = t.sourceUrl ? 10 : 0;
  return Math.round(Math.min(100, amountScore + speedScore + clusterScore + sourceScore));
}
function scoreLabel(score) { return score >= 70 ? 'Sterk opvallend' : score >= 50 ? 'Opvallend' : score >= 30 ? 'Normaal' : 'Beperkt signaal'; }
function isWatched(t) { return state.watchlist.politicians.includes(t.politician) || (t.symbol && state.watchlist.tickers.includes(t.symbol)); }

async function loadData(manual=false, quiet=false) {
  if (!quiet) {
    setStatus('loading', manual ? 'Vernieuwen…' : 'Data laden…', 'De nieuwste openbare meldingen worden opgehaald.');
    els.tradesList.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  }
  try {
    let res = await fetch(`${DATA_URL}?v=${Date.now()}`, {cache:'no-store'});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let payload = await res.json();
    if (!Array.isArray(payload.trades) || payload.trades.length === 0) throw new Error('Geen live data');
    applyPayload(payload);
  } catch (err) {
    try {
      const res = await fetch(FALLBACK_URL, {cache:'no-store'});
      const payload = await res.json();
      applyPayload(payload, true);
    } catch (fallbackErr) {
      if (!quiet || !state.trades.length) {
        setStatus('error','Data kon niet worden geladen','Controleer de internetverbinding of voer de updater uit.');
        els.tradesList.innerHTML = '<div class="empty">Geen gegevens beschikbaar.</div>';
      }
    }
  }
}

function applyPayload(payload, forcedDemo=false) {
  const baseTrades = payload.trades.map(t => ({...t}));
  state.trades = baseTrades.map(t => ({...t, score: scoreTrade(t, baseTrades)}));
  state.metadata = payload.metadata || {};
  state.dataMode = forcedDemo ? 'demo' : (payload.mode || 'live');
  detectNewTrades();
  renderAll();
  if (state.dataMode === 'live') {
    setStatus('live','Live monitor actief',`${state.trades.length.toLocaleString('nl-NL')} transacties geladen. Nieuwe publieke meldingen worden automatisch verwerkt.`);
  } else {
    setStatus('loading','Voorbeeldmodus', 'Voeg jouw gratis API-key toe om actuele House- en Senate-meldingen te laden.');
  }
}

function setStatus(mode,title,text) {
  els.statusBanner.classList.toggle('live', mode==='live');
  els.statusBanner.classList.toggle('error', mode==='error');
  els.statusTitle.textContent=title; els.statusText.textContent=text;
}

function detectNewTrades() {
  if (!state.lastSeenIds.size) {
    state.trades.slice(0,100).forEach(t=>state.lastSeenIds.add(t.id));
    saveSeen(); return;
  }
  const fresh = state.trades.filter(t=>!state.lastSeenIds.has(t.id));
  if (fresh.length && 'Notification' in window && Notification.permission === 'granted') {
    const first=fresh[0];
    navigator.serviceWorker?.ready.then(reg => reg.showNotification(
      fresh.length===1 ? `${first.politician}: ${typeLabel(first.type)} ${first.symbol||first.assetDescription}` : `${fresh.length} nieuwe congresmeldingen`,
      { body: fresh.length===1 ? `${first.amount} · openbaar ${fmtDate(first.disclosureDate)}` : 'Open Capitol Pulse voor het overzicht.', icon:'./icons/icon-192.png', data:{url:'./'} }
    ));
  }
  state.trades.slice(0,300).forEach(t=>state.lastSeenIds.add(t.id));
  saveSeen();
}
function saveSeen() { localStorage.setItem('cp-seen-ids', JSON.stringify([...state.lastSeenIds].slice(-600))); }

function renderAll() {
  renderStats(); renderTrades(); renderWatchlist();
  const updated = state.metadata.updatedAt || state.metadata.generatedAt;
  els.lastUpdated.textContent = updated ? `Bijgewerkt ${fmtDateTime(updated)}` : 'Bijwerktijd onbekend';
}
function renderStats() {
  const today=todayISO();
  const todays=state.trades.filter(t=>t.disclosureDate===today).length;
  const buys=state.trades.filter(t=>isBuy(t.type)).length;
  const sales=state.trades.filter(t=>isSale(t.type)).length;
  const delays=state.trades.map(t=>Number.isFinite(t.reportingDelayDays)?t.reportingDelayDays:daysBetween(t.transactionDate,t.disclosureDate)).filter(Number.isFinite);
  const avg=delays.length ? Math.round(delays.reduce((a,b)=>a+b,0)/delays.length) : null;
  els.statToday.textContent=todays.toLocaleString('nl-NL');
  els.statBuys.textContent=buys.toLocaleString('nl-NL');
  els.statSales.textContent=sales.toLocaleString('nl-NL');
  els.statDelay.textContent=avg===null?'–':`${avg} dgn`;
}
function filterAndSort() {
  const q=els.searchInput.value.trim().toLowerCase();
  const chamber=els.chamberFilter.value, type=els.typeFilter.value, view=els.viewFilter.value;
  let rows=state.trades.filter(t => {
    const hay=[t.politician,t.symbol,t.assetDescription,t.state,t.party].join(' ').toLowerCase();
    if(q && !hay.includes(q)) return false;
    if(chamber!=='all' && t.chamber!==chamber) return false;
    if(type!=='all' && !(type==='Purchase'?isBuy(t.type):type==='Sale'?isSale(t.type):t.type===type)) return false;
    if(view==='watchlist' && !isWatched(t)) return false;
    if(view==='notable' && t.score<50) return false;
    if(view==='late' && !(t.reportingDelayDays>45)) return false;
    return true;
  });
  const sort=els.sortFilter.value;
  rows.sort((a,b)=>{
    if(sort==='amount-desc') return midpoint(b)-midpoint(a);
    if(sort==='delay-desc') return (b.reportingDelayDays||0)-(a.reportingDelayDays||0);
    if(sort==='score-desc') return b.score-a.score;
    return String(b.disclosureDate).localeCompare(String(a.disclosureDate));
  });
  return rows;
}
function renderTrades() {
  state.filtered=filterAndSort();
  els.resultCount.textContent=`${state.filtered.length.toLocaleString('nl-NL')} resultaten`;
  const rows=state.filtered.slice(0,state.visible);
  if(!rows.length) { els.tradesList.innerHTML='<div class="empty">Geen transacties voor deze filters.</div>'; els.loadMoreBtn.classList.add('hidden'); return; }
  els.tradesList.innerHTML=rows.map(tradeCard).join('');
  els.loadMoreBtn.classList.toggle('hidden', state.visible>=state.filtered.length);
  els.tradesList.querySelectorAll('[data-detail]').forEach(btn=>btn.addEventListener('click',()=>openDetail(btn.dataset.detail)));
  els.tradesList.querySelectorAll('[data-watch]').forEach(btn=>btn.addEventListener('click',(e)=>{e.stopPropagation();toggleWatch(btn.dataset.watch,btn.dataset.kind);}));
}
function tradeCard(t) {
  const buy=isBuy(t.type), sale=isSale(t.type), watched=isWatched(t), watchedTicker=Boolean(t.symbol&&state.watchlist.tickers.includes(t.symbol)), delay=t.reportingDelayDays ?? daysBetween(t.transactionDate,t.disclosureDate);
  return `<article class="trade-card ${t.score>=50?'notable':''}">
    ${t.symbol?`<button class="ticker ticker-watch ${watchedTicker?'active':''}" data-watch="${escapeHtml(t.symbol)}" data-kind="ticker" aria-label="${watchedTicker?'Stop ticker volgen':'Volg ticker'}">${escapeHtml(t.symbol)}</button>`:`<div class="ticker">—</div>`}
    <div class="trade-main">
      <button data-detail="${escapeHtml(t.id)}"><strong>${escapeHtml(t.politician)}</strong></button>
      <small>${escapeHtml(t.assetDescription||'Niet nader omschreven')} · ${escapeHtml(t.chamber||'')}</small>
      <div class="pill-row">
        <span class="pill ${buy?'buy':sale?'sale':''}">${escapeHtml(typeLabel(t.type))}</span>
        <span class="pill">${escapeHtml(t.owner||'Eigenaar onbekend')}</span>
        ${delay>45?'<span class="pill warn">Te laat gemeld</span>':''}
        ${t.score>=50?`<span class="pill warn">${escapeHtml(scoreLabel(t.score))} · ${t.score}</span>`:''}
      </div>
    </div>
    <div class="trade-amount"><strong>${escapeHtml(t.amount||'Bedrag onbekend')}</strong><small>Bandbreedte</small></div>
    <div class="trade-meta"><strong>${fmtDate(t.disclosureDate)}</strong><small>Transactie ${fmtDate(t.transactionDate)}${Number.isFinite(delay)?` · ${delay} dgn later`:''}</small></div>
    <button class="watch-btn ${watched?'active':''}" data-watch="${escapeHtml(t.politician)}" data-kind="politician" aria-label="${watched?'Stop volgen':'Volg politicus'}">★</button>
  </article>`;
}
function renderWatchlist() {
  const p=state.watchlist.politicians, t=state.watchlist.tickers;
  if(!p.length&&!t.length){els.watchlistSummary.innerHTML='<p>Nog geen politici of tickers gevolgd. Tik op de ster bij een transactie.</p>';return;}
  els.watchlistSummary.innerHTML=[...p.map(x=>`<span class="watch-chip">👤 ${escapeHtml(x)} <button data-remove="${escapeHtml(x)}" data-kind="politician">×</button></span>`),...t.map(x=>`<span class="watch-chip"># ${escapeHtml(x)} <button data-remove="${escapeHtml(x)}" data-kind="ticker">×</button></span>`)].join('');
  els.watchlistSummary.querySelectorAll('[data-remove]').forEach(btn=>btn.addEventListener('click',()=>toggleWatch(btn.dataset.remove,btn.dataset.kind)));
}
function toggleWatch(value,kind) {
  const key=kind==='ticker'?'tickers':'politicians'; const arr=state.watchlist[key]; const i=arr.indexOf(value);
  if(i>=0) arr.splice(i,1); else arr.push(value);
  localStorage.setItem('cp-watchlist',JSON.stringify(state.watchlist)); renderTrades(); renderWatchlist();
}
function openDetail(id) {
  const t=state.trades.find(x=>x.id===id); if(!t)return;
  const delay=t.reportingDelayDays ?? daysBetween(t.transactionDate,t.disclosureDate);
  const cluster=state.trades.filter(x=>x.symbol&&x.symbol===t.symbol).length;
  els.detailContent.innerHTML=`<span class="eyebrow">${escapeHtml(t.chamber)} · ${escapeHtml(t.party||'Partij onbekend')}</span><h2>${escapeHtml(t.politician)}</h2><p>${escapeHtml(typeLabel(t.type))} van <strong>${escapeHtml(t.assetDescription||t.symbol||'effect')}</strong>.</p>
    <div class="detail-grid">
      <div class="detail-item"><span>Ticker</span><strong>${escapeHtml(t.symbol||'Onbekend')}</strong></div>
      <div class="detail-item"><span>Bedrag</span><strong>${escapeHtml(t.amount||'Onbekend')}</strong></div>
      <div class="detail-item"><span>Transactiedatum</span><strong>${fmtDate(t.transactionDate)}</strong></div>
      <div class="detail-item"><span>Openbaar gemaakt</span><strong>${fmtDate(t.disclosureDate)}</strong></div>
      <div class="detail-item"><span>Meldvertraging</span><strong>${Number.isFinite(delay)?`${delay} dagen`:'Onbekend'}</strong></div>
      <div class="detail-item"><span>Eigenaar</span><strong>${escapeHtml(t.owner||'Onbekend')}</strong></div>
      <div class="detail-item"><span>Opvallendheid</span><strong>${t.score}/100 · ${escapeHtml(scoreLabel(t.score))}</strong></div>
      <div class="detail-item"><span>Aantal meldingen ticker</span><strong>${cluster}</strong></div>
    </div>
    <p class="fineprint">De score weegt bedrag, meldsnelheid, bronvermelding en clustering van dezelfde ticker. Dit is geen voorspelling van koersrendement.</p>
    ${t.comment?`<p><strong>Opmerking:</strong> ${escapeHtml(t.comment)}</p>`:''}
    ${safeUrl(t.sourceUrl)?`<p><a href="${escapeHtml(safeUrl(t.sourceUrl))}" target="_blank" rel="noopener">Open de originele officiële melding ↗</a></p>`:'<p>Geen directe bronlink beschikbaar in deze dataset.</p>'}`;
  els.detailDialog.showModal();
}

async function requestNotifications() {
  if(!('Notification' in window)){alert('Deze browser ondersteunt geen webmeldingen. Gebruik de ntfy-opzet voor betrouwbare telefoonmeldingen.');return;}
  const result=await Notification.requestPermission();
  els.notificationBtn.textContent=result==='granted'?'Meldingen toegestaan':'Meldingen inschakelen';
  if(result==='granted' && navigator.serviceWorker){const reg=await navigator.serviceWorker.ready;reg.showNotification('Capitol Pulse is actief',{body:'Je ontvangt meldingen wanneer de app nieuwe data ziet. Voor meldingen terwijl de app volledig dicht is, activeer de gratis ntfy-monitor.',icon:'./icons/icon-192.png'});}
}

['input','change'].forEach(evt=>els.searchInput.addEventListener(evt,()=>{state.visible=PAGE_SIZE;renderTrades();}));
[els.chamberFilter,els.typeFilter,els.viewFilter,els.sortFilter].forEach(el=>el.addEventListener('change',()=>{state.visible=PAGE_SIZE;renderTrades();}));
els.loadMoreBtn.addEventListener('click',()=>{state.visible+=PAGE_SIZE;renderTrades();});
els.refreshBtn.addEventListener('click',()=>loadData(true));
els.notificationBtn.addEventListener('click',requestNotifications);
$('setupBtn').addEventListener('click',()=>els.setupDialog.showModal());
$('aboutBtn').addEventListener('click',()=>els.aboutDialog.showModal());

let deferredPrompt;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;els.installBtn.classList.remove('hidden');});
els.installBtn.addEventListener('click',async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;els.installBtn.classList.add('hidden');});

if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
loadData();
setInterval(()=>loadData(false,true),60000);
