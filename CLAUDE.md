# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Single-file (`index.html`) project management dashboard for an architecture firm. No build system, no framework — vanilla HTML/CSS/JS deployed via GitHub Pages.

Live URL: `https://architt-ctrl.github.io/prehladpm/`

To deploy changes: `git add index.html && git commit -m "..." && git push origin main`, then hard-refresh the browser (Ctrl+Shift+R).

## Architecture

Everything lives in `index.html`. Structure:

1. **CSS** — CSS custom properties in `:root`, mobile-first styles
2. **HTML** — 4 bottom nav tabs (Štúdia / Projekcia / Inžiniering / Archív), one `secPrehled` section that serves all 4 tabs
3. **JS** — inline `<script>` at the bottom, no modules

### State

All mutable state is in module-level `let` variables:

| Variable | localStorage key | Purpose |
|---|---|---|
| `projects` | — | Array loaded from Caflou API |
| `stavMap` | `pmStav` | `{cislo: 'pripravovany'\|'aktivny'\|'pozastaveny'}` |
| `dennikMap` | `pmDennik` | `{cislo: [{datum, text}]}` — primary storage is Supabase `dennik` table; also written to Caflou comments as backup |
| `geminiMap` | `pmGemini` | `{cislo: 'AI summary text'}` |
| `ulohy` | `pmUlohy` | `{cislo: [{id,profesia,stav,...}]}` |
| `cfg` | `pmCfg3` | `{caflou_key, caflou_id, url (Gemini Apps Script)}` |
| `activeFaza` | — | Current tab: `'Štúdia'\|'Projekcia'\|'Inžiniering'\|'Archív'` |
| `activeStav` | — | Current status filter: `'pripravovany'\|'aktivny'\|'pozastaveny'` |
| `caflouTasksCache` | — | `{cislo: [task,...]}` — lazy-loaded Caflou tasks per project; cleared on syncData |
| `extSpecCache` | — | `{cislo: {taskName: specialistName}}` — loaded from Supabase at task load time |
| `extSpecOverride` | `pmExtSpecOverride` | `{task_id: specialistName}` — manual specialist assignment for old ext tasks |
| `specialistsList` | — | `[{id,name,profession}]` — cached from Supabase, loaded once on first task open |
| `pmSeenAt` | `pmSeenAt` | `{cislo: ISO_timestamp}` — kedy user naposledy otvoril detail projektu; základ pre modrý denník badge |
| `ponukyBadgeSet` | — | `Set<cislo>` projektov s aspoň jednou `submitted` invitation; badge zelená bodka |
| `taskPonukySet` | — | `Set<task_id>` Caflou task_ids s `submitted` invitation; badge `ponuka ↗` na úlohe |
| `_vytazenieCache` | — | Cached HTML ext tím modal; invalidovaný pri `syncData` |
| `_intTimData` | — | Raw data pre int tím modal `{tasks, projects}`; invalidovaný pri `syncData` (nie HTML cache — kvôli interaktivite) |
| `finishedTasksOpen` | — | `Set<cislo>` — ktoré projekty majú rozbalené ukončené úlohy |
| `taskNotesCache` | — | `{taskId: [{id,datum,text}]}` — lazy-loaded komentáre Caflou úloh |
| `taskNotesOpen` | — | `Set<task_id>` — ktoré úlohy majú rozbalené poznámky |

### Data flow – Caflou

- `syncData()` fetches all projects from `https://app.caflou.com/api/v1/{caflou_id}/projects` (paginated, per=100). Caflou supports CORS (`*`) so calls are made directly from the browser.
- `parseCaflouProject(p)` maps each Caflou project using `CAFLOU_STATUS_MAP` (status→fáza/podfáza) and `CAFLOU_TYPE_PODFAZA` (type overrides podfáza).
- `saveProjCaflouStatus()` PATCHes `project_status_id` back to Caflou when fáza changes in the dashboard.
- `caflouAddComment()` writes denník entries to Caflou as project comments (`POST /comments`) as backup.
- Credentials stored in `caflou.env` (gitignored) and in localStorage. If no credentials, `loadDemo()` loads hardcoded sample data.

**Aktivita (stavMap) sync cez `custom_column_produkt`:**
- Caflou nemá `custom_column_aktivita` — aktivita sa číta/zapisuje cez `custom_column_produkt`
- `CAFLOU_PRODUKT_TO_STAV`: "Nové"→`pripravovany`, "Robíme na tom"→`aktivny`, "Hotové"→`aktivny`, "Pozastavené"→`pozastaveny`, "Povoľovací proces"→žiadna aktivita (Inžiniering)
- `CAFLOU_STAV_TO_PRODUKT`: `pripravovany`→"Nové", `aktivny`→"Robíme na tom", `pozastaveny`→"Pozastavené"
- `saveProjStav()` PATCHuje `custom_column_produkt` pri zmene aktivity v dashboarde
- `syncData()` po načítaní projektov: ak `p.aktivita` (z `custom_column_produkt`) je truthy → aktualizuje `stavMap`; projekty bez Caflou hodnoty ale so `stavMap` zápisom → `toPush` loop ich pushne do Caflou

### Data flow – Supabase (denník)

Same Supabase project as `ponuky.html` (`cfjkomqxzqflotrqxfyl.supabase.co`, anon key in `index.html`).

- `dennik` table: `(id uuid, cislo text, datum text, text text, created_at timestamptz)`
- RLS enabled with open policy (`using (true) with check (true)`)
- `syncData()` fetches all denník rows ordered by `created_at desc` → builds `dennikMap`
- `pridajDennik()` inserts new row to Supabase + updates localStorage + writes to Caflou
- Display: `buildDennikListHtml(cislo)` shows 3 newest entries; older ones hidden behind "Zobraziť staršie" toggle
- **Caflou comments API** cannot be used for reading history — filters are ignored server-side, returns 20 items/page across 1000+ pages of bot activity. Supabase is the only reliable cross-device store.
- One-time history recovery: `recover-dennik.ps1` (in repo) scans all Caflou comment pages and imports `kind=human, commented_type=Project` entries to Supabase.

