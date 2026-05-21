# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Single-file (`index.html`) project management dashboard for an architecture firm. No build system, no framework — vanilla HTML/CSS/JS deployed via GitHub Pages.

Live URL: `https://jozefperichta-ctrl.github.io/prehladpm/`

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

### Data flow – Caflou

- `syncData()` fetches all projects from `https://app.caflou.com/api/v1/{caflou_id}/projects` (paginated, per=100). Caflou supports CORS (`*`) so calls are made directly from the browser.
- `parseCaflouProject(p)` maps each Caflou project using `CAFLOU_STATUS_MAP` (status→fáza/podfáza) and `CAFLOU_TYPE_PODFAZA` (type overrides podfáza).
- `saveProjCaflouStatus()` PATCHes `project_status_id` back to Caflou when fáza changes in the dashboard.
- `caflouAddComment()` writes denník entries to Caflou as project comments (`POST /comments`) as backup.
- Credentials stored in `caflou.env` (gitignored) and in localStorage. If no credentials, `loadDemo()` loads hardcoded sample data.

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

**Functions:** `loadCaflouTasks`, `buildCaflouTasksHtml`, `setCaflouTaskStatus`, `finishCaflouTask`, `createCaflouTask`, `toggleTaskEdit`, `toggleTaskExtBtn`, `saveCaflouTaskEdit`, `deleteCaflouTask`, `loadSpecialists`, `filterSpecDropdown`, `preloadTaskNotes`, `buildTaskNotesHtml`, `toggleTaskNotes`, `addTaskNote`, `bulkSetDeadline`

### Gemini integration

`geminiZhrnVsetky()` calls Apps Script (`cfg.url`) action `zhrniProjekt` for each visible project. Result stored in `geminiMap`. Ak sú pre projekt načítané úlohy v `caflouTasksCache`, zahrnie aj posledné 3 poznámky každej externej úlohy (rovnako ako `geminiZhrnProjekt`).

`geminiZhrnPortfolio()` — tlačidlo **Stav** v headeri. Zbiera posledné 3 denník záznamy zo všetkých nearcivovaných projektov + posledných 30 emailov zo SHEET_MAILY. Posiela do Apps Script `action: 'zhrniPortfolio'`. Výsledok zobrazí v `#portfolioModal`.

**Apps Script akcie** (`cfg.url`, `doPost` → if/else if, nie switch):
- `zhrniProjekt` — zhrnutie jedného projektu (cislo, nazov, faza, text)
- `navrhniUlohy` — navrhne úlohy z denník záznamu (text) → `{ulohy:[{profesia,popis}]}`
- `getMaily` — maily pre jeden projekt (cislo) zo SHEET_MAILY → `{maily:[...]}`
- `getKontakty` — Google Contacts cez People API → `{contacts:[...]}`
- `zhrniPortfolio` — celkový stav portfólia (text = denníky aktívnych projektov so zápismi, 1 záznam/projekt)

**Apps Script gotchas:**
- Gmail oprávnenia môžu expirovat — treba spustiť `sledujMaily` manuálne z editora aby sa zobrazil OAuth popup
- Po každej zmene kódu treba aktualizovať nasadenie (Deploy → Manage → nová verzia)
- Trigger `sledujMaily` — time-driven, každú hodinu; hľadá `newer_than:1d label:inbox`
- `oauthScopes` v `appsscript.json` musí obsahovať `https://mail.google.com/`
- `doPost` **musí mať try-catch** okolo celého tela — inak nekachnutý exception vráti HTML bez CORS hlavičiek → prehliadač dostane "Failed to fetch"
- Gemini model: `gemini-2.5-flash` — `volajGemini` aj `analyzovatGemini` používajú tento model. `gemini-2.0-flash` a `gemini-2.0-flash-lite` majú `limit: 0` na free tier (nefungujú)
- `akcia_zhrniPortfolio` **nepoužíva SYSTEM_PROMPT** ani SHEET_MAILY — prompt by bol príliš dlhý (429). Používa vlastný krátky prompt, max 4000 znakov
- Frontend `geminiZhrnPortfolio` posiela len aktívne projekty **so zápismi**, 1 najnovší záznam/projekt, max 3000 znakov; fetch má AbortController timeout 60s
- `volajGemini` retry sleep: 5s (nie 30s) — rýchlejšie zlyhanie pri rate limite; po 3 pokusoch hodí zrozumiteľnú správu
- Apps Script kód záloha: `appscript/Code.gs` v repozitári (treba manuálne kopírovať do editora pri zmenách)

