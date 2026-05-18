var GEMINI_API_KEY = 'YOUR_GEMINI_API_KEY';
var CAFLOU_API_KEY = 'YOUR_CAFLOU_API_KEY';
var SHEET_MAILY = 'Maily – prehľad';
var SHEET_PROJEKTY = 'Projekty';

var SYSTEM_PROMPT = 'Si asistent projektového manažéra v architektonickom ateliéri Tornyos Architects. ' +
  'Ateliér projektuje RD, BD, občiansku vybavenosť a interiéry. Číslo projektu: formát RR-NNN (napr. 25-040). ' +
  'TÍM (interní): Tomas – šéf a architekt, Jozef – PM aj architekt aj projektant, Mirka a Veronika – architektky, Erik, Lucia, Sona – projektanti. ' +
  'PROFESISTI (externí): statik, PBS, ZTI, ÚK, VZT, ELI, plyn, dopravák. ' +
  'PROCES: AŠ → stavebný zámer → ASR (doprava+statik+PBS → ZTI+ELI+plyn+VZT+ÚK) → kompletizácia → inžiniering. ' +
  'ZÁVISLOSTI: ELI potrebuje vyjadrenie DS → zmluva o pripojení → výkonová bilancia → tepelné straty + tepelný zdroj. ' +
  'Zrážkové vody bez recipienta: vsakovanie (HGP + ZTI), ak nestačí → vodohospodársky podnik. ' +
  'ROLY: projektant=interný člen tímu, profesista=externý odborník, klient=objednávateľ, inžiniering=získava stavebné povolenie, úrady=správcovia sietí+stavebný úrad.';

// ── HLAVNÁ FUNKCIA ────────────────────────────────────────────────────────
function sledujMaily() {
  var props = PropertiesService.getScriptProperties();
  var spracovane = JSON.parse(props.getProperty('spracovane') || '[]');
  var projekty = nacitajProjekty();
  var threads = GmailApp.search('newer_than:1d label:inbox', 0, 300);
  Logger.log('Počet vlákien: ' + threads.length);
  threads.forEach(function(thread) {
    thread.getMessages().forEach(function(msg) {
      var id = msg.getId();
      if (spracovane.indexOf(id) === -1) {
        Logger.log('Spracúvam: ' + msg.getSubject());
        spracujMail(msg, projekty);
        spracovane.push(id);
      }
    });
  });
  if (spracovane.length > 500) spracovane = spracovane.slice(-500);
  props.setProperty('spracovane', JSON.stringify(spracovane));
}

// ── NAČÍTAJ PROJEKTY ──────────────────────────────────────────────────────
function nacitajProjekty() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ws = ss.getSheetByName(SHEET_PROJEKTY);
  if (!ws) return [];
  var data = ws.getDataRange().getValues();
  var projekty = [];
  for (var i = 2; i < data.length; i++) {
    if (data[i][0]) {
      projekty.push({
        cislo: String(data[i][0]).trim(),
        nazov: String(data[i][1]).trim()
      });
    }
  }
  return projekty;
}

// ── GEMINI ANALÝZA ────────────────────────────────────────────────────────
function analyzovatGemini(predmet, odosielatel, telo, projekty) {
  var projektList = projekty.map(function(p) {
    return p.cislo + ' – ' + p.nazov;
  }).join('\n');

  var prompt = SYSTEM_PROMPT + '\n\n' +
    'ZOZNAM PROJEKTOV V ATELIÉRI:\n' + projektList + '\n\n' +
    'Analyzuj tento email a vráť JSON (nič iné, len čistý JSON bez ```json):\n' +
    '{"od_koho":"meno odosielateľa",' +
    '"rola":"projektant / profesista / klient / inžiniering / úrad / iné",' +
    '"tema":"1-2 vety o čom mail je",' +
    '"dohodnute":"čo sa dohodlo, ak nič tak null",' +
    '"akcia_potrebna":true alebo false,' +
    '"akcia_popis":"čo treba urobiť, ak nič tak null",' +
    '"termin":"dátum vo formáte YYYY-MM-DD, ak nie je tak null",' +
    '"priorita":"high / medium / low"}\n\n' +
    'Predmet: ' + predmet + '\nOd: ' + odosielatel + '\nTelo: ' + telo;

  for (var pokus = 0; pokus < 3; pokus++) {
    var response = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1 }
        }),
        muteHttpExceptions: true
      }
    );
    var code = response.getResponseCode();
    if (code === 503 || code === 429) {
      Logger.log('Preťažený, čakám 30s...');
      Utilities.sleep(30000);
      continue;
    }
    var result = JSON.parse(response.getContentText());
    if (!result.candidates || result.candidates.length === 0) {
      throw new Error('Gemini nevrátil candidates');
    }
    var text = result.candidates[0].content.parts[0].text;
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  }
  throw new Error('Gemini nedostupný po 3 pokusoch');
}