### Caflou status → fáza mapping (`CAFLOU_STATUS_MAP`)

| Caflou status | Fáza | Podfáza |
|---|---|---|
| 0_Podklady / 1_Štúdia | Štúdia | Architektúra |
| 2_SZ | Projekcia | Stavebný zámer |
| 3_DSP / 3_PS | Projekcia | Projekt stavby |
| 4_RP | Projekcia | — |
| 5_Inžiniering / 6_Autorský dozor | Inžiniering | — |
| finished=true | Archív | — |

`CAFLOU_TYPE_PODFAZA` overrides podfáza based on `project_type_name`: `Interiér→Interiér`, `Územné plány→Územný plán`.

### Phase structure

```
Štúdia        → groups: Architektúra / Interiér
Projekcia     → groups: Stavebný zámer / Projekt stavby / RP / Územný plán
Inžiniering   — no sub-groups
Archív        — no status filter
```

### Key rendering pattern

`renderProjects()` re-renders the full project list. **Never call `renderAll()` / `renderProjects()` from within a project detail interaction** — it collapses all open detail panels.

Use `refreshUlohy(cislo)` which updates only `#pd-ulohy-{cislo}` innerHTML for task interactions inside an open `.proj-detail`.

### Caflou tasks (úlohy)

Tasks are loaded lazily on first open of a project detail (`toggleProjDetail` → `loadCaflouTasks`), cached in `caflouTasksCache = {}` (cleared on `syncData`).

**API filter caveat:** `GET /tasks?project_id={id}&per=100` — `per=100` works, but `project_id` filter is **ignored server-side** (same as comments API). Filtering is done client-side using `caflou_task_ids` stored on each project from `parseCaflouProject`:

```javascript
caflou_task_ids: p.task_ids || []   // from projects API response
// in loadCaflouTasks:
const taskIdSet = new Set(proj.caflou_task_ids);
batch.filter(t => taskIdSet.has(t.id))
```

**Status constants:**
```javascript
CAFLOU_TASK_STATUS_IDS   // name → Caflou status ID (interné úlohy)
CAFLOU_TASK_STATUS_ORDER // display order (interné úlohy)
CAFLOU_TASK_STATUS_COLOR // badge color per status
CAFLOU_USERS             // user_id → meno
// PENDING: CAFLOU_EXT_TASK_STATUS_IDS + CAFLOU_EXT_TASK_STATUS_ORDER pre externé úlohy
// (Jozef vytvoril nové statusy v Caflou, treba zistiť IDs – priradiť ich k nejakej úlohe
//  a spustiť PowerShell query: všetky tasky → group by task_status_id)
```

**Caflou API nemá endpoint pre zoznam statusov** — IDs sa zistia len z úloh ktoré daný status používajú.

**Important distinction:**
- `task_status_name === 'Hotové'` = úloha dokončená, ale stále **aktívna** (viditeľná)
- `t.finished === true` = úloha **ukončená** (skrytá, počítaná v "N ukončených skrytých")
- `setCaflouTaskStatus(cislo, task_id, statusName)` — mení status, aktualizuje cache, volá `refreshUlohy`, PATCHuje Caflou
- `finishCaflouTask` (✓ tlačidlo) nastaví `finished=true` a skryje úlohu

**Ukončené úlohy (finished tasks):**
- `finishedTasksOpen = new Set()` — sleduje ktoré projekty majú rozbalené ukončené úlohy
- `toggleFinishedTasks(cislo)` — pridá/odoberie cislo zo setu, volá `refreshUlohy`
- `unfinishCaflouTask(cislo, task_id)` — PATCHuje `finished=false`, obnoví úlohu v cache, volá `refreshUlohy`
- V `buildCaflouTasksHtml`: tlačidlo "▸ N ukončených" → rozbalí zoznam s ↺ tlačidlom na každej

**Task layout (two rows):**
- Riadok 1: názov úlohy (flex:1, kliknuteľný — otvára edit) + tlačidlá ✓ ✕
- Riadok 2: status `<select>` dropdown (sfarbený) + meno osoby + deadline + posledná poznámka (skrátená)
- Externé úlohy zobrazujú špecialistu (zelené); interné zobrazujú Caflou assignee (šedé)
- Edit sa otvára kliknutím na názov úlohy (nie cez ✎ ikonu — tá bola odstránená)

**Interné / Externé kategórie:**
- Rozdelenie podľa Caflou tagu `ext`: `(t.tags||[]).includes('ext')` = externá
- Externé úlohy sa zobrazujú prvé, potom interné
- Tag pri uložení: `t.tags = newExt ? ['ext'] : []` — žiadne skladanie tagov
- V edit forme: tlačidlo **"Interné ✓" / "Externé ✓"** (`id="ttype-{editKey}"`, `data-ext="0/1"`) — vizuálny toggle, uloží sa až pri **Uložiť**
- `toggleTaskExtBtn(editKey)` — prepína text/data-ext bez PATCHu
- **Caflou custom fields na taskoch nie sú dostupné cez API** — vracajú prázdne pole

**Špecialist na externej úlohe:**
- `extSpecCache[cislo] = {taskName: specialistName}` — načítané zo Supabase (requests→invitations[selected]→specialists) pri `loadCaflouTasks`
- `extSpecOverride[task_id] = specialistName` — manuálne priradenie pre staré úlohy, uložené v `localStorage('pmExtSpecOverride')`
- Priorita: `extSpecOverride[t.id]` → `extSpecCache[cislo][t.name]`
- V edit forme ext úlohy: dropdown profesia (auto-detekovaná z názvu úlohy) + dropdown špecialistov filtrovaný podľa profesie
- `loadSpecialists()` — fetchne `specialists` zo Supabase raz, cachuje v `specialistsList`
- `filterSpecDropdown(editKey)` — prefiltruje specialist select podľa vybranej profesie
- Profesia sa auto-detekuje z názvu úlohy: `uniqueProfs.find(p => t.name.toLowerCase().includes(p.toLowerCase()))`