### Externý profesista → automatický dopyt → automatické priradenie

Pri vytváraní úlohy v dashboarde: dropdown obsahuje aj **"— externý profesista —"** (value=`ext`). Po výbere sa zobrazí pole Profesia. Pri odoslaní sa vytvorí Caflou úloha + automaticky INSERT do Supabase `requests` (projekt, profesia, názov úlohy v notes, **`caflou_task_id`**). Draft dopyt sa objaví v ponuky.html.

`createDopytFromTask` aj `bulkCreateDopyty` ukladajú `caflou_task_id` do requestu. Keď sa v ponuky.html vyberie víťaz (`selectWinner`), automaticky sa zapíše do `task_specialists` — v dashboarde sa profesista objaví priamo na úlohe pri nasledujúcom načítaní.

### Vyhľadávanie projektov

`searchQuery` — globálna premenná. Search input v `phase-bar`. Keď je neprázdny, `renderProjects()` zobrazí všetky zodpovedajúce projekty naprieč všetkými fázami s farebnými fáza badges. Plné project rows s detail divmi — projekt možno rozkliknúť priamo vo výsledkoch.

## Other files

### ponuky.html

Profession quotes management module. Accessible at `ponuky.html` (linked from `index.html` via `module-nav`).

**Supabase backend** (`cfjkomqxzqflotrqxfyl.supabase.co`):
- `requests` — quote requests (project, profession, phases, notes, `folder_url`, `folder_url_work`, `deadline` date, `caflou_task_id` bigint)
- `specialists` — professionals (name, profession, email, phone, `portal_token` UUID)
- `invitations` — links request↔specialist, has `token` (UUID) and `status`: `sent|viewed|submitted|selected|rejected`
- `quotes` — submitted quotes (`prices` JSONB `{phase: amount}`, `notes`, `submitted_at`)

**Key patterns:**
- `_loading` guard prevents concurrent `loadAll()` calls
- `loadAll()` has 30s timeout — shows error with "Skúsiť znova" button instead of infinite spinner
- `loadCaflouProjects()` uses `d.results` (not `d.data`), filter `!p.trash && !p.template`
- `searchProjects()` uses `p.order_number` (not `p.number`)
- Save functions (`saveReq`, `saveSpec`) set `_loading = false` before calling `loadAll()`
- Toast notifications via `showToast(msg)`
- Caflou project search in request modal — dropdown appears after typing

**request modal fields:** project (Caflou search), profession, phases (checkboxes), notes, `folder_url` (Podklady na nacenenie), `folder_url_work` (Podklady na vypracovanie)

**Mazanie:** `deleteReq(e, id)` — kaskádovo zmaže quotes + invitations + request (s confirm). `deleteSpec(id)` — zmaže špecialistu.

**Uzatváranie/otváranie dopytov:** `closeReq(e, id)` → status `closed`. `reopenReq(e, id)` → status `active`. Tlačidlo sa prepína podľa aktuálneho stavu.

**Manuálne zadanie cien:** tlačidlo "✎ Ceny" v každom riadku tabuľky profesistov → `openCenyModal(invId, reqId)` → modal s inputmi pre každú fázu + poznámka → `saveCeny()` INSERT/UPDATE do `quotes`, status → `submitted`. Stav modalu v `_cenyInvId`, `_cenyReqId`.

