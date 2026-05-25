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
    else if (req.action === 'zhrniPortfolio')     resp = akcia_zhrniPortfolio(req);
    else if (req.action === 'listProjectFolder')  resp = akcia_listProjectFolder(req);
    else if (req.action === 'generateZoznam')     resp = akcia_generateZoznam(req);
    else if (req.action === 'generateSuhrn')      resp = akcia_generateSuhrn(req);
    else resp = { ok: false, error: 'Neznáma akcia: ' + req.action };
    return ContentService.createTextOutput(JSON.stringify(resp))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function akcia_zhrniProjekt(req) {
  // Ak maily neprídu z frontendu, načítame ich interne (jeden request namiesto dvoch)
  var maily = (req.maily && req.maily.length) ? req.maily : (akcia_getMaily(req).maily || []).slice(-6);
  var mailyText = '';
  if (maily.length) {
    mailyText = '\n\nPosledné emaily:\n' + maily.map(function(m) {
      var parts = [m.datum, m.od_koho, m.tema];
      if (m.dohodnute) parts.push('Dohodnuté: ' + m.dohodnute);
      if (m.akcia_potrebna && m.akcia_popis) parts.push('Akcia: ' + m.akcia_popis);
      return parts.filter(Boolean).join(' | ');
    }).join('\n');
  }
  var prompt = SYSTEM_PROMPT + '\n\n' +
    'Projekt: ' + req.cislo + ' – ' + (req.nazov||'') + '\n' +
    'Fáza: ' + (req.faza||'') + '\n\n' +
    'Záznamy z denníka (posledné):\n' + (req.text||'(žiadne záznamy)') +
    mailyText + '\n\n' +
    'Napíš zhrnutie aktuálneho stavu projektu. ' +
    'Ak sú viaceré odlišné otvorené témy (napr. riešenie sietí, stavebné povolenie, ' +
    'zapracovanie zmien), rozdeľ zhrnutie do krátkych odrážok – každá téma jeden riadok začínajúci „• ". ' +
    'Ak je len jedna téma, napíš 1-2 vety bez odrážok. ' +
    'Odpovedz len samotným zhrnutím, bez predhovoru ani uvodzoviek.';
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
  var code, rawText;
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
    code = response.getResponseCode();
    rawText = response.getContentText();
    if (code === 503) { Utilities.sleep(5000); continue; }
    if (code === 429) {
      try {
        var errBody = JSON.parse(rawText);
        var msg = (errBody.error && errBody.error.message) ? errBody.error.message : rawText.slice(0, 200);
        throw new Error('Gemini 429: ' + msg);
      } catch(pe) { if (pe.message.indexOf('429') !== -1) throw pe; }
      throw new Error('Gemini 429: ' + rawText.slice(0, 200));
    }
    if (code !== 200) throw new Error('Gemini HTTP ' + code + ': ' + rawText.slice(0, 200));
    var result = JSON.parse(rawText);
    if (!result.candidates || !result.candidates[0]) {
      throw new Error('Gemini prázdna odpoveď: ' + JSON.stringify(result).slice(0, 200));
    }
    return result.candidates[0].content.parts[0].text;
  }
  throw new Error('Gemini HTTP ' + code + ' po 3 pokusoch: ' + (rawText||'').slice(0, 200));
}

// ══════════════════════════════════════════════════════════════════════════════
// GENERÁTOR DOKUMENTÁCIE (suhrn.html)
// ══════════════════════════════════════════════════════════════════════════════

var VZOR_ZOZNAM_ID = '1J2GzotOVyr-n7Tf315naJjPQszWA1FG2i4RN5j4n9v8';
var VZOR_SUHRN_ID  = '17u-hXwikZGL-ZVElmGIp7TKB0ToaiR1uULU81jllNZE';

// ── ZOZNAM SÚBOROV V PRIEČINKU ────────────────────────────────────────────────