**Editovanie a mazanie:**
- Edit forma má pole pre zmenu názvu (`id="tn-{editKey}"`), user select, date, ext toggle, specialist select (len pre ext)
- ✕ tlačidlo → `deleteCaflouTask(cislo, task_id)` — confirm → DELETE na Caflou API → remove from cache → refreshUlohy
- **Supabase fire-and-forget:** `.catch()` na Supabase query builderoch nefunguje — vždy použiť `.then(null, () => {})`

**Poznámky k externým úlohám (task notes):**
- `taskNotesCache = {taskId: [{id,datum,text}]}` — `undefined` = nenačítané, `null` = načítava sa, `[]` = prázdne
- `taskNotesOpen = new Set()` — ktoré úlohy majú rozbalený zoznam poznámok
- `preloadTaskNotes(cislo, taskId)` — načíta komentáre z Caflou API pre danú úlohu, volá `refreshUlohy` po dokončení
- Posledná poznámka sa zobrazuje inline v riadku úlohy (skrátená); kliknutím sa rozbalia všetky
- Po uložení poznámky (`addTaskNote`) sa zoznam automaticky zavrie (`taskNotesOpen.delete(taskId)`)
- Komentáre sa filtrujú podľa `commented_id === taskId` — inak API vracia náhodné komentáre

**Hromadné úpravy (bulk bar):**
- Status, fáza, termín (`bulkSetDeadline`), Interné/Externé, Ukončiť, Vymazať, Dopyty
- `bulkSetDeadline(cislo, date)` — nastaví `end_time` na všetkých označených úlohách (formát `YYYY-MM-DDT17:00:00+02:00`)

**Functions:** `loadCaflouTasks`, `buildCaflouTasksHtml`, `setCaflouTaskStatus`, `finishCaflouTask`, `unfinishCaflouTask`, `toggleFinishedTasks`, `createCaflouTask`, `toggleTaskEdit`, `toggleTaskExtBtn`, `saveCaflouTaskEdit`, `deleteCaflouTask`, `loadSpecialists`, `filterSpecDropdown`, `preloadTaskNotes`, `buildTaskNotesHtml`, `toggleTaskNotes`, `addTaskNote`, `bulkSetDeadline`

### Zápisky (chronologický prehľad)

Tlačidlo **Zápisky** v headeri → `openChronoModal()` → `#chronoModal`.

- `buildChronoContent()` — zbiera záznamy z `dennikMap` (všetky projekty) + `taskNotesCache` (len lazy-loaded úlohy), zoradí podľa `created_at` desc, zobrazí posledných 50
- Záznamy z denníka: cislo sivé/malé, názov projektu tučný/tmavý; záznamy z úloh: názov úlohy
- `chronoAddDennik(cislo)` — pridá nový záznam do denníka priamo z modálu, volá `buildChronoContent()` bez zavretia modálu
- **Poznámka:** task notes sa zobrazia len ak boli v tejto session lazy-loaded (user otvoril projekt)

### Gemini integration

`geminiZhrnVsetky()` calls Apps Script (`cfg.url`) action `zhrniProjekt` for each visible project. Result stored in `geminiMap`. Ak sú pre projekt načítané úlohy v `caflouTasksCache`, zahrnie aj posledné 3 poznámky každej externej úlohy (rovnako ako `geminiZhrnProjekt`).

`geminiZhrnPortfolio()` — tlačidlo **Stav** v headeri. Zbiera posledné 3 denník záznamy zo všetkých nearcivovaných projektov + posledných 30 emailov zo SHEET_MAILY. Posiela do Apps Script `action: 'zhrniPortfolio'`. Výsledok zobrazí v `#portfolioModal`.

**Apps Script akcie** (`cfg.url`, `doPost` → if/else if, nie switch):
- `zhrniProjekt` — zhrnutie jedného projektu (cislo, nazov, faza, text)
- `getMaily` — maily pre jeden projekt (cislo) zo SHEET_MAILY → `{maily:[...]}`
- `getKontakty` — Google Contacts cez People API → `{contacts:[...]}`
- `zhrniPortfolio` — celkový stav portfólia (text = denníky aktívnych projektov so zápismi, 1 záznam/projekt)
- `extractMetadata` — nájde `TS_ASR.pdf` v Drive priečinku, skonvertuje cez Drive API v3 (multipart upload) na GDoc (OCR), prečíta text, Gemini extrahuje `{nazov, stavebnik, miesto, parcely, lv}` ako JSON
- `buildFolderTree` — rekurzívne prechádza Drive priečinok; vracia JSON strom `{name, files[], subfolders[]}`; v každom priečinku `TS_*.pdf` vždy prvý, výkresy zoradené numericky podľa prefixu
- `generateZoznam` — vygeneruje „A – Zoznam dokumentácie" ako GDoc (kópia `VZOR_ZOZNAM_ID` šablóny), zapíše do Drive priečinka projektu
- `generateSuhrn` — vygeneruje „B – Súhrnná správa" (kópia `VZOR_SUHRN_ID`), obsah generuje Gemini z textu tech správ
- `createDocInFolder(title, text, parentFolderId, templateId)` — `makeCopy()` šablóny → zapíše obsah s Arial štýlom