// ── SPRACUJ MAIL ──────────────────────────────────────────────────────────
function spracujMail(msg, projekty) {
  var predmet = msg.getSubject();
  var odosielatel = msg.getFrom();
  var telo = msg.getPlainBody().substring(0, 2000);
  var datum = msg.getDate();
  var najdenyProjekt = najdiProjekt(predmet + ' ' + telo, projekty);
  try {
    var data = analyzovatGemini(predmet, odosielatel, telo, projekty);
    data.projekt_cislo = najdenyProjekt ? najdenyProjekt.cislo : '';
    data.projekt_nazov = najdenyProjekt ? najdenyProjekt.nazov : '';
    zapisDoSheets(datum, data);
  } catch(e) {
    Logger.log('Chyba: ' + e.toString());
  }
}

// ── ZAPIS DO SHEETS ───────────────────────────────────────────────────────
function zapisDoSheets(datum, data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ws = ss.getSheetByName(SHEET_MAILY);
  if (!ws) return;
  ws.appendRow([
    Utilities.formatDate(datum, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
    data.projekt_cislo || '',
    data.projekt_nazov || '',
    data.od_koho || '',
    data.rola || '',
    data.tema || '',
    data.dohodnute || '',
    data.akcia_potrebna ? 'ÁNO' : 'NIE',
    data.akcia_popis || '',
    data.termin || '',
    data.priorita || ''
  ]);
}

// ── NÁJDI PROJEKT ─────────────────────────────────────────────────────────
function najdiProjekt(text, projekty) {
  var textLower = text.toLowerCase();
  for (var i = 0; i < projekty.length; i++) {
    if (textLower.indexOf(projekty[i].cislo.toLowerCase()) !== -1) {
      return projekty[i];
    }
  }
  for (var i = 0; i < projekty.length; i++) {
    var slova = projekty[i].nazov.toLowerCase().split(/[\s\-–]+/);
    for (var j = 0; j < slova.length; j++) {
      if (slova[j].length >= 4 && textLower.indexOf(slova[j]) !== -1) {
        return projekty[i];
      }
    }
  }
  return null;
}

// ── TEST CAFLOU ───────────────────────────────────────────────────────────
function testCaflou() {
  var response = UrlFetchApp.fetch('https://app.caflou.com/api/v1/projects', {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + CAFLOU_API_KEY },
    muteHttpExceptions: true
  });
  Logger.log('Status: ' + response.getResponseCode());
  Logger.log('Response: ' + response.getContentText().substring(0, 500));
}

// ── TEST JEDEN MAIL ───────────────────────────────────────────────────────
function testJeden() {
  var projekty = nacitajProjekty();
  var threads = GmailApp.search('newer_than:1d label:inbox', 0, 1);
  if (threads.length === 0) { Logger.log('Žiadne maily'); return; }
  var msg = threads[0].getMessages()[0];
  Logger.log('Predmet: ' + msg.getSubject());
  spracujMail(msg, projekty);
  Logger.log('Hotovo');
}

// ── WEB APP ───────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var resp = {};
    if      (req.action === 'zhrniProjekt')   resp = akcia_zhrniProjekt(req);
    else if (req.action === 'navrhniUlohy')   resp = akcia_navrhniUlohy(req);
    else if (req.action === 'getMaily')       resp = akcia_getMaily(req);
    else if (req.action === 'getKontakty')    resp = akcia_getKontakty(req);
    else if (req.action === 'zhrniPortfolio') resp = akcia_zhrniPortfolio(req);
    else resp = { ok: false, error: 'Neznáma akcia: ' + req.action };
    return ContentService.createTextOutput(JSON.stringify(resp))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function akcia_zhrniProjekt(req) {
  var prompt = SYSTEM_PROMPT + '\n\n' +
    'Projekt: ' + req.cislo + ' – ' + (req.nazov||'') + '\n' +
    'Fáza: ' + (req.faza||'') + '\n\n' +
    'Posledné záznamy z denníka:\n' + (req.text||'(žiadne záznamy)') + '\n\n' +
    'Napíš 1-2 vety o aktuálnom stave projektu. ' +
    'Sústreď sa na to čo bolo naposledy riešené a čo je ďalší krok. ' +
    'Odpovedz len samotným zhrnutím, bez uvodzoviek ani predhovoru.';
  var zhrnutie = volajGemini(prompt);
  return { ok: true, zhrnutie: zhrnutie };
}

function akcia_navrhniUlohy(req) {
  var prompt = SYSTEM_PROMPT + '\n\n' +
    'Z tohto záznamu do denníka projektu navrhni konkrétne úlohy ktoré treba vykonať.\n' +
    'Záznam: ' + (req.text||'') + '\n\n' +
    'Vráť JSON (nič iné, len čistý JSON):\n' +
    '{"ulohy":[{"profesia":"statik/ZTI/ELI/interný/...","popis":"čo treba urobiť"}]}\n' +
    'Ak žiadne úlohy nevyplývajú, vráť {"ulohy":[]}.';
  var raw = volajGemini(prompt);
  var parsed = JSON.parse(raw.replace(/```json|```/g,'').trim());
  return { ok: true, ulohy: parsed.ulohy || [] };
}