function akcia_listProjectFolder(req) {
  if (!req.folderId) return { ok: false, error: 'Chýba folderId' };
  try {
    var tree = buildFolderTree(DriveApp.getFolderById(req.folderId), 0);
    return { ok: true, tree: tree };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

function buildFolderTree(folder, depth) {
  var READABLE = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/vnd.google-apps.document'
  ];
  var node = { name: folder.getName(), id: folder.getId(), files: [], subfolders: [] };
  var fi = folder.getFiles();
  while (fi.hasNext()) {
    var f = fi.next();
    if (READABLE.indexOf(f.getMimeType()) !== -1) {
      node.files.push({ id: f.getId(), name: f.getName(), type: f.getMimeType() });
    }
  }
  node.files.sort(function(a,b) { return a.name.localeCompare(b.name, 'sk'); });
  if (depth < 3) {
    var si = folder.getFolders();
    while (si.hasNext()) {
      node.subfolders.push(buildFolderTree(si.next(), depth + 1));
    }
    node.subfolders.sort(function(a,b) { return a.name.localeCompare(b.name, 'sk'); });
  }
  return node;
}

// ── GENEROVANIE ZOZNAMU DOKUMENTÁCIE ─────────────────────────────────────────

function akcia_generateZoznam(req) {
  var p = req.projekt || {};
  var folderId = req.folderId;

  var tree = buildFolderTree(DriveApp.getFolderById(folderId), 0);
  var fileListText = treeToPlainText(tree, '');

  var specsText = buildSpecsText(req.specialists || []);

  var datumFormatted = p.datum || '';
  var prompt =
    'Vygeneruj Zoznam dokumentácie (dokument A – Zoznam dokumentácie) pre projekt stavby.\n\n' +
    'VZOR – dodržuj presne túto štruktúru:\n' +
    '• Titulná časť: Stupeň, "A – Zoznam dokumentácie", Stavba, ID projektu, parcely, miesto, stavebník, miesto+dátum+revízia, počet strán\n' +
    '• Sekcia A: ZOZNAM DOKUMENTÁCIE (len nadpis)\n' +
    '• Sekcia B: SÚHRNNÁ SPRÁVA (len nadpis)\n' +
    '• Sekcia C: SITUAČNÉ VÝKRESY – koordinačný situačný výkres (SIT.001/SIT.002), situačný výkres na katastrálnej mape (SIT.002/SIT.003)\n' +
    '• Sekcia D: DOKUMENTÁCIA STAVEBNÝCH OBJEKTOV – pre každú profesiu: NÁZOV PROFESIE veľkými písmenami, "Zodpovedný projektant: Meno", zoznam výkresov (01, 02, 03...) a technická správa\n' +
    '• Sekcia E: PRÍLOHY – PBS (Požiarna bezpečnosť), Energetické hodnotenie\n\n' +
    'ÚDAJE O PROJEKTE:\n' +
    'Stupeň: ' + (p.stupen || 'Projekt stavby') + '\n' +
    'ID projektu / stavby: ' + (p.cislo || '—') + '\n' +
    'Názov stavby: ' + (p.nazov || '—') + '\n' +
    'Stavebník: ' + (p.stavebnik || '—') + '\n' +
    'Miesto stavby: ' + (p.miesto || '—') + '\n' +
    'Parcelné čísla: ' + (p.parcely || '—') + '\n' +
    'Dátum vydania: ' + datumFormatted + '\n\n' +
    'ZODPOVEDNÍ PROJEKTANTI PROFESIÍ:\n' + specsText + '\n\n' +
    'SÚBORY V PROJEKTOVOM PRIEČINKU:\n' + fileListText + '\n\n' +
    'POKYNY:\n' +
    '- Na základe názvov súborov urči výkresy a dokumenty každej profesie\n' +
    '- Profesie zodpovedajú názvom podpriečinkov (Architektura → ARCHITEKTONICKO-STAVEBNÉ RIEŠENIE, Statika → STATIKA, atď.)\n' +
    '- Technickú správu uvádzaj bez čísla, výkresy čísluj 01, 02, 03...\n' +
    '- Ak nie sú konkrétne názvy výkresov, odvoď typické výkresy pre daný typ stavby a stupeň\n' +
    '- Odpovedaj len samotným textom dokumentu, bez markdown, bez ``` obalov, bez komentárov';

  var content = volajGemini(prompt);
  var title = 'A – Zoznam dokumentácie – ' + (p.cislo || p.nazov || 'projekt');
  var doc = createDocInFolder(title, content, folderId);
  return { ok: true, docUrl: doc.url, docId: doc.id };
}

// ── GENEROVANIE SÚHRNNEJ SPRÁVY ───────────────────────────────────────────────

function akcia_generateSuhrn(req) {
  var p = req.projekt || {};
  var folderId = req.folderId;

  // Čítaj technické správy z Drive
  var tree = buildFolderTree(DriveApp.getFolderById(folderId), 0);
  var techReports = extractTechReports(tree);

  var reportsSection = '';
  var keys = Object.keys(techReports);
  for (var i = 0; i < keys.length; i++) {
    reportsSection += '\n=== ' + keys[i] + ' ===\n' + techReports[keys[i]] + '\n';
  }

  var specsText = buildSpecsText(req.specialists || []);

  // Načítaj vzor (prvých 4000 znakov pre štruktúru)
  var vzorText = '';
  try {
    vzorText = DocumentApp.openById(VZOR_SUHRN_ID).getBody().getText().substring(0, 4000);
  } catch(e) { vzorText = '(vzor nedostupný)'; }

  var prompt =
    'Vygeneruj kompletnú Súhrnnú správu projektu stavby (B – Súhrnná správa) v slovenčine.\n\n' +
    'VZOR ŠTRUKTÚRY (dodržuj presne tieto kapitoly a písmena a-o):\n' + vzorText + '\n\n' +
    '---\n' +
    'ÚDAJE O PROJEKTE:\n' +
    'Stupeň: ' + (p.stupen || 'Projekt stavby') + '\n' +
    'ID projektu / stavby: ' + (p.cislo || '—') + '\n' +
    'Názov stavby: ' + (p.nazov || '—') + '\n' +
    'Stavebník: ' + (p.stavebnik || '—') + '\n' +
    'Miesto stavby: ' + (p.miesto || '—') + '\n' +
    'Parcelné čísla: ' + (p.parcely || '—') + '\n' +
    'LV: ' + (p.lv || '—') + '\n' +
    'Dátum: ' + (p.datum || '—') + '\n' +
    'Predpokladané náklady: ' + (p.naklady || '—') + '\n' +
    'Charakter stavby: ' + (p.typ || '—') + '\n' +
    (p.poznamky ? 'Doplňujúce informácie: ' + p.poznamky + '\n' : '') + '\n' +
    'GENERÁLNY PROJEKTANT:\n' + (p.genProjektant || '—') + '\n\n' +
    'PROJEKTANTI PROFESIÍ:\n' + specsText + '\n\n' +
    'TECHNICKÉ SPRÁVY PROFESIÍ (obsah z Drive):\n' + (reportsSection || '(žiadne technické správy neboli nájdené)') + '\n\n' +
    'POKYNY:\n' +
    '- Vygeneruj KOMPLETNÚ súhrnnú správu – všetky kapitoly 1 až 9 so všetkými podbodmi\n' +
    '- Kde máš obsah z technických správ, použi ho priamo\n' +
    '- Kde nemáš informácie, použi odbornú formuláciu primeranú tomuto typu stavby a stupňu\n' +
    '- Zahrň aj tabuľky odpadov (počas výstavby a prevádzky) z kapitoly 8c\n' +
    '- Štýl: odborný, slovenčina, stavebná dokumentácia\n' +
    '- Začni priamo od "1) Identifikačné údaje" – titulnú hlavičku pridáme samostatne\n' +
    '- Výstup: len text dokumentu bez markdown, bez ``` obalov';

  var content = volajGemini(prompt);

  // Pridaj hlavičku
  var header =
    p.stupen + '\n\n' +
    'B – Súhrnná správa\n\n' +
    'Stavba: ' + p.nazov + '\n' +
    'ID projektu / stavby: ' + p.cislo + '\n' +
    'Na parcelách č.: ' + p.parcely + '\n' +
    'Miesto stavby: ' + p.miesto + '\n' +
    'Stavebník: ' + p.stavebnik + '\n\n' +
    (p.datum || '') + '   REVÍZIA 000\n\n' +
    '─────────────────────────────────────────────────────\n\n';

  var title = 'B – Súhrnná správa – ' + (p.cislo || p.nazov || 'projekt');
  var doc = createDocInFolder(title, header + content, folderId);
  return { ok: true, docUrl: doc.url, docId: doc.id };
}

// ── POMOCNÉ FUNKCIE ───────────────────────────────────────────────────────────

function buildSpecsText(specialists) {
  if (!specialists || !specialists.length) return '(nezadaní)';
  return specialists.map(function(s) {
    var lines = [s.profesia || ''];
    if (s.meno) lines.push(s.meno);
    if (s.reg)  lines.push('Registračné číslo oprávnenia: ' + s.reg);
    return lines.join('\n');
  }).join('\n\n');
}

function treeToPlainText(node, indent) {
  var lines = [];
  if (indent) lines.push(indent.slice(2) + '[' + node.name + '/]');
  node.files.forEach(function(f) { lines.push(indent + '• ' + f.name); });
  node.subfolders.forEach(function(sub) { lines.push(treeToPlainText(sub, indent + '  ')); });
  return lines.join('\n');
}

function isTechReport(name) {
  var l = name.toLowerCase();
  return l.indexOf('technick') !== -1 || l.indexOf('správa') !== -1 ||
         l.indexOf('sprava') !== -1 || l.indexOf('_ts.') !== -1 ||
         l.startsWith('ts_') || l.startsWith('ts ');
}

function extractTechReports(tree) {
  var result = {};
  function processFolder(folder, profesia) {
    var report = null;
    folder.files.forEach(function(f) { if (!report && isTechReport(f.name)) report = f; });
    if (!report && folder.files.length > 0) report = folder.files[0];
    if (report) {
      try {
        var text = fileToText(report.id, report.type);
        if (text && text.length > 30) result[profesia] = '(súbor: ' + report.name + ')\n' + text;
      } catch(e) {
        result[profesia] = '(chyba čítania súboru ' + report.name + ': ' + e.message + ')';
      }
    }
  }
  tree.subfolders.forEach(function(sub) {
    processFolder(sub, sub.name);
    sub.subfolders.forEach(function(ss) { processFolder(ss, sub.name + ' › ' + ss.name); });
  });
  return result;
}

// Skonvertuje PDF/DOCX súbor z Drive na text cez Drive API (multipart upload = konverzia)
function fileToText(fileId, mimeType) {
  var MAX = 12000;
  var GDOC = 'application/vnd.google-apps.document';

  if (mimeType === GDOC) {
    try { return DocumentApp.openById(fileId).getBody().getText().substring(0, MAX); }
    catch(e) { throw new Error('Čítanie GDoc: ' + e.message); }
  }

  // Pre PDF/DOCX: nahraj znovu ako Google Doc (Drive API konverzia s OCR pre PDF)
  var token  = ScriptApp.getOAuthToken();
  var blob   = DriveApp.getFileById(fileId).getBlob();
  var fileMt = blob.getContentType();
  var bnd    = 'ta' + Math.floor(Math.random() * 1e9);
  var meta   = JSON.stringify({ name: '_tmp_ta_' + fileId.slice(0,8), mimeType: GDOC });

  var part1  = Utilities.newBlob('--' + bnd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n--' + bnd + '\r\nContent-Type: ' + fileMt + '\r\n\r\n').getBytes();
  var fBytes = blob.getBytes();
  var endB   = Utilities.newBlob('\r\n--' + bnd + '--').getBytes();

  var resp = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + bnd },
      payload: part1.concat(fBytes).concat(endB),
      muteHttpExceptions: true
    }
  );

  if (resp.getResponseCode() !== 200) throw new Error('Konverzia: HTTP ' + resp.getResponseCode());
  var newId = JSON.parse(resp.getContentText()).id;

  Utilities.sleep(2500);
  var text = '';
  try {
    text = DocumentApp.openById(newId).getBody().getText().substring(0, MAX);
  } finally {
    try { DriveApp.getFileById(newId).setTrashed(true); } catch(e2) {}
  }
  return text;
}