**Apps Script gotchas:**
- Gmail oprávnenia môžu expirovat — treba spustiť `sledujMaily` manuálne z editora aby sa zobrazil OAuth popup
- Po každej zmene kódu treba aktualizovať nasadenie (Deploy → Manage → nová verzia)
- Trigger `sledujMaily` — time-driven, každú hodinu; hľadá `newer_than:1d label:inbox`
- `oauthScopes` v `appsscript.json` musí obsahovať `https://mail.google.com/`, `drive` (`https://www.googleapis.com/auth/drive`) aj `documents` (`https://www.googleapis.com/auth/documents`) — inak `DriveApp`/`DocumentApp` hádzajú permissions error
- `doPost` **musí mať try-catch** okolo celého tela — inak nekachnutý exception vráti HTML bez CORS hlavičiek → prehliadač dostane "Failed to fetch"
- Gemini model: `gemini-2.5-flash` — `volajGemini` aj `analyzovatGemini` používajú tento model. `gemini-2.0-flash` a `gemini-2.0-flash-lite` majú `limit: 0` na free tier (nefungujú)
- **Gemini API key (nie OAuth)** — `volajGemini` aj `analyzovatGemini` volajú `generativelanguage.googleapis.com` s `?key=GEMINI_API_KEY`. OAuth/Vertex AI prístupy nefungujú bez GCP admin prístupu. Pri rate limitoch → AI Studio PAYG (aistudio.google.com → Billing → pay-as-you-go)
- `akcia_zhrniPortfolio` **nepoužíva SYSTEM_PROMPT** ani SHEET_MAILY — prompt by bol príliš dlhý (429). Používa vlastný krátky prompt, max 4000 znakov
- Frontend `geminiZhrnPortfolio` posiela len aktívne projekty **so zápismi**, 1 najnovší záznam/projekt, max 3000 znakov; fetch má AbortController timeout 60s
- `volajGemini` retry sleep: 5s (nie 30s) — rýchlejšie zlyhanie pri rate limite; po 3 pokusoch hodí zrozumiteľnú správu
- Apps Script kód záloha: `appscript/Code.gs` v repozitári (treba manuálne kopírovať do editora pri zmenách)
- **`fetch` do Apps Script nesmie mať `Content-Type: application/json` header** — spúšťa CORS preflight ktorý Apps Script nezvláda. `callScript()` v `suhrn.html` posiela fetch bez headers (telo je string JSON → Apps Script ho parsuje cez `JSON.parse(e.postData.contents)`)
- **PDF OCR cez Drive API v3**: multipart upload `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&convert=true` s `Authorization: Bearer ScriptApp.getOAuthToken()` → skonvertuje PDF na Google Doc → číta text cez `DocumentApp.openById()` → zmaže temp súbor
- **`makeCopy()` namiesto `DocumentApp.create()`** — zachováva fonty, okraje, rozloženie stránky zo šablóny. ID šablón: `VZOR_ZOZNAM_ID`, `VZOR_SUHRN_ID` (konštanty v Code.gs)

### Externý profesista → automatický dopyt → automatické priradenie

Pri vytváraní úlohy v dashboarde: dropdown obsahuje aj **"— externý profesista —"** (value=`ext`). Po výbere sa zobrazí pole Profesia. Pri odoslaní sa vytvorí Caflou úloha + automaticky INSERT do Supabase `requests` (projekt, profesia, názov úlohy v notes, **`caflou_task_id`**). Draft dopyt sa objaví v ponuky.html.

`createDopytFromTask` aj `bulkCreateDopyty` ukladajú `caflou_task_id` do requestu. Keď sa v ponuky.html vyberie víťaz (`selectWinner`), automaticky sa zapíše do `task_specialists` — v dashboarde sa profesista objaví priamo na úlohe pri nasledujúcom načítaní.

### Notifikačné badges

**Modrá bodka** — nový zápis v denníku (od posledného otvorenia projektu):
- `hasDennikBadge`: `dennikMap[p.cislo].some(e => new Date(e.created_at) > pmSeenAt[p.cislo])`
- Zmizne hneď pri `toggleProjDetail` — uloží `pmSeenAt[cislo] = now`, odstráni `.nbadge` z DOM

**Zelená bodka** — čaká cenová ponuka (`submitted` invitation):
- `hasPonukyBadge = ponukyBadgeSet.has(p.cislo)`
- Zmizne hneď pri `toggleProjDetail` — `ponukyBadgeSet.delete(cislo)`, odstráni `.nbadge` z DOM
- `ponukyBadgeSet` sa obnoví zo Supabase pri každom `syncData()` — ak ponuka stále čaká, bodka sa vráti po sync

**Badge `ponuka ↗` na úlohe** — `taskPonukySet.has(t.id)` → link `ponuky.html?task_id={t.id}` priamo na daný dopyt

**Inicializácia v `syncData()`:**
```javascript
const { data: submittedInvs } = await sb.from('invitations').select('request_id').eq('status','submitted');
const reqIds = [...new Set(submittedInvs.map(i => i.request_id))];
const { data: reqs } = await sb.from('requests').select('id,project_cislo,caflou_task_id').in('id', reqIds);
ponukyBadgeSet = new Set(reqs.map(r => r.project_cislo).filter(Boolean));
taskPonukySet  = new Set(reqs.map(r => r.caflou_task_id).filter(Boolean));
```
- `pmSeenAt` pre nové projekty sa inicializuje na `now()` — historické záznamy nevyvolajú badge

### Web Push notifikácie

**Súbory:**
- `sw.js` — service worker (push event → `showNotification`, notificationclick → focus/open tab)
- `supabase/functions/send-push/index.ts` — Deno edge function (`npm:web-push`)
- `supabase/push-setup.sql` — tabuľka `push_subscriptions (endpoint text unique, subscription jsonb)`
- `supabase/PUSH-SETUP.md` — inštrukcie na nasadenie (VAPID kľúče, edge function, DB webhooks)

**Flow:**
1. User klikne 🔔 → `registerPush()` → uloží subscription do `push_subscriptions` cez Supabase
2. DB webhook (Supabase Dashboard → Database → Webhooks) volá edge function `send-push`:
   - `invitations` UPDATE → status `submitted` (a predtým nebol) → push "Nová cenová ponuka"
   - `dennik` INSERT → push "Nový zápis v denníku"
3. Edge function fetchne všetky subscriptions, odošle push, zmaže expirované (HTTP 410)