function akcia_getMaily(req) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ws = ss.getSheetByName(SHEET_MAILY);
  if (!ws) return { ok: true, maily: [] };
  var data = ws.getDataRange().getValues();
  var maily = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim() === String(req.cislo).trim()) {
      maily.push({
        datum:          data[i][0],
        od_koho:        data[i][3],
        rola:           data[i][4],
        tema:           data[i][5],
        dohodnute:      data[i][6],
        akcia_potrebna: data[i][7] === 'ÁNO',
        akcia_popis:    data[i][8],
        termin:         data[i][9],
        priorita:       data[i][10]
      });
    }
  }
  return { ok: true, maily: maily.slice(-10) };
}

function akcia_getKontakty(req) {
  try {
    var token = ScriptApp.getOAuthToken();
    var headers = { 'Authorization': 'Bearer ' + token };
    var groupsJson = UrlFetchApp.fetch(
      'https://people.googleapis.com/v1/contactGroups?pageSize=200',
      { headers: headers }
    ).getContentText();
    var groupMap = {};
    (JSON.parse(groupsJson).contactGroups || []).forEach(function(g) {
      if (g.groupType === 'USER_CONTACT_GROUP') groupMap[g.resourceName] = g.name;
    });
    var result = [];
    var pageToken = '';
    do {
      var url = 'https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers,organizations,memberships&pageSize=1000' +
        (pageToken ? '&pageToken=' + pageToken : '');
      var resp = JSON.parse(UrlFetchApp.fetch(url, { headers: headers }).getContentText());
      (resp.connections || []).forEach(function(p) {
        var emails = p.emailAddresses || [];
        if (!emails.length) return;
        var names = p.names || [];
        var phones = p.phoneNumbers || [];
        var orgs = p.organizations || [];
        var labels = (p.memberships || [])
          .filter(function(m) { return m.contactGroupMembership && groupMap[m.contactGroupMembership.contactGroupResourceName]; })
          .map(function(m) { return groupMap[m.contactGroupMembership.contactGroupResourceName]; });
        result.push({
          name:    names.length ? names[0].displayName : emails[0].value,
          email:   emails[0].value,
          labels:  labels,
          company: orgs.length ? (orgs[0].name || '') : '',
          phone:   phones.length ? phones[0].value : ''
        });
      });
      pageToken = resp.nextPageToken || '';
    } while (pageToken);
    return { ok: true, contacts: result };
  } catch(e) {
    return { ok: false, error: e.toString() };
  }
}

// ── ZHRNI PORTFOLIO ───────────────────────────────────────────────────────
// POZOR: nepoužíva SYSTEM_PROMPT — prompt by bol príliš dlhý (429 rate limit)
function akcia_zhrniPortfolio(req) {
  var prompt =
    'Si PM asistent architektonického ateliéra. Tím: Tomas (šéf), Jozef (PM), Mirka, Veronika (architektky), Erik, Lucia, Sona (projektanti).\n\n' +
    'Zhrn celkový stav portfólia na základe denníkov. Odpovedz v slovenčine, štruktúruj takto:\n' +
    'KRITICKÉ / vyžaduje okamžitú pozornosť\n' +
    'TENTO TÝŽDEŇ – na čo sa zamerať\n' +
    'CELKOVÝ STAV (2-3 vety)\n\n' +
    'DENNÍKY:\n' + (req.text || '(žiadne záznamy)');

  if (prompt.length > 4000) prompt = prompt.slice(0, 4000) + '\n…(skrátené)';
  var zhrnutie = volajGemini(prompt);
  return { ok: true, zhrnutie: zhrnutie };
}

// ── GEMINI VOLANIE ────────────────────────────────────────────────────────
function volajGemini(prompt) {
  for (var pokus = 0; pokus < 3; pokus++) {
    var response = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1 }
        }),
        muteHttpExceptions: true
      }
    );
    var code = response.getResponseCode();
    if (code === 503 || code === 429) { Utilities.sleep(5000); continue; }
    var result = JSON.parse(response.getContentText());
    if (!result.candidates || !result.candidates[0]) {
      throw new Error('Prázdna odpoveď: ' + JSON.stringify(result).slice(0, 200));
    }
    return result.candidates[0].content.parts[0].text;
  }
  throw new Error(code === 429 ? 'Gemini rate limit – počkaj minútu a skús znova' : 'Gemini nedostupný po 3 pokusoch');
}

function testPeople() {
  var resp = People.ContactGroups.list({ pageSize: 5 });
  Logger.log(JSON.stringify(resp));
}
