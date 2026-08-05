# Capitol Pulse

Capitol Pulse is een mobiele, Nederlandstalige webapp voor openbaar gemaakte aandelen- en effectentransacties van leden van het Amerikaanse Congres. De app ondersteunt het House of Representatives en de Senate, maakt het verschil tussen transactie- en openbaarmakingsdatum zichtbaar en berekent de meldvertraging.

> Capitol Pulse is geen realtime handelsfeed. Een transactie verschijnt pas nadat de politicus deze openbaar heeft gemaakt. Bedragen zijn gemelde bandbreedtes, geen exacte waarden. De app is informatief en geen financieel advies.

## Databron

De updater gebruikt de gratis, sleutelvrije statische dataset uit het open-sourceproject [kadoa-org/congress-trading-monitor](https://github.com/kadoa-org/congress-trading-monitor). Dat project ververst zijn data dagelijks en normaliseert gegevens uit de officiële [House Clerk Financial Disclosure](https://disclosures-clerk.house.gov/FinancialDisclosure) en [Senate eFD](https://efdsearch.senate.gov/) filings. Er worden geen betaalde FMP-endpoints gebruikt.

De updater accepteert alleen een niet-lege dataset waarin zowel House als Senate aanwezig zijn. Een lege, gedeeltelijke of onbereikbare bron veroorzaakt een fout en overschrijft `public/data/live.json` niet. Schrijven gebeurt atomair. Met de ETag van het bronbestand levert een ongewijzigde bron HTTP 304 op, zodat de workflow geen onnodige downloads of commits maakt.

De educatieve aandelenanalyse gebruikt sleutelvrije koershistorie en kwartaalreeksen van Yahoo Finance. Deze marktbron is niet officieel, kan vertraagd of onvolledig zijn en wordt daarom zichtbaar naast ieder aandeel vermeld. De vijf controles volgen gangbare begrippen uit de [SEC-uitleg over financiële staten](https://www.sec.gov/about/reports-publications/beginners-guide-financial-statements) en [FINRA-uitleg over aandelenwaardering](https://www.finra.org/investors/investing/investment-products/stocks/evaluating-stocks).

## Repositorystructuur

```text
.github/workflows/
  deploy-pages.yml
  update-trades.yml
scripts/
  update_trades.py
  update_analysis.py
public/
  data/live.json
  data/analysis.json
  icons/icon-192.png
  icons/icon-512.png
index.html
app.js
styles.css
manifest.webmanifest
service-worker.js
requirements.txt
README.md
```

Alle websitepaden zijn relatief. Daardoor werkt dezelfde build lokaal, op een previewserver en onder de GitHub Pages-subdirectory `/capitol-pulse-joep/`.

## Lokaal uitvoeren

Python 3.12 wordt aanbevolen.

```bash
python -m venv .venv
source .venv/bin/activate  # Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python scripts/update_trades.py
python scripts/update_analysis.py
python -m http.server 8000
```

Open daarna `http://localhost:8000/`. Open `index.html` niet rechtstreeks via `file://`: service workers en fetch-verzoeken vereisen HTTP(S).

Optioneel bepaalt `MAX_RECORDS` hoeveel van de nieuwste transacties in de mobiele dataset worden bewaard. De standaard is 1.500; de veiligheidsgrenzen zijn 100 en 5.000.

## Automatische updates

`.github/workflows/update-trades.yml` draait ieder halfuur en kan handmatig worden gestart via `workflow_dispatch`. De workflow:

1. installeert Python en `requirements.txt`;
2. voert `scripts/update_trades.py` en `scripts/update_analysis.py` uit;
3. stopt begrijpelijk als de externe databron niet bereikbaar of leeg is;
4. commit alleen wanneer `public/data/live.json` of `public/data/analysis.json` werkelijk wijzigde;
5. start na een echte wijziging de Pages-publicatie opnieuw.

De workflow heeft uitsluitend `contents: write` nodig. De concurrencygroep voorkomt overlappende updater-runs.

## ntfy-meldingen

Maak optioneel een repository-secret `NTFY_TOPIC` met alleen de willekeurige ntfy-topicnaam. Sla geen volledige URL op en commit de topicnaam nooit. Zonder dit secret blijft de dataset-update gewoon werken.

De eerste succesvolle live-update is altijd een baseline en verstuurt geen oude transacties. Latere runs vergelijken stabiele transactie-ID's en melden alleen nieuwe records.

Optionele repository variables:

- `WATCH_TICKERS`: tickers gescheiden door komma, puntkomma of nieuwe regel, bijvoorbeeld `AAPL,MSFT`;
- `WATCH_POLITICIANS`: namen of unieke naamdelen, bijvoorbeeld `Pelosi,Tuberville`.

Wanneer beide variables leeg zijn, meldt ntfy alle nieuwe transacties. Wanneer één of beide filters zijn ingevuld, volstaat een match met een ticker of politicus.

## Vijfpijleranalyse

De analyse begint altijd met de laatst openbaar gemaakte transactie van de gekozen politicus. Een recente verkoop kan nooit een koopkandidaat opleveren. Na een recente aankoop moeten alle volgende controles slagen:

1. **Groei:** kwartaalomzet groeit minimaal 3% en nettowinst verslechtert niet ten opzichte van hetzelfde kwartaal een jaar eerder.
2. **Winstgevendheid:** nettomarge over de laatste vier beschikbare kwartalen is minimaal 8%.
3. **Kasstroom:** vrije kasstroom is positief en minimaal 5% van de omzet.
4. **Waardering en balans:** positieve K/W van maximaal 35 en schuld/eigen vermogen van maximaal 3.
5. **Trend en risico:** koers en 50-daags gemiddelde liggen boven het 200-daags gemiddelde, RSI ligt tussen 40 en 72 en de geannualiseerde volatiliteit is maximaal 55%.

Alleen 5/5 plus een recente aankoop geeft het label **Koopkandidaat**. De getoonde instapzone gebruikt de laatst beschikbare koers. De stop ligt minimaal 8% of twee ATR onder de instap; het rekenkundige verkoopdoel ligt op twee keer dat risico. Het budgetveld berekent uitsluitend een voorbeeldpositie op basis van het gekozen maximale risico. Het is geen persoonlijk advies, houdt geen rekening met inkomen, vermogen, belastingen, valutarisico, transactiekosten of fractionele aandelen en voert nooit transacties uit.

De openbare Wolf of Washington-pagina noemt geen verifieerbare officiële top vijf en zegt alle Congresleden te volgen. Capitol Pulse gebruikt daarom een eigen, expliciete selectie van vijf actieve en herkenbare politici uit de recente dataset en toont maximaal drie recente gewone aandelen per persoon.

## GitHub Pages

`.github/workflows/deploy-pages.yml` bouwt een minimaal publicatiepakket en gebruikt de officiële Pages Actions. Na het mergen naar `main` moet bij **Settings → Pages → Build and deployment** de bron op **GitHub Actions** staan. De verwachte URL is:

<https://joepxnlx.github.io/capitol-pulse-joep/>

## PWA en offlinegedrag

De manifest- en service-workerpaden zijn geschikt voor de Pages-subdirectory. De app kan op ondersteunde Android-browsers worden geïnstalleerd. De app-shell en beide datasets gebruiken network-first met een offline cache. De Pages-build publiceert tevens een tijdelijk compatibiliteitspad `sw.js`, zodat apparaten met de oude service worker vanzelf naar cacheversie 2 migreren. De browser bewaart daarnaast de laatste geldige payloads en favorieten in `localStorage`.

## Gegevensmodel

Elk genormaliseerd record bevat onder andere:

- stabiele `id`;
- `chamber`, `politician`, `state`;
- `symbol` en `assetDescription`;
- `type` en gemelde bedragbandbreedte;
- `transactionDate` en `disclosureDate`;
- berekende `reportingDelayDays`;
- `sourceUrl` naar het openbare filingportaal.

## Bekende beperkingen

- Capitol Pulse is afhankelijk van de beschikbaarheid, volledigheid en normalisatie van de externe gratis feed.
- Markt- en fundamentendata van Yahoo Finance kunnen vertraagd, gecorrigeerd, rate-limited of onvolledig zijn; bij een mislukte analyse blijft de laatste geldige `analysis.json` behouden.
- De vijf vaste drempels zijn uitlegbare modelregels en geen voorspelling dat een aandeel zal stijgen. Sectorverschillen kunnen maken dat een bruikbaar bedrijf niet door iedere regel komt.
- De bronfeed levert niet voor ieder record partij, eigenaar of een directe URL naar het individuele document; in dat geval verwijst de bronlink naar het officiële filingportaal.
- De GitHub Actions-planning is niet exact: GitHub kan geplande runs bij drukte vertragen.
- ntfy is een externe dienst. Een mislukte ntfy-melding blokkeert het bewaren van een geldige nieuwe dataset niet.