**VAPID kľúče** uložené v Supabase Edge Function Secrets (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`). `SUPABASE_URL` a `SUPABASE_SERVICE_ROLE_KEY` sú nastavené automaticky.

**`registerPush()`** — v `index.html` aj `ponuky.html`; konštanta `VAPID_PUBLIC` + helper `urlBase64ToUint8Array()`; auto-init IIFE po načítaní stránky (tiché — bez promptu).

### Vyťaženie tímu

Dva tlačidlá v headeri:

**Ext tím** — `openVytazenieModal()`:
- Scanuje všetky Caflou úlohy (paginated), berie len úlohy v aktívnych projektoch
- Špecialist = `task_specialists[task_id]` alebo `extSpecOverride[task_id]`
- Skupiny podľa profesie (`specialistsList[spec.name].profession`, len prvá), abecedne; `—` na konci
- V rámci profesie: zoradené podľa počtu úloh zostupne
- Cache: `_vytazenieCache`, invalidovaný pri `syncData`

**Int tím** — `openIntTimModal()`:
- Scanuje rovnako, ale berie len úlohy **bez tagu `ext`** (interné)
- Člen tímu = `CAFLOU_USERS[t.target_user_id]`
- Zoradené podľa počtu úloh zostupne; nepriradené (`—`) na konci
- **Interaktívny modal** — mení status (`intTimSetStatus`) a ukončuje (`intTimFinishTask`) priamo v modáli bez zatvorenia
- Raw data v `_intTimData = {tasks, projects}`, HTML generuje `buildIntTimHtml(data)` pri každej zmene
- `_intTimData = null` v `syncData()` → vynutí refetch pri ďalšom otvorení

### Vyhľadávanie projektov

`searchQuery` — globálna premenná. Search input v `phase-bar`. Keď je neprázdny, `renderProjects()` zobrazí všetky zodpovedajúce projekty naprieč všetkými fázami s farebnými fáza badges. Plné project rows s detail divmi — projekt možno rozkliknúť priamo vo výsledkoch.

## Other files

### ponuky.html

Profession quotes management module. Accessible at `ponuky.html` (linked from `index.html` via `module-nav`).

**Supabase backend** (`cfjkomqxzqflotrqxfyl.supabase.co`):
- `requests` — quote requests (project, profession, phases, notes, `folder_url`, `folder_url_work`, `deadline` date, `podklady_datum` date, `hotovo_datum` date, `caflou_task_id` bigint)
  - `deadline` = "Termín odovzdania fázy" (kedy klient dostane PD)
  - `podklady_datum` = "Kedy dodáme podklady" (kedy firma odovzdá podklady profesistovi)
  - `hotovo_datum` = "Kedy chceme výsledok" (kedy profesista odovzdá výsledok)
- `specialists` — professionals (name, profession, email, phone, `portal_token` UUID, `reg` text)
- `invitations` — links request↔specialist, has `token` (UUID) and `status`: `sent|viewed|submitted|selected|rejected`
- `quotes` — submitted quotes (`prices` JSONB `{phase: amount}`, `notes`, `deadline` date, `submitted_at`)
- `employee_tasks` — team links per specialist: `(id uuid, specialist_id uuid unique, token uuid unique, order_data jsonb, created_at timestamptz)`

**Key patterns:**
- `_loading` guard prevents concurrent `loadAll()` calls
- `loadAll()` — single render pass, všetky 4 Supabase queries súčasne, `Promise.race` timeout 30s → zobrazí chybu s "Skúsiť znova"
- **Optimistic auth**: IIFE číta `sb-cfjkomqxzqflotrqxfyl-auth-token` z localStorage priamo (bez čakania na token refresh ktorý trvá ~20s). `_initialLoadDone` flag zabraňuje dvojitému `loadAll()` keď optimistic + `onAuthStateChange` oba nastanú.
- `loadCaflouProjects()` uses `d.results` (not `d.data`), filter `!p.trash && !p.template`
- `searchProjects()` uses `p.order_number` (not `p.number`)
- Save functions (`saveReq`, `saveSpec`) set `_loading = false` before calling `loadAll()`
- Toast notifications via `showToast(msg)`
- Caflou project search in request modal — dropdown appears after typing
- `openFromUrl()` — číta URL param `?task_id=`, nájde request podľa `caflou_task_id`, otvorí ho a scrollne naň (volané z task badge v index.html)

**Lazy render dopytov:**
- `renderRequests()` vkladá `buildReqDetail(r)` len pre otvorené riadky (nie pre všetky)
- `openReq(id)` — pridá triedu `on` + naplní innerHTML ak prázdny
- `toggleReq(id)` — toggle open/close
- `refreshReqDetail(reqId)` — prebuduje detail in-place z lokálneho stavu bez `loadAll()`; volá `openReq` na záver

**request modal fields:** project (Caflou search), profession, Caflou úloha (voliteľné — `#mRTaskWrap`), phases (checkboxes), notes, `folder_url`, `folder_url_work`

**Caflou úloha v modali nového dopytu:**
- `loadTasksForModal(cislo, selectedTaskId)` — načíta ext úlohy projektu z Caflou, naplní `#mRTaskSel` dropdown
- `selectProject(cislo, name)` volá `loadTasksForModal(cislo)` automaticky po výbere projektu
- `openReqModal(id)` pri editácii volá `loadTasksForModal(r.project_cislo, r.caflou_task_id)` → predvyberie aktuálnu úlohu
- `saveReq()` ukladá `caflou_task_id: parseInt(mRTaskSel.value) || null`

**Zoznam dopytov (`renderRequests`):**
- Zoskupené podľa projektu — každý projekt je `<details data-proj>` (otvorené pri prvom renderi, stav sa zachováva)
- V rámci projektu: sub-skupiny podľa profesijnej kategórie (`profCat`) — napr. všetky ZTI dopyty pod nadpisom "ZTI"; nadpis sa zobrazí len ak je viac kategórií
- V rámci kategórie: zoradené abecedne podľa profesie
- `profCat(p)` — extrahuje vedúcu veľkú skratku: `^([A-Z]{2,6})\b` (napr. ZTI, UK, STR); fallback: časť pred pomlčkou
- Open state dopytov (`.row-expand.on`) sa zachováva cez re-rendery

**Zoznam profesistov (`renderSpecialists`):**
- Zobrazuje len profesistov so zadanou profesiou (`s.profession`) — klienti a nezaradení sú skrytí
- `s.profession` môže obsahovať viacero štítkov oddelených čiarkou (napr. `"ZTI, technologie"`) — každý štítok = samostatná skupina; profesista s viacerými štítkami sa zobrazí vo viacerých skupinách
- Skupiny sú abecedne zoradené, každá je `<details>` (zatvorené by default, kliknutím sa rozbalí)
- V rámci skupiny: abecedne podľa mena
- Kontakty z Google (contacts pole) sa pre tento zoznam ignorujú — kontakty sa používajú len v invite modáli
- **Vyhľadávanie**: `#specSearch` input nad `#specList`; `renderSpecialists()` číta jeho hodnotu, filtruje podľa mena/profesie/emailu. Pri aktívnom vyhľadávaní → plochý abecedný zoznam (bez skupín, bez `<details>`)

**Sync kontaktov (`syncSpecProfessions`):**
- Fetchne kontakty z Google cez Apps Script `getKontakty`
- **Aktualizuje** profesiu u existujúcich špecialistov (match podľa emailu): `c.labels.join(', ')` → `s.profession`
- **Pridá** nových špecialistov z kontaktov, ktorí ešte nie sú v DB (match emailom) a majú aspoň jeden non-klient label
- Toast: `"aktualizovaných: N, pridaných: N"`

**Mazanie:** `deleteReq(e, id)` — kaskádovo zmaže quotes + invitations + request (s confirm). `deleteSpec(id)` — zmaže špecialistu.

**Uzatváranie/otváranie dopytov:** `closeReq(e, id)` → status `closed`. `reopenReq(e, id)` → status `active`. Tlačidlo sa prepína podľa aktuálneho stavu.

**Manuálne zadanie cien:** tlačidlo "✎ Ceny" v každom riadku tabuľky profesistov → `openCenyModal(invId, reqId)` → modal s inputmi pre každú fázu + poznámka → `saveCeny()` INSERT/UPDATE do `quotes`, status → `submitted`. Stav modalu v `_cenyInvId`, `_cenyReqId`.

**Správa ponúk:**
- `withdrawQuote(e, invId, reqId)` — stiahne ponuku: zmaže `quotes`, status → `sent`; local state + `refreshReqDetail`
- `selectWinner(e, invId, reqId)` — vyberie víťaza: selected/rejected + zapíše do `task_specialists`; **auto-uzavrie request** (status → `closed`); local state + `refreshReqDetail`
- `cancelWinner(e, invId, reqId)` — zruší výber: všetci selected/rejected → `submitted`, zmaže `task_specialists`; local state + `refreshReqDetail`
- `selectWinner` **nevytvára** Caflou úlohu (bolo odstránené — úloha sa vytvára pred dopytom)

**Team link (odkaz pre tím špecialistu):**
- `genTeamLink(e, specId)` — upsertne `employee_tasks` pre daného špecialistu (jeden link na špecialistu), skopíruje `portal.html?task=TOKEN` do schránky
- Tlačidlo **📋 Tím** sa zobrazí pri vybranom špecialistovi v tabuľke ponúk
- Jozef posiela link manuálne zamestnancom firmy

**Prepojenie dopytu s Caflou úlohou:**
- `openTaskLink(reqId, cislo)` — načíta Caflou projekty, nájde podľa order_number, načíta úlohy (ext prvé), zobrazí dropdown
- `saveTaskLink(reqId)` — uloží vybrané `caflou_task_id` do Supabase `requests`
- Pre ručne vytvorené dopyty (bez `caflou_task_id`) — tlačidlo "🔗 Pripojiť k úlohe" v detail dopytu

**Portál pre profesistov:**
- `specialists.portal_token` — permanentný UUID token pre každého profesista
- `generatePortalToken(specId)` — vygeneruje `crypto.randomUUID()`, uloží do Supabase, skopíruje link do schránky
- V záložke Profesisti: tlačidlo **🔗 Vytvoriť portál** (bez tokenu) alebo **🔗 Portál** (s tokenom, kliknutím skopíruje link)
- `getKontakty` Apps Script vracia len **osobné Google Kontakty** (`people/me/connections`) — nie firemný Workspace Directory

**Pozvanie profesistov (invite modal):**
- Zoznam kontaktov z Google Contacts je rozdelený do sekcií podľa tagov (`<details>` expandable)
- Sekcia zodpovedajúca profesii dopytu sa automaticky otvorí
- Selector pre vybrané checkboxy: `#mInvList input[data-email]:checked:not(:disabled)`
- Pri upserte do `specialists`: `profession = (c.labels||[])[0] || ''` — len prvý tag, nie join

**`specialists` tabuľka má stĺpec `reg`** (reg. číslo oprávnenia, napr. `1234 AA`). Zobrazuje sa v modali profesistov. `saveSpec()` ho ukladá spolu s ostatnými poliami.

### portal.html

Specialist-facing portal. Tri módy podľa URL parametra:

**Mód 1 — pozvánka:** `portal.html?token=UUID`
- `init()` → načíta invitation by token → `selected`/`rejected` → `renderStatus()`, inak `renderForm()`
- `_submitCtx` global holds `{invId, phases, curPhase}` to avoid JSON.stringify in onclick attribute
- `renderForm`: price table per phase, deadline fields, notes field
  - "Termín odovzdania PD klientovi" — read-only, z `req.deadline`
  - "Váš termín odovzdania" — editable, auto-vypočítaný ako `req.deadline - 7 dní`; ukladá sa do `quotes.deadline`
- `renderStatus`: shows reqBlock (folder links, notes) + quoteBlock (submitted prices, notes)
- Both folder links shown side by side: `folder_url` (nacenenie) + `folder_url_work` (vypracovanie)
- `selected` status: zobrazí aj `folder_url_work`, `podklady_datum`, `hotovo_datum`, `r.notes`

**Mód 2 — trhisko profesista:** `portal.html?specialist=UUID`
- `initSpecialistView()` — načíta špecialistu podľa `portal_token`, načíta aktívne dopyty, pozvánky, ceny
- Aj closed requesty pre selected/rejected invitations (`srReqs`) — deduplikované voči `reqs`
- `_specCtx = {spec, reqs, srReqs, invs, qts}` — stav trhiska
- `_profFilter = 'own'|'all'` — filter: len vlastná profesia / všetky
- `_openCards = new Set()` — ktoré req karty sú rozbalené (nahrádza `_quoteOpen` + `_resultOpen`)

**`renderSpecialistView()`:**
- Všetky requesty (active + closed) v jednej množine, filtrované podľa `_profFilter`
- Zoskupené podľa projektu → `<details>` **bez `open`** (zbalené pri načítaní)
- **Farba názvu projektu** podľa priority:
  - Zelená `#1a6b3c` — aspoň 1 `selected` invitation v projekte
  - Modrá `#1a4a8c` — aspoň 1 `submitted` invitation (bez selected)
  - Normálna — žiadna ponuka
- **Zoradenie**: zelené → modré → normálne; v rámci skupiny podľa `podklady_datum` asc (nulls last); earliest `podklady_datum` z req skupiny projektu
- V rámci projektu: sub-skupiny podľa `profCat` (15px bold); dopyt meno (13px, `var(--text2)`) + phase badges
- **Žiadna separátna sekcia "Výsledky dopytov"** — selected/rejected sa zobrazujú priamo v projekte

**`renderReqCard(r)`** — zvláda všetky stavy:
- `selected` alebo `rejected + qt` → result card (zelený/sivý border-left, ✅/ℹ️, rozbaľovateľné ceny + info)
- ostatné → form card (zadanie cien, termín, poznámka, submit button)
- `toggleCard(reqId)` — toggle `_openCards` Set, re-render (nahrádza `toggleReqCard` + `toggleResultCard`)
- `submitSpecQuote(reqId)` — ak invitation neexistuje, vytvorí ju; upsertuje quote; `_openCards.delete(reqId)`; re-render
- `profCat(p)` — rovnaká logika ako v ponuky.html
- **Zachovanie open stavu projektov**: pred `innerHTML =` sa uloží `openProjs = Set` z `details[data-proj][open]`; po renderi sa obnoví cez `d.open = true`. Každý `<details>` má `data-proj="${cislo || name}"`. Bez toho by kliknutie na dopyt zbalilo projekt.

**Mód 3 — zadanie pre tím:** `portal.html?task=UUID`
- `initEmployeeView()` — nastaví `document.title = 'Zadanie pre tím'`; načíta `employee_tasks` podľa tokenu → špecialistu → všetky `selected` invitations → requests
- `_empCtx = {et, spec, invs, reqs}` — stav employee view
- `renderEmployeeView()`:
  - Projekty zoskupené podľa `project_cislo`, zoradené podľa `deadline` (najbližší termín = č.1)
  - Každý projekt je `<details data-pid>` — klik rozbalí jednotlivé úlohy (profesia, fázy, podklady, termíny, poznámky)
  - **Bez cien** — žiadne finančné dáta
  - Open state sa zachováva cez re-rendery (číta `details[data-pid][open]` pred re-renderom)

**`employee_tasks` Supabase tabuľka:**
```sql
create table employee_tasks (
  id uuid primary key default gen_random_uuid(),
  specialist_id uuid references specialists(id) on delete cascade unique,
  token uuid unique default gen_random_uuid(),
  order_data jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);
```
- Jeden záznam na špecialistu (unique constraint)
- `order_data` — rezervované, momentálne sa nepoužíva (poradie projektov je podľa deadline)

### sync-fazy.ps1

PowerShell script that reads projects from Caflou and creates `.lnk` shortcuts in `H:\Spoločné disky\1_PROJEKTY\_Fazy\` grouped by phase. Run after any phase change in Caflou. Uses wildcard path `H:\Spo*disky\...` to avoid PowerShell 5.1 diacritics encoding issues.

Shortcut on desktop: `Sync Fazy.lnk` (runs with `-NoExit -ExecutionPolicy Bypass`).

Project folders are named `2024-021-NazovProjektu` (4-digit year), Caflou uses `24-021` (2-digit) — the script handles this conversion.

### suhrn.html

Generátor správ — vytvára dva stavebné dokumenty cez Google Apps Script + Gemini:
- **A – Zoznam dokumentácie**: zoznam PDF súborov z Drive priečinka, zoskupené podľa profesie, tech správa (`TS_*.pdf`) vždy prvá, výkresy numericky zoradené
- **B – Súhrnná správa**: 9-kapitolový dokument generovaný Gemini z obsahu tech správ

Dostupný z `index.html` tlačidlom `📄 A,B` na každom projekte (otvára sa v novom tabe).

**URL parametre (z index.html A,B tlačidla):**
```
suhrn.html?cislo=26-014&nazov=NazovProjektu&faza=Projekcia&podfaza=Projekt+stavby
           &caflouid=12345&taskids=111,222,333
```
- `cislo` → `projectKey` (Caflou `order_number`) — kľúč pre Supabase
- `caflouid` — Caflou numerické ID projektu (`p.caflou_id` = `p.id` z Caflou API, nastavené v `parseCaflouProject`)
- `taskids` — záložné task IDs; primárne sa taskIds fetchujú priamo z Caflou (`/projects/{caflouid}`)

**Kľúčové globálne premenné:**
```javascript
let projectKey = '';     // Caflou order_number – kľúč pre Supabase (suhrn_folder)
let projectTaskIds = []; // záložné task IDs z URL
```

**Postup (4 kroky v UI):**
1. **Identifikačné údaje** — vyhľadanie projektu v Caflou (alebo prefill z URL), stupeň, číslo stavby, názov, stavebník, miesto, parcely, LV, dátum, náklady, charakter. Tlačidlo **Načítať z TS_ASR** → Apps Script `extractMetadata` → Gemini prečíta tech správu ASR a vyplní polia automaticky
2. **Zodpovední projektanti** — tabuľka (rola, meno/adresa, reg. číslo). Tlačidlo **Načítať z projektu** → `loadProjektantiFromProject()` → ak sú `taskids` v URL, ide cez `loadProjektantiFromTaskIds` (Supabase only); inak `loadProjektantiFromCaflou` (vyžaduje Caflou API)
3. **Projektový priečinok na Drive** — URL priečinka stupňa (napr. `DSP/`). Ukladá sa do Supabase `suhrn_folder` podľa `projectKey`. Načíta sa automaticky pri otvorení projektu
4. **Generovať** — tlačidlá A a B → Apps Script `generateZoznam` / `generateSuhrn`

**Caflou API v `suhrn.html`** — musí používať `Authorization: Bearer` header (nie `api-key` — Caflou blokuje `api-key` cez CORS preflight).

**`loadProjektantiFromProject(silent)`:**
- Ak URL obsahuje `taskids` → `loadProjektantiFromTaskIds(taskIds)` — pýta sa len Supabase, bez Caflou
- Inak → `loadProjektantiFromCaflou(silent)` — potrebuje Caflou API

**`loadProjektantiFromTaskIds(taskIds)`** — Supabase only, žiadny fallback na Caflou

**`loadProjektantiFromCaflou(silent)`:**
1. Fetchne projekt z Caflou (`/projects/{caflouid}`) → task_ids
2. Fetchne `task_specialists` zo Supabase pre tieto task_ids
3. Fetchne všetky Caflou úlohy (paginated), filtruje ext + patriace projektu
4. Fetchne `specialists` zo Supabase podľa specialist_id → dostane meno, profesiu, reg
5. Priorita mena špecialistu: `task_specialists` → `extSpecOverride` (localStorage)
6. Deduplikuje podľa `meno+profesia`, vynechá riadky bez mena

**Supabase tabuľky (suhrn.html):**
- `suhrn_folder (id uuid, cislo text unique, folder_url text, updated_at timestamptz)` — URL priečinka per projekt (`projectKey`)
- `suhrn_projektanti (id uuid, cislo text unique, data jsonb)` — uložený zoznam projektantov (tlačidlo 💾)

**`callScript(action, payload)`** — volá Apps Script bez `Content-Type` header (inak CORS preflight zlyhá). Payload je `{action, ...payload}`, serializovaný ako string v body.

**Tech správy — konvencia názvov:** `TS_<SKRATKA>.pdf` (napr. `TS_ASR.pdf`, `TS_STR.pdf`). Detekuje `isTechReport(name)`: `name.toUpperCase().startsWith('TS_')`.

**Nav:** `<a href="suhrn.html" class="mnav-a">Správy</a>` — v `index.html` aj `ponuky.html`.

**Nedokončené / TODO:**
- Otestovať kompletný flow generovania A+B po nasadení novej verzie Apps Script s `extractMetadata` + `generateZoznam` + `generateSuhrn`
- Overiť `loadProjektantiFromTaskIds` — závisí od `task_specialists` v Supabase; ak projekt nemá priradených profesistov cez ponuky.html, tabuľka bude prázdna a funkcia zobrazí "Nenašli sa priradení profesisti"
- GitHub Pages CDN: po push počkať 2-5 min + Ctrl+Shift+R; ak stále stará verzia → F12 → Application → Clear site data

### caflou.env (gitignored)

Contains `CAFLOU_API_KEY` and `CAFLOU_ACCOUNT_ID`. Never commit this file.

---

## ROZPRACOVANÉ: Caflou výdavok pri schválení ponuky

**Cieľ:** Pri `selectWinner` v `ponuky.html` automaticky:
1. Priradiť vybraného profesionista k externej úlohe v Caflou (už funguje cez `task_specialists`)
2. Vytvoriť výdavok (náklad) v Caflou napojený na danú úlohu a dodávateľa (= externistu)

**Plán implementácie (4 kroky):**

**Krok 1 — Zistiť Caflou API endpoint pre výdavky (BLOKUJE OSTATNÉ)**
- Treba zachytiť network request (F12 → Network) pri manuálnom vytvorení výdavku v Caflou
- Hľadať `POST` na `/costs`, `/expenses`, `/project-costs` alebo podobné
- Zaznamenať: URL endpoint, štruktúru payloadu (project_id, task_id, amount, company_id, ...)
- Caflou firmy/dodávatelia = existujúce záznamy; treba zistiť aj endpoint pre ich zoznam (napr. `/contacts`, `/companies`)

**Krok 2 — Sparovanie externistu s Caflou firmou**
- Pridať stĺpec `caflou_company_id` (bigint, nullable) do `specialists` tabuľky v Supabase
- V záložke Profesisti v `ponuky.html` pridať pole na nastavenie Caflou firmy (raz ručne per profesionist)
- Dropdown načítaný z Caflou kontaktov/firiem API; ak API neexistuje → manuálne zadanie ID

**Krok 3 — Suma výdavku**
- Zdroj: `quotes.prices` (JSONB `{faza: suma}`) pre vybraného špecialistu
- Jedna ponuka = jeden stupeň = jedna suma → zobrať hodnotu z `prices` (súčet ak viac fáz)

**Krok 4 — Implementácia v `selectWinner`**
- Po existujúcej logike (selected/rejected + task_specialists zápis) zavolať novú funkciu
- `createCaflouExpense(taskId, projectCaflouId, companyId, amount, description)`
- Fire-and-forget s `.then(null, () => {})` (rovnaký vzor ako ostatné Supabase/Caflou calls)

**Stav:** Čaká na Krok 1 (network inspect od Jozefa)