// Vytvorí Google Doc s formátovaním a presunie ho do cieľového priečinka
function createDocInFolder(title, textContent, parentFolderId) {
  var doc  = DocumentApp.create(title);
  var body = doc.getBody();
  body.clear();

  var lines = textContent.split('\n');
  var skippedLeading = false;

  lines.forEach(function(line) {
    var t = line.trim();
    if (!skippedLeading && !t) return;
    skippedLeading = true;

    if (!t) {
      body.appendParagraph('');
      return;
    }

    // Kapitoly: "1) Identifikačné...", "2) Základné..."
    if (/^\d+\)\s+/.test(t)) {
      var p = body.appendParagraph(t.replace(/\*\*/g, ''));
      p.setHeading(DocumentApp.ParagraphHeading.HEADING1);

    // Podkapitoly: "1.1 ...", "a) ..."
    } else if (/^\d+\.\d+\s/.test(t) || /^[a-z]\)\s/.test(t)) {
      var p = body.appendParagraph(t.replace(/\*\*/g, ''));
      p.setHeading(DocumentApp.ParagraphHeading.HEADING2);

    // Všetky veľké písmená, kratšie ako 80 znakov = nadpis sekcie
    } else if (t.length < 80 && t === t.toUpperCase() && /[A-ZÁČĎÉĚÍŇÓŠŤÚŮÝŽ]{3,}/.test(t)) {
      var p = body.appendParagraph(t);
      p.setHeading(DocumentApp.ParagraphHeading.HEADING2);

    } else {
      body.appendParagraph(line.replace(/\*\*/g, ''));
    }
  });

  doc.saveAndClose();

  // Presun do cieľového priečinka
  try {
    var file = DriveApp.getFileById(doc.getId());
    DriveApp.getFolderById(parentFolderId).addFile(file);
    DriveApp.getRootFolder().removeFile(file);
  } catch(e) {
    Logger.log('Presun zlyhol: ' + e.message + ' – dokument je v koreňovom priečinku');
  }

  return { url: 'https://docs.google.com/document/d/' + doc.getId() + '/edit', id: doc.getId() };
}

// ─────────────────────────────────────────────────────────────────────────────

function testPeople() {
  var resp = People.ContactGroups.list({ pageSize: 5 });
  Logger.log(JSON.stringify(resp));
}