**Správa ponúk:**
- `withdrawQuote(e, invId, reqId)` — stiahne ponuku: zmaže `quotes`, status → `sent`
- `selectWinner(e, invId, reqId)` — vyberie víťaza: selected/rejected + zapíše do `task_specialists` ak request má `caflou_task_id`
- `cancelWinner(e, invId, reqId)` — zruší výber: všetci selected/rejected → `submitted`, zmaže `task_specialists` záznam
- `selectWinner` **nevytvára** Caflou úlohu (bolo odstránené — úloha sa vytvára pred dopytom)

**Portál pre profesistov:**
- `specialists.portal_token` — permanentný UUID token pre každého profesista
- `generatePortalToken(specId)` — vygeneruje `crypto.randomUUID()`, uloží do Supabase, skopíruje link do schránky
- V záložke Profesisti: tlačidlo **🔗 Vytvoriť portál** (bez tokenu) alebo **🔗 Portál** (s tokenom, kliknutím skopíruje link)
- `getKontakty` Apps Script vracia len **osobné Google Kontakty** (`people/me/connections`) — nie firemný Workspace Directory

**Pozvanie profesistov (invite modal):**
- Zoznam kontaktov z Google Contacts je rozdelený do sekcií podľa tagov (`<details>` expandable)
- Sekcia zodpovedajúca profesii dopytu sa automaticky otvorí
- `renderInviteList` funkcia bola odstránená — sekcie sú renderované priamo v `openInviteModal`
- Selector pre vybrané checkboxy: `#mInvList input[data-email]:checked:not(:disabled)`
- Pri upserte do `specialists`: `profession = (c.labels||[])[0] || ''` — len prvý tag, nie join

**Aktivita sa nezobrazuje v riadku projektu** — je redundantná so stavovým filtrom. `projRowHtml` zobrazuje len Gemini zhrnutie (`gem`), nie `stavMap[p.cislo]`.

### portal.html

Specialist-facing form. Dva módy podľa URL parametra:

**Mód 1 — pozvánka:** `portal.html?token=UUID`
- `init()` → načíta invitation by token → `selected`/`rejected` → `renderStatus()`, inak `renderForm()`
- `_submitCtx` global holds `{invId, phases, curPhase}` to avoid JSON.stringify in onclick attribute
- `renderForm`: price table per phase, notes field
- `renderStatus`: shows reqBlock (folder links, notes) + quoteBlock (submitted prices, notes)
- Both folder links shown side by side: `folder_url` (nacenenie) + `folder_url_work` (vypracovanie)

**Mód 2 — trhisko profesista:** `portal.html?specialist=UUID`
- `initSpecialistView()` — načíta špecialistu podľa `portal_token`, načíta aktívne dopyty, pozvánky, ceny
- `_specCtx = {spec, reqs, invs, qts}` — stav trhiska
- `_profFilter = 'own'|'all'` — filter: len vlastná profesia / všetky
- `renderSpecialistView()` — zobrazí filter bar + karty dopytov
- `renderReqCard(r)` — karta dopytu s formulárom pre zadanie cien
- `submitSpecQuote(reqId)` — ak invitation neexistuje, vytvorí ju; upsertuje quote; re-render
- Profesista vidí termíny (`deadline`) a môže sa rozhodnúť čo stíha

### sync-fazy.ps1

PowerShell script that reads projects from Caflou and creates `.lnk` shortcuts in `H:\Spoločné disky\1_PROJEKTY\_Fazy\` grouped by phase. Run after any phase change in Caflou. Uses wildcard path `H:\Spo*disky\...` to avoid PowerShell 5.1 diacritics encoding issues.

Shortcut on desktop: `Sync Fazy.lnk` (runs with `-NoExit -ExecutionPolicy Bypass`).

Project folders are named `2024-021-NazovProjektu` (4-digit year), Caflou uses `24-021` (2-digit) — the script handles this conversion.

### caflou.env (gitignored)

Contains `CAFLOU_API_KEY` and `CAFLOU_ACCOUNT_ID`. Never commit this file.
