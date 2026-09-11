# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Single-file (`index.html`) project management dashboard for an architecture firm. No build system, no framework — vanilla HTML/CSS/JS deployed via GitHub Pages.

Live URL: `https://architt-ctrl.github.io/prehladpm/`

To deploy changes: `git add index.html && git commit -m "..." && git push origin main`, then hard-refresh the browser (Ctrl+Shift+R).

**Pages deploy občas zlyháva (2026-07-03: 5× za deň):** krok „Deploy to GitHub Pages" padá bez udanej príčiny aj keď build prejde (githubstatus.com hlási všetko OK — pravdepodobne tichý limit/flakiness). Kontrola: `curl -s "https://api.github.com/repos/architt-ctrl/prehladpm/actions/runs?per_page=5"` (verejné API, netreba auth). **Ak po zlyhanom builde nenasleduje úspešný, zmena NIE JE na webe** — retrigger: `git commit --allow-empty -m "Retrigger Pages deploy" && git push`. Overenie nasadenia: `curl` živej URL s `?v=timestamp` a grep na novú zmenu. Git na tomto počítači potreboval nastaviť identitu lokálne (`git config user.name/user.email` podľa predchádzajúcich komitov — jozefperichta-ctrl / jozef.perichta@architt.sk); `git gc` na sieťovom disku I: presahuje 2-min timeout, používať `git -c gc.auto=0`.

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
| `dennikMap` | `pmDennik` | `{cislo: [{id, datum, text, created_at, done, today, parent_id}]}` — primary storage is Supabase `dennik` table; also written to Caflou comments as backup (top-level entries only, replies are Supabase-only) |
| `dennikThreadOpen` | — | `Set<dennik.id>` — ktoré zápisy majú rozbalené celé podvlákno odpovedí (inak sa vždy zobrazujú len posledné 3) |
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
| `taskEmailCache` | — | `{task_id: thread_url}` — oficiálne mailové vlákno priradené k externej úlohe (Supabase `task_email_threads`); cleared on `syncData` |

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

- `dennik` table: `(id uuid, cislo text, datum text, text text, created_at timestamptz, done boolean, today boolean, parent_id uuid references dennik(id) on delete cascade)`
- RLS enabled with open policy (`using (true) with check (true)`)
- `syncData()` fetches all denník rows ordered by `created_at desc` → builds `dennikMap`
- `pridajDennik()` inserts new row to Supabase + updates localStorage + writes to Caflou
- Display: `buildDennikListHtml(cislo)` shows 3 newest **top-level** entries (`parent_id IS NULL`); older ones hidden behind "Zobraziť staršie" toggle
- **Vybavené (`done`, 2026-07-29):** checkbox ☐/☑ pri každom zázname (detail projektu aj Zápisky) — `toggleDennikDone(cislo, id)` prekreslí lokálne a PATCHuje `done` do Supabase (fire-and-forget). Preškrtnutý + stlmený text keď `done=true`. SQL: `supabase/dennik-done-setup.sql`
- **Vybaviť ešte dnes (`today`, 2026-07-29):** pin ikona 📌 pri zázname (len Zápisky) — `toggleDennikToday`. Označené nedokončené (`today && !done`) záznamy sa zobrazia v samostatnej sekcii "🔥 Vybaviť ešte dnes" nad chronologickým zoznamom v `#chronoModal`. SQL: `supabase/dennik-today-setup.sql`
- **Podvlákno odpovedí (`parent_id`, 2026-07-29):** odpoveď je bežný `dennik` riadok s vyplneným `parent_id` (jedna úroveň, odpovede na odpovede nie sú podporované). Klik na text zápisu (nie samostatné tlačidlo) → `toggleDennikThread(cislo, id)` rozbalí/zbalí celé podvlákno + pole na pridanie ďalšej (`addDennikReply`). Keď je zbalené, posledné 3 odpovede (`dennikRepliesFor().slice(-3)`) sa zobrazujú vždy, bez klikania (`buildDennikThreadPreviewHtml`). Odpovede sa nezrkadlia do Caflou komentárov (len top-level zápisy) a nezobrazujú sa ako samostatné riadky v hlavnom chronologickom zozname Zápiskov. SQL: `supabase/dennik-thread-setup.sql`
- **Gotcha — poradie migrácie vs. testovania:** pri každom novom boolean/stĺpec flagu (`done`, `today`, `parent_id`) treba spustiť SQL migráciu **predtým**, než sa flag začne používať v UI — `syncData()` vždy prepíše `dennikMap` čerstvými dátami zo Supabase (`dennikMap = newDennik`), takže akékoľvek predčasné prepnutie sa uloží len lokálne (Supabase update potichu zlyhá, stĺpec neexistuje) a zmizne pri najbližšom obnovení stránky
- **Caflou comments API** cannot be used for reading history — filters are ignored server-side, returns 20 items/page across 1000+ pages of bot activity. Supabase is the only reliable cross-device store.
- One-time history recovery: `recover-dennik.ps1` (in repo) scans all Caflou comment pages and imports `kind=human, commented_type=Project` entries to Supabase.
- **Priebežná synchronizácia (2026-07-03):** `pridajDennik`/`recover-dennik.ps1` riešia len dashboard→Supabase a jednorazovú historickú obnovu — **kolegove komentáre napísané priamo v Caflou sa predtým do denníka ani do push notifikácií vôbec nedostali** (žiadny live sync neexistoval, nešlo o regresiu). Doplnené: Apps Script `sledujKomentare` (`appscript/Code.gs`) — time-driven trigger, sleduje globálny `GET /api/v1/{account}/comments` (zoradený od najnovšieho), zastaví sa pri už videnom ID (kurzor v `PropertiesService`), filtruje `kind='human' && commented_type='Project' && user_id !== CAFLOU_OWN_USER_ID` (vylúčenie komentárov, ktoré do Caflou zapísal sám dashboard cez `caflouAddComment` — inak by vznikli duplicity) a zapíše nájdené do Supabase `dennik` cez REST (anon key, rovnaká RLS ako pri ostatných dennik zápisoch — funguje aj mimo prihlásenej session, na rozdiel od `specialists`). Zápis do `dennik` automaticky spustí existujúci push webhook, žiadna extra logika netreba.
  - Prvý beh trigeru len inicializuje kurzor (nezáplavuje denník starými záznamami — tie už doniesol `recover-dennik.ps1`)
  - `maxPages = 15` (per=100) bezpečnostný strop na beh — pri vysokom objeme "bot" aktivity (automatické systémové komentáre pri každej zmene statusu/výdavku/úlohy) môže byť treba zvýšiť alebo skrátiť interval triggeru, inak sa časť starších komentárov medzi behmi preskočí
  - **Vyžaduje nastavenie triggeru ručne** v Apps Script editore (Triggers → Add Trigger → `sledujKomentare` → Time-driven), rovnako ako `sledujMaily`
  - **Vyžaduje doplniť `CAFLOU_ACCOUNT_ID`** v `Code.gs` (zatiaľ placeholder `YOUR_CAFLOU_ACCOUNT_ID`) priamo v Apps Script editore — reálna hodnota je v `caflou.env` (gitignored), do repo zálohy sa **nekomituje** (rovnako ako `CAFLOU_API_KEY`/`GEMINI_API_KEY` — repo je verejné cez GitHub Pages)
  - Predpoklad `CAFLOU_OWN_USER_ID = 50310` (Caflou user, pod ktorým beží API kľúč) — overené pri testovaní Caflou výdavkov (transfer vytvorený cez API mal `user_id: 50310`); ak by sa objavili duplicitné záznamy v denníku, over toto ID
  - **Gotcha (2026-07-06):** Apps Script editor sa ľahko rozíde s repo zálohou (`ReferenceError: CAFLOU_ACCOUNT_ID is not defined`, potom `ReferenceError: CAFLOU_OWN_USER_ID is not defined` — editor mal starší kód bez týchto premenných). Pri akejkoľvek nezhode je najspoľahlivejšie **nahradiť celý obsah editora** aktuálnym `appscript/Code.gs` (Ctrl+A → paste), nie dopĺňať jednotlivé riadky. Pre time-driven trigger funkcie **netreba nové Deploy** po uložení — beží vždy z aktuálne uloženého kódu; Deploy je nutný len pri zmene web-app endpointu (`doPost`, ktorý volajú `index.html`/`ponuky.html`/`suhrn.html`).

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

**Poznámky k externým úlohám (task notes, prepísané na Supabase 2026-08-12):**
- Primárne úložisko je Supabase `task_notes (id uuid, task_id bigint, cislo text, text text, created_at timestamptz)` — SQL: `supabase/task-notes-setup.sql`
- **Dôvod prepisu z Caflou comments API:** `GET /comments?commented_type=Task&commented_id=...` ignoruje filter server-side (overené priamym testom — dve rôzne `commented_id` hodnoty vrátili identické výsledky), rovnaký problém ako pri denníku projektov. Keďže sa fetchovala len 1. stránka (`per=100`), poznámka sa reálne stratila pod bot-komentármi (každá zmena statusu/výdavku/úlohy generuje jeden) hneď ako pribudlo dosť aktivity na účte — bola viditeľná hneď po pridaní (lokálny `unshift`), ale zmizla po opätovnom otvorení/reloade (nový fetch ju medzi bot-komentármi nenašiel)
- `taskNotesCache = {taskId: [{id,datum,text,created_at}]}` — `undefined` = nenačítané, `null` = načítava sa, `[]` = prázdne. Bulk-loadované v `loadCaflouTasks` (rovnaké miesto ako `task_email_threads`) — `sb.from('task_notes').select(...).in('task_id', taskIds)` pre všetky úlohy projektu naraz, žiadny per-task lazy fetch
- `preloadTaskNotes(cislo, taskId)` — fallback pre jednotlivú úlohu (Supabase `eq('task_id', taskId)`), použije sa len ak bulk-load cache pre daný task nepokryl (cache je `undefined`)
- `taskNotesOpen = new Set()` — ktoré úlohy majú rozbalený zoznam poznámok
- Posledná poznámka sa zobrazuje inline v riadku úlohy (skrátená); kliknutím sa rozbalia všetky
- `addTaskNote` — INSERT do Supabase (primárne), po úspechu **write-through backup** do Caflou comments (`caflou_task_id`, `.then(null, () => {})` fire-and-forget — Supabase fire-and-forget gotcha platí rovnako ako inde v repo). Po uložení sa zoznam automaticky zavrie (`taskNotesOpen.delete(taskId)`)
- `taskNotesCache` sa čistí pri `syncData()` (rovnako ako `taskEmailCache`) — nové dáta sa dotiahnu pri ďalšom `loadCaflouTasks`
- **Gotcha:** SQL migrácia (`task-notes-setup.sql`) musí bežať v Supabase **pred** používaním — inak insert zlyhá ticho (fire-and-forget backup zamaskuje chybu, ale primárny insert cez `addTaskNote` hodí toast s chybou, keďže tam je try/catch so `showToast`)
- **Vyriešené (2026-08-25):** živá tabuľka v Supabase sa rozišla od `task-notes-setup.sql` v repe — chýbal stĺpec `cislo` (insert hádzal `Could not find the 'cislo' column of 'task_notes' in the schema cache`) a naopak existoval nepoužívaný stĺpec `datum` (text, `not null` bez defaultu — z nejakej staršej verzie, appka dátum vždy počíta z `created_at` v JS, tento stĺpec sa nikde nečíta/nezapisuje) — po doplnení `cislo` insert padal na `datum` not-null constraint. Oprava priamo v Supabase SQL Editore (v kóde sa nič nemenilo): `alter table task_notes add column if not exists cislo text; alter table task_notes alter column datum drop not null; notify pgrst, 'reload schema';`. Ak sa podobný "column not found" objaví aj pri iných tabuľkách, over najprv reálnu schému (`select column_name, data_type from information_schema.columns where table_name = '...'`) namiesto predpokladu, že zodpovedá `.sql` súboru v repe — SQL súbory v repe sú len zámer/záloha, nie záruka toho, čo reálne beží.
- Poznámky napísané pred týmto prepisom (cez starý Caflou-comments flow) sa **nezobrazia** — v Supabase nie sú, historická obnova (analogická `recover-dennik.ps1`) zatiaľ nebola spravená

**Hromadné úpravy (bulk bar):**
- Status, fáza, termín (`bulkSetDeadline`), Interné/Externé, Ukončiť, Vymazať, Dopyty
- `bulkSetDeadline(cislo, date)` — nastaví `end_time` na všetkých označených úlohách (formát `YYYY-MM-DDT17:00:00+02:00`)

**Oficiálne mailové vlákno k externej úlohe (2026-07-29):**
- Supabase `task_email_threads (task_id bigint primary key, thread_url text, updated_at timestamptz)` — SQL: `supabase/task-email-thread-setup.sql`
- `taskEmailCache` — `{task_id: thread_url}`, načíta sa v `loadCaflouTasks` (`in('task_id', taskIds)`), cleared on `syncData`
- V riadku úlohy (len ext): ikona ✉️ — modrá/plná = `<a>` priamo na `thread_url` (nová karta); sivá/prázdna = `onclick` spúšťa buď `toggleTaskMailForm` (compose panel) alebo (ak URL už bolo zadané ručne) nič zvláštne
- **Ručné priradenie:** v edit forme externej úlohy (`tspec-section-{editKey}`) input `temail-{editKey}` (Gmail URL) vedľa výberu špecialistu; `saveCaflouTaskEdit` ho upsertne/zmaže v `task_email_threads`
- **Automatické — "Spustiť komunikáciu" (2026-07-29):** klik na neprideleného ✉️ → `toggleTaskMailForm(editKey)` otvorí `#tmail-{editKey}` panel (adresát predvyplnený z `specialistsList` emailu priradeného špecialistu, predmet `SKRATKA_PROFESIE ČÍSLO - NÁZOV`, textarea na text) → `sendOfficialMail(cislo, task_id, editKey)` zavolá Apps Script akciu `sendOfficialMail` (`GmailApp.sendEmail` + dohľadanie vzniknutého vlákna), výsledný `permalink` sa hneď uloží do `taskEmailCache` + `task_email_threads` bez ručného kopírovania URL
- **Vyžaduje redeploy Apps Scriptu** (zmena `doPost`) — pozri "Apps Script gotchas"

**Functions:** `loadCaflouTasks`, `buildCaflouTasksHtml`, `setCaflouTaskStatus`, `finishCaflouTask`, `unfinishCaflouTask`, `toggleFinishedTasks`, `createCaflouTask`, `toggleTaskEdit`, `toggleTaskExtBtn`, `saveCaflouTaskEdit`, `deleteCaflouTask`, `loadSpecialists`, `filterSpecDropdown`, `preloadTaskNotes`, `buildTaskNotesHtml`, `toggleTaskNotes`, `addTaskNote`, `bulkSetDeadline`, `toggleTaskMailForm`, `sendOfficialMail`

### Fáza-tag na úlohách (`TASK_FAZA_TAGS`) — nezávislé od projektovej fázy

Každá Caflou úloha môže mať v `tags` jeden z `TASK_FAZA_TAGS = ['AŠ','SZ','DSP','PS','RP','INŽ']` (farby `TASK_FAZA_COLOR`, labely `TASK_FAZA_LABEL`) — označuje, ku ktorej fáze projektu sa úloha vzťahuje. Toto je **nezávislé** od `stavMap`/`CAFLOU_STATUS_MAP` (celkový stav projektu) — jedna úloha má svoj vlastný fáza-tag bez ohľadu na to, v akej fáze je práve projekt ako celok (napr. RP úloha môže existovať aj keď je projekt ešte v Projekcii).

- `getTaskFazaTag(t)` — vytiahne fáza-tag z `t.tags`
- `caflouTaskFazaFilter[cislo]` — per-projekt filter, `setTaskFazaFilter(cislo, tag)` prepína (klik na už aktívny filter ho zruší)
- Netagované úlohy sú viditeľné vždy, bez ohľadu na aktívny filter (aj v bulk-select cez `bulkSelectAll`)

### Šablóny úloh (`task_templates`)

Supabase tabuľka `task_templates (id uuid, name text, tasks jsonb, created_at timestamptz)` — `tasks` je pole `{name, faza, ext}` (faza = jeden z `TASK_FAZA_TAGS` alebo `null`, ext = bool).

- `taskTemplates` — cachované v pamäti (`null` = nenačítané), `loadTaskTemplates()` fetchne raz zo Supabase
- **Správa šablón:** `openTmplMgr()` → `#tmplMgrModal`, zoznam (`renderTmplMgrList`) + editor jednej šablóny (`openTmplEdit`/`renderTmplEditForm`) — riadky úloh s názvom, fáza-selectom a Interné/Externé prepínačom (`toggleTmplTaskExt`), `saveTmplEdit`/`deleteTmpl`
- **Aplikovanie na projekt:** tlačidlo **"📋 Šablóna"** v detaile projektu → `openTmplPicker(cislo)` → vyber šablónu → `renderTmplPicker` ukáže checkboxy jej úloh (predvolene všetky zaškrtnuté) → `applyTmplTasks(cislo)` vytvorí v Caflou reálnu úlohu pre každú zaškrtnutú (`POST /tasks`, `tags: [ext?'ext':null, faza].filter(Boolean)`), doplní `p.caflou_task_ids`, invaliduje cache a znovu načíta úlohy projektu

**Prepojenie na harmonogram (ROZPRACOVANÉ, len návrh z konverzácie 2026-07-08, nič ešte neimplementované):**

Jozef: interná úloha (projekčná práca) a riadok v harmonograme sú "jedna a tá istá vec" videná z dvoch strán — úloha má dátumy rovnako ako harmonogram riadok. Nie každá interná úloha ale patrí do harmonogramu (napr. "vystavenie faktúry" nie je projekčná práca) — treba samostatný príznak.

Navrhovaný mechanizmus (obe cesty vedú k tomu istému: nenaplánovanému `harmonogram` riadku s už vyplneným `caflou_task_id`, čaká len na doplnenie projektanta/trvania/alokácie):
1. **Zo šablóny** — úloha v šablóne by dostala ďalší príznak "patrí do harmonogramu" (+ pri SZ/DSP-PS/RP výber podpodfázy: príprava/koordinácia/dopracovanie). `applyTmplTasks` by pre takto otagované úlohy rovno vytvorila aj `harmonogram` riadok.
2. **Manuálne, kedykoľvek dodatočne** — rovnaký príznak (fáza + podpodfáza) dostupný aj v bežnom edit formulári úlohy (`toggleTaskEdit`/`saveCaflouTaskEdit`, vedľa Interné/Externé prepínača) — dôležité najmä pre **Štúdiu**, ktorá nemá trojblokovú štruktúru a jej úlohy Jozef zakladá úplne manuálne (nie zo šablóny).

Dôvod, prečo toto vzniklo: diskusia o tom, že súčasná harmonogram-simulácia (`harmSimulujRealne`) je čisto predikcia dopredu bez spätnej väzby z reality — Caflou už má reálne odpracované hodiny (projektanti si vykazujú na úlohy), len sa z nich "nie sme múdri". Zámer do budúcna: časť grafu pred dneškom prestať simulovať a ukazovať z reálne vykázaného času (koľko z alokácie sa minulo/ostáva — viditeľné len Jozefovi/šéfovi, nie projektantovi), časť po dnešku ostáva plán/predikcia ako doteraz. Toto si ale vyžaduje spoľahlivé 1:1 prepojenie `harmonogram` riadku (podfázy) na konkrétnu Caflou úlohu, na ktorú sa vykazuje — u nových podfáz bude 1 úloha = 1 podfáza, u starších existuje aj prípad jednej úlohy zdieľanej naprieč všetkými tromi podfázami (tam by porovnanie malo byť len na úrovni celej fázy, nie podfázy). Vizuálne pre "zaostáva/predbieha plán" bude treba tretí kanál nezávislý od farby (tá už nesie identitu projektu) a šrafovania (to už nesie simulované zdržanie) — napr. orámovanie pruhu.

### Zápisky (chronologický prehľad)

Tlačidlo **Zápisky** v headeri → `openChronoModal()` → `#chronoModal`.

- `buildChronoContent()` — zbiera **top-level** záznamy (`!parent_id`) z `dennikMap` (všetky projekty, alebo len filtrovaný projekt) + `taskNotesCache` (len lazy-loaded úlohy), zoradí podľa `created_at` desc, zobrazí posledných 50
- Záznamy z denníka: cislo sivé/malé, názov projektu tučný/tmavý; záznamy z úloh: názov úlohy
- `chronoAddDennik()` — pridá nový záznam do denníka priamo z modálu (cieľový projekt = `#chronoProjVal`), volá `buildChronoContent()` bez zavretia modálu
- **Poznámka:** task notes sa zobrazia len ak boli v tejto session lazy-loaded (user otvoril projekt)

**Výber/filter projektu (2026-07-29):** `#chronoAddCislo` dropdown nahradený autocomplete inputom (`#chronoProjQ` + hidden `#chronoProjVal` + `#chronoProjDrop`, rovnaký `.proj-search-wrap`/`.proj-dropdown` vzor ako `fPonukyQ` v ponuky-filtri) — `onChronoProjQ()` našepkáva podľa písania (vynecháva Archív), `selectChronoProj()` naplní `chronoProjVal` a **zároveň** prefiltruje `buildChronoContent()` na daný projekt (jeden ovládací prvok = cieľ nového zápisu aj filter zobrazenia), `clearChronoProj()`/✕ tlačidlo zruší filter. Prázdny input = žiadny filter (všetky projekty).

**Vybaviť ešte dnes:** ak existujú `today && !done` top-level záznamy (po aplikovaní filtra), zobrazia sa v sekcii "🔥 Vybaviť ešte dnes (N)" nad hlavným zoznamom "Všetky zápisky".

**Podvlákno v Zápiskoch:** rovnaké správanie ako v detaile projektu (klik na text zápisu rozbaľuje/zbaľuje, posledné 3 odpovede vždy viditeľné) — zdieľa `dennikThreadOpen` Set aj `buildDennikThreadPreviewHtml`/`buildDennikRepliesHtml` s `buildDennikListHtml`, keďže obe miesta čítajú ten istý `dennikMap`.

### Gemini integration

`geminiZhrnVsetky()` calls Apps Script (`cfg.url`) action `zhrniProjekt` for each visible project. Result stored in `geminiMap`. Ak sú pre projekt načítané úlohy v `caflouTasksCache`, zahrnie aj posledné 3 poznámky každej externej úlohy (rovnako ako `geminiZhrnProjekt`).

**Zbaliteľné "Zhrnutie AI" v detaile (2026-08-12):** default skryté (šetrí miesto pri dlhších zhrnutiach) — `gemExpandedSet` (`localStorage('pmGemExpanded')`, obsahuje `cislo` rozbalených projektov), `toggleGemSummary(cislo)` prepína `display` na `#gem-detail-{cislo}` + šípku `#gem-arrow-{cislo}` priamym DOM zásahom (nie cez re-render, rovnaký dôvod ako inde — nesmie kolabovať iné otvorené detaily). Klik na "✦ Zhrnúť" (`geminiZhrnProjekt`) rozbalí automaticky, ak bolo zbalené, nech je nové zhrnutie hneď vidno.

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
- `sendOfficialMail` (2026-07-29) — `{to, subject, body}` → `GmailApp.sendEmail()`, počká 2s, `GmailApp.search('in:sent to:"..." subject:"..."')` nájde vzniknuté vlákno, vráti `{ok, threadId, permalink}` (`#all/{threadId}` formát, funguje bez ohľadu na label). Volané z `sendOfficialMail()` v `index.html` — pozri "Oficiálne mailové vlákno" nižšie
- `findKoordinaciaFolder` (2026-08-28) — `{cislo}` → nájde priečinok projektu na Shared Drive `1_PROJEKTY` (`PROJECTS_DRIVE_ROOT_ID`) podľa prefixu (`26-026` → `2026-026`), v ňom podpriečinok `20_KOORDINACIA`, vráti `{ok, url}`. Volané z `getKoordinaciaFolderUrl()` v `index.html` pri batch vytváraní dopytov — pozri "Dopyty" vyššie

**Apps Script gotchas:**
- Gmail oprávnenia môžu expirovat — treba spustiť `sledujMaily` manuálne z editora aby sa zobrazil OAuth popup
- Po každej zmene kódu treba aktualizovať nasadenie (Deploy → Manage → nová verzia)
- Trigger `sledujMaily` — time-driven, každú hodinu; hľadá `newer_than:1d label:inbox`
- Trigger `sledujKomentare` — time-driven (nastaviť ručne, odporúčaná každá hodina, prípadne kratšie ak je vysoký objem aktivity) — sleduje nové **ľudské komentáre na projektoch napísané priamo v Caflou** (kolega), zapisuje ich do Supabase `dennik` → tým sa automaticky spustí existujúci push webhook (žiadna extra logika netreba). Detaily nižšie.
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

**Gotcha — nasadenie edge function je manuálne:** `supabase/functions/send-push/index.ts` v repe je len záloha, **git push ju nenasadí** — po každej zmene treba ísť do Supabase Dashboard → Edge Functions → `send-push` → Deploy a vložiť aktuálny obsah súboru (rovnaký postup ako Apps Script `Code.gs`).

**Vyriešené (2026-08-12):** `url` v payloadoch (`ponuky.html`/`index.html` cesty) mala natvrdo starú GitHub adresu `jozefperichta-ctrl.github.io` (namiesto aktuálnej `architt-ctrl.github.io`, overené 404 vs 200) — klik na notifikáciu preto skončil na 404 mieste presmerovania na dashboard. Opravené v repe aj redeploynuté v Supabase Dashboard, otestované priamym volaním edge function (`curl POST .../functions/v1/send-push` so synteticky zostaveným `{table:'dennik',type:'INSERT',record:{...}}` payloadom, `Authorization: Bearer <anon key>` — nevyžaduje service role key ani reálny insert do `dennik`, edge function si údaje zo `sbGet` ťahá interne) → `{"ok":true,"sent":1,"expired":0}`, notifikácia s opravenou URL potvrdená naživo.

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
- **Úlohy v karte člena zoskupené podľa projektu (2026-07-03, Jozef):** hlavička skupiny = číslo (sivé) + názov projektu (tučný) raz, úlohy pod ňou odsadené bez opakovania čísla; skupiny zoradené podľa čísla projektu

### Financie (príjmy/výdavky projektov, 2026-07-30)

Tlačidlo **„💰 Financie"** v headeri → `openFinancieModal()` → `#financieModal`.

- Zdroj dát: Caflou **`transfers`** (rovnaký resource ako existujúce `createCaflouExpense` v `ponuky.html`) — `kind` môže byť `"income"` (príjem) aj `"expense"` (výdavok), obe naviazané na `project_id`. Na rozdiel od `project_id` filtra (ignorovaný server-side, rovnaký problém ako pri `/tasks`/`/comments`) **`kind` filter funguje server-side** (overené: `expense` 1305 + `income` 180 = presne 1485 = total bez filtra) — napriek tomu sa fetchuje bez `kind` filtra a delí sa klientsky, aby stačil jeden prechod stránok
- `GET /transfers?per=100&page=N` — paginated (~15 strán pri súčasnom objeme ~1500 záznamov), filtruje sa `!t.trash`; každý transfer už obsahuje `project_id` priamo, netreba extra lookup
- `financieByProject(data)` spáruje `t.project_id` s dashboard projektom cez `p.caflou_id` (rovnaké `p.caflou_id = p.id` ako v `suhrn.html`), vynechá `Interná réžia`, sčíta `prijmy`/`vydavky` per `cislo`, a zároveň buduje `byFaza` (per-fáza súčty, kľúč `'—'` pre bez fázy)
- Cache: `_financieData` (plochý zoznam `{id,kind,project_id,task_id,value,name,date,faza}`), invalidovaný v `syncData()` spolu s `financieOpenSet = new Set()`
- **Modal** — zoznam projektov (súčty príjmy zelené/výdavky červené/bilancia tučná farebná podľa znamienka), klik na riadok rozbalí (`toggleFinancieRow`) jednotlivé položky (dátum, fáza-badge, názov, suma) zoradené podľa dátumu zostupne
- **Vyhľadávanie projektov (2026-08-26):** `#financieSearch` input nad zoznamom (statický v modáli, mimo `#financieContent`, takže si drží focus počas pretláčania) — `onFinancieSearch(v)` ukladá do `financieSearchQuery` a prekresľuje len obsah; `buildFinancieHtml()` filtruje `list` podľa `cislo`/`nazov`. Resetuje sa (aj input hodnota) pri každom `openFinancieModal()`, s auto-focusom keď sa berie z cache
- **Delenie podľa fázy (2026-08-26):** Caflou `transfers` majú vlastné pole `tags` (rovnaké ako Caflou úlohy) — využíva sa existujúci `TASK_FAZA_TAGS`/`TASK_FAZA_COLOR`/`TASK_FAZA_LABEL` systém (pozri "Fáza-tag na úlohách"). Fáza transferu sa určí: (1) priamo z `t.tags` ak transfer má fáza-tag, inak (2) z fáza-tagu naviazanej Caflou úlohy cez `t.task_id` → `_financieTaskFazaMap[task_id]` (mapa `task_id → fázaTag|null`, postavená jednorazovým paginovaným scanom **všetkých** Caflou úloh `/tasks?per=100&page=N` — rovnaký vzor ako `openVytazenieModal` — cachovaná v `_financieTaskFazaMap`, invalidovaná pri `syncData()`). V rozbalenom riadku projektu sa nad zoznamom položiek zobrazí farebný súhrn `fazaBar` (súčty prijmy/vydavky per fáza + „bez fázy"), pri manuálnom pridávaní pribudol `<select>` fázy ktorý sa ukladá ako `tags` na nový transfer
- **Manuálne pridanie** (`saveFinancieEntry(cislo, kind)`) — v rozbalenom riadku formulár Názov + Suma + Dátum + Fáza (bez poľa na firmu, zámerne — pozri gotcha nižšie), tlačidlá **+ Príjem** / **+ Výdavok** → `POST /transfers` s `{transfer:{kind, project_id: p.caflou_id, name, value, currency:'EUR', date, tags:[faza]}}`, po úspechu sa záznam pridá do `_financieData` a modal sa prekreslí bez nového fetchu
- **Editácia a mazanie existujúcich položiek (2026-08-26):** pri každej položke (v rozbalenom stave) ✎/✕ ikony. ✎ → `financieEditId = t.id` (jednoduchý globálny stav, len jedna položka naraz), riadok sa nahradí inline formulárom (názov/suma/dátum/fáza) → `saveFinancieEditEntry(cislo, id)` optimisticky prepíše lokálny záznam v `_financieData` a prekreslí, potom `PATCH /transfers/{id}` s `{transfer:{name, value, date, tags:[faza]}}` (kind sa needituje — zriedkavá potreba, rieši sa zmazaním a novým pridaním). ✕ → `deleteFinancieEntry(cislo, id)` s `confirm()`, optimisticky odstráni zo `_financieData`, potom `DELETE /transfers/{id}`
- **Gotcha — company_id pri manuálnom výdavku:** rovnaká Caflou vlastnosť ako pri `createCaflouExpense` v `ponuky.html` — ak sa nepošle `company_id`, Caflou ho automaticky priradí ku **klientovi projektu**, nie k dodávateľovi. Vedomé rozhodnutie (Jozef, 2026-07-30): formulár pole na firmu nemá (jednoduchosť), takto vzniknuté zle priradenie sa opraví ručne priamo v Caflou keď treba — netreba to considerovať za bug

### Dopyty (cenové ponuky pre profesie, 2026-08-28)

**Kontext/dôvod presunu z `ponuky.html`:** pôvodne mal `ponuky.html` dva samostatné taby — „Dopyty" (zoznam zoskupený podľa projektu, naprieč všetkými) a „Prehľad CP" (rovnaké dáta, len súhrnný pohľad na ceny, needitovateľný). Jozef ich zjednotil a presunul do dashboardu: nechce prekliky cez cudzie projekty, chce z projektu v `index.html` priamym tlačidlom vojsť rovno do jeho dopytov, rozdelených po fázach. `ponuky.html` taby „Dopyty"/„Prehľad CP" **zatiaľ ostávajú v kóde** (neodstránené), ale nový tok ide cez `index.html`.

Tlačidlo **„📨 Dopyty"** pri projekte (vedľa „📋 Šablóna") → `openDopytyModal(cislo)` → `#dopytyModal`.

**Záložky fáz (`PONUKY_FAZY`)** — `['Studia','SZ','DSP/PS','RP']`, **bez Inžinieringu** (Jozef: "inžiniering nepatrí do projekcie" — dopyty na profesie sa riešia len počas projekčných fáz). Toto je **iné názvoslovie než `TASK_FAZA_TAGS`** (Caflou task-tagy: AŠ/SZ/DSP/PS/RP/INŽ, DSP a PS oddelene) — `PONUKY_FAZY` kopíruje `harmonogram.faza_kod`/historické `requests.phases` hodnoty (`SZ|DSP/PS|RP|UP|Studia|Inziniering`), lebo sa naň priamo napája (`podklady_datum` z harmonogramu, nižšie). `UP` (územný plán) zámerne vynechané zo záložiek.

**`projFazaKod(p)`** — mapuje aktuálnu fázu projektu na `PONUKY_FAZY` hodnotu. **Musí ísť cez `p.caflou_status`** (raw Caflou status kľúč, napr. `'4_RP'`), nie cez `p.podfaza` — `CAFLOU_STATUS_MAP` má `3_DSP`, `3_PS` aj `4_RP` namapované na **rovnaké** `podfaza:'Projekt stavby'`, takže `podfaza` samotné nevie rozlíšiť RP od DSP/PS. Mapovacia tabuľka `CAFLOU_STATUS_TO_PONUKY_FAZA` je duplicitná (ale odlišná hodnotami) k `CAFLOU_STATUS_TO_FAZA_TAG` — tá druhá drží DSP/PS oddelene pre účely task-tagov, táto ich zlučuje pre účely dopytov.

**Zoznam profesií (`PONUKY_PROFESSIONS`)** — pevný zoznam `DOPRAVA, ELI, PBS, PLYN, STATIKA, technologie, UK, VN, VZT, ZTI`, odvodený zo skutočných kategórií v Supabase `specialists.profession` (vynechané zámerne: `specialne profesie`, `STATIKA_A+`). V „+ Nové dopyty" formulári vždy aj pole na vlastný text (dopyt pre profesiu mimo pevného zoznamu).

**Batch vytvorenie dopytov (`saveDopytyBatch`):** zaškrtneš profesie (checkboxy, viacnásobný výber) → pre každú vznikne samostatný `requests` riadok s `phases: [faza]` (**jeden dopyt = jedna fáza**, na rozdiel od starších dopytov, ktoré mávali `phases` pole s viacerými fázami naraz), `current_phase: faza`, a automaticky doplnené:
- **`folder_url`** = odkaz na `20_KOORDINACIA` priečinok projektu (pozri "Nová štruktúra projektového priečinka" vyššie) — `getKoordinaciaFolderUrl(cislo)`: najprv cache `project_folders` (Supabase, `cislo → koordinacia_url`), pri cache-miss zavolá Apps Script akciu `findKoordinaciaFolder` (nová, `akcia_findKoordinaciaFolder` v `Code.gs`) a výsledok uloží do cache. Akcia prechádza priamych potomkov Shared Drive `1_PROJEKTY` (`PROJECTS_DRIVE_ROOT_ID = '0AAim-BTmMDGAUk9PVA'`), hľadá priečinok s prefixom `20YY-NNN` (konverzia z dashboard formátu `YY-NNN`, rovnaká konvencia ako `sync-fazy.ps1`) a v ňom `20_KOORDINACIA` podpriečinok.
- **`hotovo_datum`** = termín projektu (`p.deadline`, Caflou `end_date`) mínus 10 dní.
- **`podklady_datum`** — ručne zadaný v batch formulári (jedno pole, spoločné pre všetky profesie v danom batchi), predvyplnený z harmonogramu ak existuje (`getHarmPodkladyDatum`: Supabase `harmonogram` riadok pre `cislo`+`faza_kod`+`podpodfaza='príprava pre profesie'` → `start_datum + trvanie_tyzdne`), inak dnešný dátum. Po uložení sa zapíše do **všetkých** dopytov danej fázy naraz (`sb.from('requests').update(...).eq('project_cislo',cislo).contains('phases',[faza])`), nielen do novovytvorených — Jozef: "ten dátum bude pre všetky dopyty v jednej fáze". **Obojstranné prepojenie s harmonogramom (t.j. editácia v dopyte spätne posunie `start_datum` v harmonograme, a naopak) je zatiaľ NEIMPLEMENTOVANÉ** — len jednosmerné prevzatie pri zobrazení defaultnej hodnoty.

**Správa ponúk priamo v modáli** — klik na profesiu rozbalí detail (`toggleDopytRow`/`buildDopytDetailHtml`), mirror logiky z `ponuky.html`:
- `selectDopytWinner`/`withdrawDopytQuote`/`cancelDopytWinner` — rovnaké statusové prechody ako `ponuky.html` (`selectWinner`/`withdrawQuote`/`cancelWinner`), vrátane zápisu do `task_specialists` a automatického Caflou výdavku (`createCaflouExpense`, kópia rovnomennej funkcie z `ponuky.html`) pri výbere víťaza, ak má profesista `caflou_company_id`
- **„+ Zadať ponuku ručne"** (`saveManualPonuka`) — priamo tu sa rieši prípad, že profesista nechce/nemá chodiť na portál a pošle cenu mailom: vyberieš ho zo `specialistsList` (tí čo už majú ponuku sú vynechaní), zadáš cenu, uloží sa rovno ako `submitted` (vytvorí `invitation` aj `quote` v jednom kroku — **bez** predchádzajúceho "pozvania", ktoré sa už dávno nepoužíva, pozri nižšie)
- **Gotcha — cena vždy len za aktuálnu fázu:** `q.prices` je `{fázaKód: suma}` mapa; keďže staršie dopyty môžu mať vo `phases`/`prices` viacero fáz naraz, všetky miesta v tomto modáli (zoznam ponúk, „+ Zadať ponuku ručne", stavový text v hlavičke) čítajú/zapisujú **len `prices[_dopytyCtx.faza]`** (aktuálne otvorená záložka) — nikdy nesčítavajú cez `Object.values(prices)`. Pôvodná implementácia to robila (súčet všetkých fáz) a zobrazovala tak nezmyselne rovnakú/nahustenú sumu bez ohľadu na to, ktorú fázu si pozeral.
- **✕ Vymazať dopyt** (`deleteDopyt`) — kaskádovo zmaže `quotes`+`invitations`+`requests`, ako `ponuky.html:deleteReq`

**Pozývanie profesistov cez systém je dávno zrušené** (Jozef) — pôvodný `openInviteModal`/`doInvite` flow v `ponuky.html` (checkbox výber kontaktov → vytvorí `invitations` bez ceny, čaká na profesistu) sa reálne nepoužíva a **nie je odnikiaľ vo UI zavesený** (mŕtvy kód, funkcie existujú ale nič ich nevolá). Aktuálny tok: Jozef vytvorí dopyt, profesista dostane **raz** svoj trvalý `portal.html?specialist=UUID` link (`specialists.portal_token`) a odvtedy chodí naň sám kedykoľvek, vidí všetky aktívne dopyty a sám podá ponuku (`submitSpecQuote` v `portal.html` si sama vytvorí `invitation`, ak neexistuje). Preto pri manuálne zakladanom dopyte (vyššie) neexistuje žiadny medzikrok "pozvať" — buď profesista príde sám cez portál, alebo mu cenu zapíšeš ty priamo.

**Výkon — cielený refresh namiesto plného re-renderu:** `renderDopytyModal()` (plné prekreslenie: záložky + zoznam + „+ Nové dopyty" formulár + fetch harmonogramu) sa volá len pri prepnutí záložky (`switchDopytyFaza`), batch vytvorení (`saveDopytyBatch`) a zmazaní (`deleteDopyt`) — teda pri akciách čo menia *zoznam* dopytov. Bežné akcie nad jednou ponukou (rozbalenie riadku, výber/stiahnutie/zrušenie víťaza, ručné zadanie ceny) idú cez `toggleDopytRow`/`refreshDopytRow`, ktoré upravia len `#dopyt-status-{id}`/`#dopyt-detail-{id}` daného riadku priamym DOM zásahom — pôvodná verzia volala plný re-render pri každej takejto akcii (vrátane zbytočného opätovného fetchu harmonogramu), čo bolo citeľne pomalé ("dosť to seká").

**SQL migrácie:** `supabase/project-contacts-setup.sql`, `supabase/project-folders-setup.sql` — obe treba spustiť ručne v Supabase SQL Editore pred použitím.

### Vyhľadávanie projektov

`searchQuery` — globálna premenná. Search input v `phase-bar`. Keď je neprázdny, `renderProjects()` zobrazí všetky zodpovedajúce projekty naprieč všetkými fázami s farebnými fáza badges. Plné project rows s detail divmi — projekt možno rozkliknúť priamo vo výsledkoch.

### Názov projektu v title karty prehliadača (2026-07-20)

Keď je otvorený jeden projekt na viacerých kartách naraz, karty sú nerozlíšiteľné (všetky "Prehľad"). `toggleProjDetail(cislo)` preto pri otvorení detailu nastaví `document.title = p.nazov`; pri zatvorení sa vráti na `DEFAULT_TITLE` (pôvodný `<title>`, zachytený raz pri načítaní skriptu) — alebo na názov iného projektu, ak ostal otvorený iný `.proj-detail.open`.

### Odkaz na projektový priečinok (📁, 2026-07-20)

Tlačidlo 📁 pri každom projekte otvára priečinok projektu v reálnom Windows Prieskumníku. `folderSearchLink(cislo)` vracia `search-ms:` URI (`query=<cislo>&crumb=location:H:\Spoločné disky\1_PROJEKTY`), nie priamy `file://` odkaz — presný názov priečinka na disku sa môže líšiť od Caflou (rovnaký dôvod, prečo `sync-fazy.ps1` hľadá priečinky prefix-regexom, nie presnou zhodou), a `file://` linky z `https://` stránky navyše prehliadač spoľahlivo neotvára v Exploreri. `search-ms` funguje len ak má Windows Search zaindexovaný daný H: disk (Indexing Options).

**Nefunkčné v praxi (2026-08-31, potvrdené Jozefom — "otvorí Explorer ale nič nenájde"):** `H:\Spoločné disky\...` je Google Drive for Desktop mount v "Stream" režime — virtuálny súborový systém bez lokálneho change journalu, ktorý Windows Search principiálne nevie indexovať (nie je to len otázka zapnutia v Indexing Options). `search-ms` preto pri tomto disku dlhodobo nemôže fungovať. Zatiaľ sa nerieši (Jozef: "nechaj to tak") — vyriešiteľná alternatíva (Drive web link namiesto lokálneho Explorera, rovnaký princíp ako "Odkaz na priečinok s podkladmi" nižšie, keďže `akcia_findKoordinaciaFolder` už cestou k `20_KOORDINACIA` nájde aj koreňový priečinok projektu) je premyslená, ale zámerne neimplementovaná — čaká na Jozefov súhlas.

**Šablóna riadku projektu existuje na 3 miestach** (`projRowHtml`, výsledky vyhľadávania a Archív v `renderProjects()`) — akúkoľvek zmenu tlačidiel v riadku (📁, ✎...) treba spraviť na všetkých troch, inak zmizne len v niektorých pohľadoch (stalo sa pri prvom pridaní 📁 — chýbalo vo vyhľadávaní aj Archíve).

### Odkaz na priečinok s podkladmi (🔗, 2026-08-31)

Pri každom projekte v zozname (na všetkých 3 miestach šablóny riadku, pozri vyššie) je vedľa 📁 ďalšia ikona — priamy link na Drive priečinok `20_KOORDINACIA` (spoločný priečinok pre podklady všetkých profesií, pozri "Realita overená naživo" v sekcii o štruktúre priečinka nižšie). Zámerne **nie** automatický scan naprieč všetkými projektmi (bolo by to príliš veľa Apps Script/Drive volaní naraz) — objavuje sa lenivo, projekt po projekte, na Jozefov klik.

- `koordinaciaFolderMap` — `{cislo: url}`, bulk-loadovaná v `syncData()` z existujúcej cache tabuľky `project_folders` (tá istá, čo používa batch vytváranie dopytov — pozri "Dopyty" vyššie)
- `koordIconHtml(cislo)` — ak je `cislo` v mape → modrý `🔗` odkaz priamo na Drive (`target="_blank"`); inak `🔍` tlačidlo
- `findKoordFolder(cislo)` — klik na `🔍` zavolá existujúci `getKoordinaciaFolderUrl(cislo)` (Apps Script `findKoordinaciaFolder`, s rovnakým upsertom do `project_folders` ako pri Dopytoch), po úspechu/neúspechu prepíše len daný `#koord-{cislo}` element (`outerHTML`) — žiadny plný re-render
- **Farba/ikona zámerne odlišná od 📁** (modré orámovanie + 🔗, namiesto podobného 🗂️ z prvej verzie) — Jozef: pôvodné dve ikony boli vizuálne príliš podobné na to, aby vedel na prvý pohľad rozlíšiť, ktorá otvára čo

### IFC 3D viewer — shareable link (🧊, HOTOVO 2026-09-04)

**Cieľ (Jozef):** vedieť poslať odkaz na 3D náhľad IFC modelu (klientovi, kolegovi), bez toho aby príjemca potreboval prístup do firemného Google Drive alebo appky — otvorí link, uvidí model priamo v prehliadači. Zámerne nie hotový SaaS viewer (Aspose/GroupDocs/BIMdata) — dôvod: projektové dáta klientov by inak videla tretia strana na svojich serveroch. IFC súbor ostáva na Drive presne tam, kde už je — nič sa nekopíruje ani neuploaduje inam.

**Konvencia umiestnenia súboru:** appka hľadá `.ifc` súbor v `20_KOORDINACIA/ARCHITEKTURA/` daného projektu (rovnaká Drive lokalita ako link na podklady vyššie) — pri viacerých `.ifc` súboroch naraz berie ten **naposledy upravený** (`getLastUpdated()`), nie prvý nájdený v poradí Drive priečinka.

**Link je viazaný na projekt (`cislo`), nie na konkrétny Drive súbor (opravené 2026-09-10):** pôvodná verzia embedovala priamo Drive `fileId` do linku (`ifc-viewer.html?fileId=...`) — keď Jozef IFC súbor v priečinku vymenil za nový (nové Drive ID), starý odkaz zostal ukazovať na starý/zmazaný súbor a nový sa musel poslať znova. Teraz link nesie len **`cislo`** (`ifc-viewer.html?cislo=26-026&nazov=...`) a `ifc-viewer.html` si aktuálny `fileId` naživo dotiahne zo Supabase (`project_folders.ifc_file_id`, `sb.from('project_folders').select('ifc_file_id').eq('cislo',cislo)`) pri každom otvorení — stránka preto teraz embeduje Supabase klienta (`SB_URL`/`SB_KEY`, rovnaké hodnoty ako `portal.html`), pôvodne bola úplne bez backendu. **Dôsledok pre Jozefa:** raz poslaný link zostáva platný navždy; po výmene IFC súboru stačí **raz kliknúť 🧊** v dashboarde (zaeviduje nový súbor + nastaví naň zdieľanie, prepíše `project_folders`) — link sa nemusí generovať ani posielať znova. **Staré (pred-opravové) linky s `?fileId=...` už nefungujú** — treba ich nahradiť novým klikom na 🧊.

**Tok:** klik na 🧊 pri projekte (`index.html`, `ifcIconHtml`/`shareIfcLink`, rovnaký vzor a rovnaké 3 miesta šablóny riadku ako 🔗) → **vždy** (nie len pri cache-miss — pôvodná verzia cache-hit prípad preskakovala, čo bola priama príčina "stále starý súbor" bugu) zavolá Apps Script akciu `findIfcFile` (`akcia_findIfcFile`, `Code.gs`, vzor `akcia_findKoordinaciaFolder`) → tá nájde najnovší súbor a **nastaví naň `DriveApp.setSharing(ANYONE_WITH_LINK, VIEW)`** (prvý prípad v appke, kde sa programovo mení zdieľanie Drive súboru), vráti `{fileId, name}`, uloží sa do `project_folders.ifc_file_id/ifc_file_name` (SQL: `supabase/ifc-viewer-setup.sql`) → appka poskladá stály link `ifc-viewer.html?cislo=...&nazov=...` a skopíruje ho do schránky (`navigator.clipboard.writeText`, vzor `genTeamLink`).

**`ifc-viewer.html`** — nová samostatná stránka (root repa, vedľa `portal.html`), **bez loginu** (na rozdiel od `ponuky.html`/`harmonogram.html`), ale **so Supabase** klientom na read-only lookup (pozri vyššie) — rovnaká CSS paleta/font (DM Sans) ako `portal.html`. Číta `cislo`+`nazov` z URL parametrov.

- **Knižnice bez bundlera:** `three`, `web-ifc`, `@thatopen/components`, `@thatopen/fragments`, `camera-controls` cez `<script type="importmap">` z jsDelivr `/+esm` CDN endpointov (presné vzájomne kompatibilné verzie **musia byť pinnuté** — zistené cez `npm view <pkg> peerDependencies`, nie odhadom: `three@0.185.1`, `web-ifc@0.0.77`, `@thatopen/fragments@3.4.7`, `@thatopen/components@3.4.8`, `camera-controls@3.1.2`). WASM (`web-ifc.wasm`) sa nedá servovať cez `+esm` — `ifcLoader.setup({autoSetWasm:false, wasm:{path:'https://unpkg.com/web-ifc@0.0.77/', absolute:true}})`.
- **Sťahovanie súboru:** `https://www.googleapis.com/drive/v3/files/{fileId}?alt=media&supportsAllDrives=true&key={API_KEY}` — **NIE** priamy `drive.google.com/uc?export=download` link (ten nemá CORS hlavičky pre `fetch()` z cudzej domény, navyše pri väčších súboroch zobrazí "nedá sa skenovať na vírusy" medzistránku namiesto bajtov). `supportsAllDrives=true` je **povinné** — projekty sú na firemnom Shared Drive, bez tohto parametra Drive API v3 vráti 404 aj pre verejne zdieľaný súbor. Overené naostro na reálnom 38MB IFC modeli (Hotel Bellevue) — CORS hlavička sa vracia korektne, žiadny "vírusový" medzikrok, celý súbor prišiel v ~3s.
- **Google API kľúč** (samostatný, nie ten istý čo Gemini) — vytvorený v tom istom GCP projekte ako Gemini kľúč, obmedzený na Drive API + HTTP referrer `https://architt-ctrl.github.io/*`. Embedovaný priamo v zdrojovom kóde `ifc-viewer.html` (verejný, ale nie tajný — to je bežný a správny vzor pre prehliadačové API kľúče, chránené len referrer/API obmedzením, nie utajením).
- **Rezy:** `components.get(OBC.Clipper)`, `clipper.create(world)` na dvojklik do modelu, `clipper.delete(world)` na Delete/Backspace, `clipper.deleteAll()` na tlačidlo.
- **Hrubá rezová čiara — SKÚŠANÉ A ZAMIETNUTÉ (2026-09-11):** Jozef chcel architektonický štandard: výraznú hrubú čiaru presne tam, kde rovina rezu reže konštrukciu (`Clipper` sám osebe je len holé WebGL orezanie, `material.clippingPlanes`, žiadny built-in cap/fill/outline). Implementované ručne — prienik roviny s každým trojuholníkom cez `THREE.Plane.intersectLine()` nad rovnakými per-položkovými dátami ako hranové čiary (`model.getItemsGeometry`), vykreslené cez `Line2`/`LineMaterial` (`three/examples/jsm/lines/`) pre skutočnú hrúbku v pixloch. Postupne opravené dva reálne bugy: (1) numerická nestabilita pri trojuholníkoch takmer rovnobežných s rovinou (1cm tolerancia predtým než sa počíta prienik), (2) rovina rezu je matematicky nekonečná — cez otvorený priestor (schodisko/atrium) sa premietali aj rezy vzdialenými podlažiami (obmedzenie na oblasť okolo `planeEntry.origin`). **Napriek oboch opravám Jozef zamietol** — v mieste hustej konštrukcie (veľa tenkých nosníkov/stĺpikov/prvkov, každý dostal vlastnú čiaru) bola čiara stále vizuálne neprehľadná, čo je architektonicky "správne" (reálne existujúce prvky), ale prakticky nepoužiteľné bez ďalšieho kroku (napr. vynechanie tenkých konštrukčných kategórií — BEAM/COLUMN/MEMBER — z výpočtu, alebo skutočné 2D hidden-line-removal). **Kód odstránený** (revert v `ifc-viewer.html`), `Clipper` ostáva len ako holý rez bez čiary. Ak sa k tomu bude chcieť Jozef vrátiť, toto je miesto na pokračovanie — dátový zdroj (`model.getItemsGeometry`) aj prienikový algoritmus fungovali správne, len chýba filtrovanie/zjednodušenie pre husté oblasti.
- **Hranové čiary, outline pre každý predmet/objem (2026-09-11, opravené 2026-09-11):** Jozef chcel outline na **úplne každom** predmete (nielen ostré rohy) — okná, zábradlia, rohy stien, panely strechy — s výnimkou plôch tak husto tesselovaných (zaoblenia/oblúky), že by outline nedával zmysel (tie sa preskočia).
  - **KRITICKÝ gotcha — raw mesh geometria nefunguje:** prvý pokus počítal `THREE.EdgesGeometry` priamo z `position`/`index` dát zlúčeného `THREE.Mesh` (per mesh v `model.object`, cez traverse). Vizuálne to vyzeralo OK v testovacom scenári, ale Jozef nahlásil naostro: "hrany tam sú ale neohraničujú objekt, len vytvárajú nejaký nezávislý rám, ktorý tam iba zavádza". **Príčina:** Fragments zlučuje množstvo IFC položiek do jedného `THREE.Mesh` (typicky ~90-115 meshov na model s ~2000+ IFC položkami) a skutočnú pozíciu/rotáciu/mierku každej položky aplikuje až v **custom vertex shaderi cez `material.onBeforeCompile`** (material je navonok bežný `MeshLambertMaterial`, `isShaderMaterial=false`, ale `onBeforeCompile` je nastavený; geometria má extra atribúty `id`+`color` použité v tom shaderi na per-instance transformáciu). Surové `position` dáta v mesh geometrii sú teda v **"šablónovom" priestore pred touto transformáciou** — `EdgesGeometry` z nich vypočíta topologicky správne, ale priestorovo nezmyselné hrany.
  - **Správne riešenie:** `await model.getItemsIdsWithGeometry()` → `await model.getItemsGeometry(ids)` — vráti pre každé `localId` pole kusov `{positions, indices, normals, transform, representationId}` (rovnaký zdroj dát, čo interne používa aj knižnicou postavený "hidden line drawing" nástroj — trieda s `addEdges`/`getGroupData`/`visibleEdges`/`hiddenEdges` v `@thatopen/components`, určená na generovanie 2D výkresov, príliš ťažká pre tento účel, ale potvrdzuje správny dátový zdroj). Pre každý kus: postaviť čistú `THREE.BufferGeometry` z `positions`/`indices`, spočítať `EdgesGeometry(g, 1)` (**1° prah** — nie 25°, aby sa zachytila každá zmena plochy, nielen ostré rohy), až **potom** `eg.applyMatrix4(piece.transform)` (transformácia sa aplikuje na hotovú EdgesGeometry, nie na vstupnú geometriu pred výpočtom hrán — poradie nezáleží topologicky, ale takto sa transform aplikuje len raz na menší výsledný dátový set), pridať ako `THREE.LineSegments` priamo do `model.object` (nie ako child konkrétneho mesh-u — položka nemá vlastný mesh).
  - **Density cap** (`EDGE_DENSITY_CAP = 4000` segmentov na kus): pri 1° prahu husto tesselované zaoblené plochy vyprodukujú tisíce mikroskopických hrán — ak `eg.attributes.position.count / 2` prekročí limit, kus sa preskočí celý (žiadny outline pre tú položku), namiesto zobrazenia vizuálneho chaosu.
  - **Z-fighting (blikanie/miznutie čiar podľa uhla kamery na reálnom GPU — headless test prostredie ho nezachytáva spoľahlivo):** čiary ležia presne na povrchu geometrie → `polygonOffset=true, polygonOffsetFactor=1, polygonOffsetUnits=1` na materiáloch všetkých meshov (traverse `model.object`, nastaviť pred pridaním hrán) posunie plochy v hĺbkovom bufferi mierne dozadu, aby čiary vždy vyhrali.
  - Farba/opacity: `#1a1614` (tmavšia než pôvodná `#2c2825`) @ 0.6 opacity (pôvodná 0.35 bola v praxi na reálnom displeji takmer nebadateľná, hoci v headless screenshotoch vyzerala dostatočne viditeľná — **headless/screenshotový test nie je spoľahlivý proxy pre reálnu viditeľnosť na GPU**, treba nechať reálne overiť).
- **Vrstvy (IFC kategórie):** `classifier.byCategory({models:[model]})` (**pozor** — parameter je `{models:[...]}`, nie holý model) len zaregistruje dopyt (`classifier.list.get('Categories')` dá zoznam názvov kategórií, napr. `IFCWALL`, `IFCROOF`, `IFCDOOR`...), samotné položky sa vyhodnotia až lenivo — treba zavolať `classifier.getGroupData('Categories', kategoria).get()` (async), výsledok (`{modelId: [itemIds]}`) sa až potom pošle do `hider.set(visible, resolvedMap)`. Priame čítanie `.map` na `getGroupData()` výsledku vracia vždy prázdny objekt — `.map` je len interný placeholder, reálne dáta sú za `.get()`.
- **Geometria dotečie asynchrónne** — `model.object.children.length` je hneď po `ifcLoader.load()` stále `0` (Fragments worker posiela mesh dáta postupne cez `postMessage`), treba počkať (pollovať kým sa počet detí ustáli) pred výpočtom bounding boxu a nastavením kamery (`world.camera.controls.setLookAt(...)` na roh bounding boxu — natívne `world.camera.fitToItems()` existuje tiež, ale bbox prístup bol prakticky overený a ostal).
- **Gotcha — API metódy sa medzi verziami knižnice líšia od dokumentácie**, dokumentáciu treba brať len ako orientačnú, reálne mená metód si overiť priamo na nainštalovanej verzii (`Object.getOwnPropertyNames(Object.getPrototypeOf(instance))`), prípadne priamo v minifikovanom source `+esm` bundle (`grep` na názov metódy). Príklady rozdielov oproti dokumentácii nájdeným pri implementácii: `Classifier.getGroupData()` nie je `async` a nevracia dáta priamo (vracia objekt s `.get()`), `Camera.fitToItems` (nie `.fit()`), `Hider.set(visible, map)` očakáva `map` ako `Object.entries()`-ovateľný objekt `{modelId: iterable}`.
- Testované mimo tejto appky — headless Chrome cez `puppeteer-core` (nainštalovaný ad-hoc, nie súčasť repa) ovládajúci lokálne nainštalovaný Chrome, keďže Chrome DevTools MCP nebol v danej session k dispozícii; skript s `page.on('console'/'pageerror'/'response')` + `page.screenshot()` na vizuálne overenie (skryté kategórie/rezy sa dajú overiť len vizuálne, nie len absenciou JS chýb).

**Apps Script — `akcia_findIfcFile`** (`Code.gs`, vzor `akcia_findKoordinaciaFolder`): nájde koreňový priečinok projektu (rovnaká prefix-zhoda `20YY-NNN`), v ňom `20_KOORDINACIA/ARCHITEKTURA`, najnovšie upravený `.ifc` súbor, nastaví zdieľanie, vráti `{fileId, name}`. Existujúci `drive` OAuth scope appky (`https://www.googleapis.com/auth/drive`) pokrýva aj `setSharing()`, netreba nový scope ani redeploy s novými permissions (redeploy je ale potrebný pri zmene samotného kódu akcie, ako pri opravách vyššie).

## Other files

### harmonogram-logic.js (ROZPRACOVANÉ — len logika, žiadne UI)

Kapacitné plánovanie interného tímu — rieši "kedy zaradiť čakajúci projekt", keď neviem koho a kedy naň priradiť. Zámerne postavené najprv ako čistá, samostatne testovateľná logika bez DOM/UI (Jozef: "najprv to vyriešme aby to správne fungovalo, potom budeme riešiť zobrazenie") — UI zatiaľ neexistuje, treba doriešiť v ďalšej session.

**Rozsah:** len interný tím (architekti/projektanti), nie externí profesisti — tí majú vlastnú kapacitu/firmu, riešia sa cez `ponuky.html`. Prepojenie na externistov je len cez `podklady_datum` (pozri nižšie).

**Dátový model (`supabase/harmonogram-setup.sql`, tabuľka `harmonogram` — vytvorená v Supabase 2026-07-03):**
```
{ cislo, faza_kod (SZ|DSP/PS|RP|UP|Studia|Inziniering — rovnaký kód ako ponuky.html requests.phases),
  podpodfaza (viď nižšie — príprava pre profesie|koordinácia s profesiami|dopracovanie dokumentácie, null pre Studia/Inziniering),
  projektant, poradie (len na zobrazenie/triedenie, algoritmus ho nepoužíva),
  trvanie_tyzdne (zadáva Jozef/šéf ručne), alokacia_percent (default 100, umožňuje čiastočný úväzok na viacero projektov naraz),
  start_datum (null = nenaplánované), pripravene_pokracovat (default false), najskor_od (manuálny spodný limit štartu),
  prioritny (záväzný termín s klientom), termin_klient, ozvali_sa_datum, poznamka }
```

**Podpodfázy (zdroj: `tabulky/fázovanie projektu.gsheet`, Google Sheet, treba čítať cez Drive MCP — je to cloud-only placeholder súbor, `Read`/`cat`/`Get-Content` naň zlyhajú s "Invalid request code"/"Incorrect function"):** SZ aj PS (a predpokladá sa aj RP, hoci to v tabuľke explicitne nie je) sa delia na 3 podpodfázy, každá sa plánuje ako **samostatný riadok** v `harmonogram`:
1. **príprava pre profesie** — koniec tejto podpodfázy = presne to, čo sa má navrhnúť ako `podklady_datum` v `ponuky.html` (nie začiatok celej fázy, ako bol pôvodný MVP predpoklad)
2. **koordinácia s profesiami** — obdobie, kedy externisti pracujú paralelne s nami
3. **dopracovanie dokumentácie** — po prijatí ich výstupov

Studia a Inžiniering podpodfázy nemajú (`podpodfaza = null`).

**DÔLEŽITÉ — žiadne automatické reťazenie fáz:** pôvodný návrh mal fázu s `poradie=N` automaticky nadväzovať hneď po konci `poradie=N-1` toho istého projektu. Jozef to opravil: v realite skoro nikdy nejde jedna fáza plynulo za druhou — medzi fázami je typicky vonkajší medzikrok (schválenie klientom, čakanie na povolenie/inžiniering...), ktorého dĺžku nevie žiadny algoritmus odhadnúť. Preto: **jediný zdroj "najskôr možného štartu" je `najskor_od`**, ručne zadaný človekom. Prvá fáza projektu (Štúdia) ho typicky nemá vyplnený vôbec (nemá na čo čakať), takže sa použije len dnešný dátum.

**Dva nezávislé vstupy pre naplánovanie fázy** (Jozef): (1) kapacita — kedy má daný projektant voľno, (2) pripravenosť projektu — či je vôbec odblokovaný na pokračovanie (klient schválil, povolenie prišlo). Kým `pripravene_pokracovat !== true`, fáza sa **vôbec neplánuje** — ostáva bokom medzi čakajúcimi, aj keby mal projektant kapacitu voľnú. Toto rieši prípad "čakáme na klienta/povolenie, netušíme presný dátum" — bez tohto príznaku by prázdny `najskor_od` znamenal "môže začať dnes", čo by bolo pre nepripravený projekt nesprávne.

**Algoritmus (`harmonogram-logic.js`, exportuje cez `module.exports` aj pre `<script>` global):**
- `harmJeKapacitaVolna` — pre daného projektanta a interval kontroluje, či súčet `alokacia_percent` prekrývajúcich sa priradení + nová alokácia nepresiahne 100 %
- `harmNajdiNajskorsiStart` — posúva kandidátsky dátum po dňoch (strop 2 roky dopredu), kým nenájde voľné okno na celú dobu trvania
- `harmNajskorMoznyStart(priradenie, dnes)` — vráti `max(dnes, priradenie.najskor_od)` — žiadne reťazenie na predchádzajúcu fázu
- `harmZoradPodlaPriority` — `prioritny` projekty prv (podľa `termin_klient` ASC), inak podľa `created_at`
- `harmNaplanujFrontu(nenaplanovane, existujuceNaplanovane, dnes, maxPercent)` — hlavná funkcia; najprv rozdelí vstup na `pripravene`/`nepripravene` podľa `pripravene_pokracovat`, plánuje len pripravené (v poradí priority, každé naplánované priradenie sa hneď "commitne" do kontextu pre ďalšie v poradí — greedy, nie globálne optimálne, ale zodpovedá tomu, ako by to robil človek ručne), nepripravené vráti s `navrhovany_start/koniec = null`
- `harmNavrhniPodkladyDatum(harmonogramZaznam)` — vráti `koniec_datum`/`navrhovany_koniec` LEN ak `podpodfaza === 'príprava pre profesie'`, inak `null` (spresnené z pôvodného MVP predpokladu "začiatok celej fázy")
- `harmNajdiNavrhyPreDopyty(harmonogramZaznamy, requests)` — prepojenie na `ponuky.html`: keď sa naplánuje/dokončí "príprava pre profesie", navrhne `podklady_datum` pre dopyty rovnakého `cislo`+`faza_kod`, **nikdy neprepíše už ručne zadaný `podklady_datum`**

**Overené testom** (`scratchpad/test-harmonogram.js`, nekomitnuté, len na overenie): 3 projektanti, prekrývajúce sa čiastočné alokácie, poradie fáz v rámci projektu, priorita, aj prepojenie na `ponuky.html` — všetky kontroly OK vrátane exhaustívnej kontroly, že nikto nikdy nepresiahne 100 % v žiadnom dni.

**Prepojenie na Caflou úlohy (Jozef, rozhodnuté, zatiaľ neimplementované):** každý riadok harmonogramu sa má naviazať na konkrétnu Caflou úlohu (`caflou_task_id`, pole pripravené v schéme) — existujúcu, alebo sa má vytvoriť nová. Projektant tak uvidí svoju prácu bežne v Caflou, nie len v samostatnom harmonograme. Dátum úlohy (`end_time`) by sa mal držať v súlade s `navrhovany_koniec`/`koniec_datum` (rovnaký vzor ako `bulkSetDeadline`). **Dôvod, prečo sa napriek tomu nesynchronizuje aktuálna záťaž tímu automaticky z Caflou úloh:** Caflou úlohy nemajú štruktúrovaný odhad trvania/alokácie per fáza — len priradenie + termín. Aktuálnu záťaž (čo tím robí PRÁVE TERAZ) treba na začiatku ručne zapísať do `harmonogram` (rovnako ako čakajúce projekty), inak by algoritmus považoval každého za voľného od dneška.

**Napojenie na Supabase (`harmonogram-data.js`, HOTOVO 2026-07-03):** dátová vrstva nad `harmonogram-logic.js` — rovnaký dual export (module.exports aj `<script>` global, v prehliadači očakáva funkcie logiky na `window`). Kľúčové funkcie:
- `harmFetchAll(sb)` — načíta celú tabuľku, konvertuje stringové dátumy na `Date`, dopočíta `koniec_datum` zo `start_datum + trvanie_tyzdne` (tabuľka koniec neukladá)
- `harmSpustiPlanovanie(sb, {dnes, maxPercent})` — kompletný beh: fetch → `harmNaplanujFrontu` nad nenaplánovanými (`start_datum IS NULL`) → zapíše `start_datum` novonaplánovaným → `harmNajdiNavrhyPreDopyty` nad `requests` súvisiacich projektov. Vracia `{vysledky, pocetZapisanych, navrhyPodklady}`
- Návrhy `podklady_datum` sa LEN vracajú, do `requests` sa nezapisujú (rozhodnuté — čaká na UI so schvaľovaním)
- Overené živým testom proti Supabase (insert → plánovanie → kontrola zápisu → cleanup); PostgREST bulk insert vyžaduje rovnaké kľúče vo všetkých objektoch

**UI (`harmonogram.html`, HOTOVO 2026-07-03):** samostatný modul (rozhodnuté — nie rozšírenie index.html), rovnaký vzor ako `ponuky.html`: DM Sans CSS, `module-nav` (linky doplnené do index/ponuky/suhrn), optimistic auth + magic link, Caflou project autocomplete cez `cfg` (`pmCfg3`), `showToast`. Načítava `harmonogram-logic.js` + `harmonogram-data.js` ako `<script>` (v tomto poradí — data vrstva očakáva funkcie logiky na `window`). V `index.html` je okrem module-nav aj **tlačidlo 📅 Harmonogram v hlavičke** vedľa „Ponuky" — Jozef navigáciu hľadá v ikonových tlačidlách vpravo hore, nie v tmavej module-nav lište.

**Supabase Auth URL Configuration (gotcha, vyriešené 2026-07-03):** magic link presmeruje len na adresy v allow-liste — `emailRedirectTo` mimo zoznamu potichu spadne na **Site URL** (bola defaultná `http://localhost:3000` → „Web localhost zamietol pripojenie"). Nastavené v Supabase Dashboard → Authentication → URL Configuration: Site URL = `https://architt-ctrl.github.io/prehladpm/`, Redirect URLs = `https://architt-ctrl.github.io/prehladpm/*` (wildcard pokrýva aj budúce moduly — nový modul teda netreba pridávať). Súvisiace poznatky: cieľ presmerovania sa do linku zapeká pri odoslaní (staré e-maily ostávajú rozbité aj po oprave konfigurácie); vstavaný SMTP má tvrdý rate limit (~pár mailov/hod → „email rate limit exceeded"); session sa zdieľa medzi modulmi cez localStorage (prihlásenie v ponuky.html platí aj pre harmonogram.html); ak link skončí na localhost s `#access_token=...` v URL, session sa dá zachrániť prepísaním origin časti adresy na správnu doménu so zachovaním hashu.
- **Vyťaženie tímu** — týždenná mapa 26 týždňov: bunka = projektant × týždeň, farba podľa súčtu alokácií (0 / <50 / <100 / 100 / >100 červená), tooltip s rozpisom fáz. `HARM_PROJEKTANTI` — hardcoded mená z `CAFLOU_USERS`
- **Naplánované fázy** — zoskupené per projektant, s "voľná plná kapacita od" (max koniec), ✎ edit / ↺ zrušiť naplánovanie (`start_datum = null`) / ✕ vymazať
- **Čakajúce fázy** — dve skupiny: pripravené (zoradené `harmZoradPodlaPriority`) a nepripravené (`harmZoradPodlaOzvani`); tlačidlo ▶/⏸ prepína `pripravene_pokracovat`
- **⚡ Naplánovať čakajúce** — volá `harmSpustiPlanovanie(sb)`, výsledok v modáli: naplánované fázy s termínmi, fázy bez voľného okna, návrhy `podklady_datum` (len na ručný zápis v Ponukách)
- **Modal fázy (prerobený 2026-07-03 podľa Jozefovej spätnej väzby "je to strašne komplikované"):** jeden formulár = jedna fáza. Pri SZ/DSP-PS/RP sa zadávajú **3 bloky naraz** (trvanie + alokácia pre každý; predvolené alokácie 100/40/100 % — počas koordinácie robí projektant len ~40 %, zvyšok kapacity je voľný pre iné projekty). Štúdia/ÚP/Inžiniering majú jedno trvanie. Stav cez rádio: 🔨 už sa robí (dátum „odkedy" ide na 1. blok) / ✅ môže začať / ⏳ čaká (= `pripravene_pokracovat=false`). Dátumy majú popisky ľudskou rečou. Výnimky (najskôr od, priorita+termín, ozvali sa, poznámka) v zbalenom `<details>` „Viac možností". `ozvali_sa_datum` default dnes. `poradie` sa nezadáva (bloky 1/2/3, ostatné 1). Edit existujúceho riadku = jeden blok (`mFPodInfo` ukáže ktorý).
- **Reťazenie blokov VNÚTRI fázy (`harmNaplanujFrontu`):** blok s `poradie>1` začne najskôr po konci všetkých predchádzajúcich blokov tej istej fázy (`cislo`+`faza_kod`); ak predchádzajúci blok nemá koniec (nenaplánovaný/nepripravený), vráti sa s `caka_na_predoslu: true` a neplánuje sa. Zákaz reťazenia MEDZI fázami ostáva. `harmPoradieTiebreak` v `harmZoradPodlaPriority` drží bloky v poradí 1,2,3 pri zhodnom ozvali_sa/created_at (bulk insert)
- **Reálny priebeh pri súbehu prác (`harmSimulujRealne`, 2026-07-03):** trvanie platí pri plnej zadanej alokácii; pri súbehu nad 100 % sa práce spomalia a konce posunú. Poradie nárokov na denných 100 % (Jozef, 2 iterácie spätnej väzby): (1) práce s termínom (`prioritny`) pred bežnými, (2) v rámci skupiny **kto začal skôr, drží tempo** — neskorší berú len zvyšok, (3) rovnaký deň štartu = pomerné delenie („robia sa naraz"). Simulácia po dňoch (effort = trvanie×7×alokácia percento-dní), vracia `{priradenia: [{...,realny_koniec,spomalene}], usage: Map('meno|Y-M-D'→%)}`; trvanie vie odvodiť aj z `koniec_datum` ak `trvanie_tyzdne` chýba
- **Plánovanie do voľných kapacít (Jozef: „voľných 60 % sa vždy využije, práca začne a dokončí sa neskôr"):** plánovač NEČAKÁ na okno, kde sa práca zmestí celá — `naplanujDoVolnychKapacit` (vnútri `harmNaplanujFrontu`) nájde prvý deň s voľnou kapacitou, práca si denne berie `min(alokácia, voľný zvyšok)` a `navrhovany_koniec` = keď vyčerpá effort (`navrhovane_spomalene: true` ak dlhšie než nominál). Skorší začaté práce nikdy nespomalí (berie len zvyšok). **Deň, keď u projektanta štartuje iná práca, sa preskakuje** — pravidlo „rovnaký deň = pomerné delenie" by inak spomalilo existujúcu prácu a prepočet pri ďalšom načítaní by nesedel s plánom (konzistencia overená testom). Reťazenie blokov aj návrhy podkladov používajú reálne konce. UI: `simById` v harmonogram.html — preškrtnutý nominálny koniec + oranžové „reálne {datum}", badge „spomalené — súbeh prác", výsledkový modal poznámka „(beží popri inom, preto dlhšie)", timeline bunky s dopytom nad 100 % červené. Staré intervalové `harmJeKapacitaVolna`/`harmNajdiNajskorsiStart`/`harmJeKapacitaVolnaDni`/`harmNajdiNajskorsiStartDni` ostávajú exportované, plánovač ich už nepoužíva
- Názvy projektov sa doťahujú z Caflou (`caflouNames`), bez Caflou credentials modul funguje tiež (zobrazí len čísla)

**Nedorobené / ďalší krok:** prepojenie `caflou_task_id` (vytváranie/synchronizácia úloh v Caflou), prepis existujúcich `requests.podklady_datum` návrhom (zatiaľ len navrhuje, nezapisuje), jednorazové ručné zadanie aktuálnej záťaže tímu pred prvým použitím (cez ručný štart v modáli).

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

## Caflou výdavok pri schválení ponuky (HOTOVO, potvrdené 2026-09-11)

**Cieľ:** Pri `selectWinner` v `ponuky.html` automaticky:
1. Priradiť vybraného profesionista k externej úlohe v Caflou (už funguje cez `task_specialists`)
2. Vytvoriť výdavok (náklad) v Caflou napojený na danú úlohu a dodávateľa (= externistu)

**Plán implementácie (4 kroky):**

**Krok 1 — Zistiť Caflou API endpoint pre výdavky (BLOKUJE OSTATNÉ)**
- Treba zachytiť network request (F12 → Network) pri manuálnom vytvorení výdavku v Caflou
- Hľadať `POST` na `/costs`, `/expenses`, `/project-costs` alebo podobné
- Zaznamenať: URL endpoint, štruktúru payloadu (project_id, task_id, amount, company_id, ...)
- Caflou firmy/dodávatelia = existujúce záznamy; treba zistiť aj endpoint pre ich zoznam (napr. `/contacts`, `/companies`)

**Krok 1 — VYRIEŠENÉ (2026-07-03):**

Caflou nazýva výdavky **"transfers"**. Interný web formulár (`https://app.caflou.cz/tornyos/projects/{id}/transfers`, `POST /tornyos/transfers`, param namespace `transfer[...]`) je viazaný na session+CSRF a **nepoužíva sa** — namiesto neho existuje riadny JSON REST resource v tej istej `/api/v1/...` API ako zvyšok integrácie:

- **`GET https://app.caflou.com/api/v1/{account_id}/transfers?project_id={id}&per=N`** — vracia štandardnú stránkovanú štruktúru (`results: [...]`), ale **`project_id` filter sa (rovnako ako pri `/tasks` a `/comments`) ignoruje server-side** (2026-07-14 overené: rôzne `project_id` hodnoty vrátili identický prvý záznam aj identické `total_results`) — treba fetchnúť všetky stránky (`per=100`, cca 15 strán pri ~1500 transferoch) a filtrovať `project_id` klientsky, rovnaký vzor ako `caflou_task_ids` pri taskoch. Pôvodná poznámka „overené, funguje" sa týkala len POST, nie GET filtra.
- Polia záznamu: `id, kind ("expense"), date (YYYY-MM-DD), payment_date, name, value, vat_value, real_value, currency ("EUR"), exchange_rate, user_id, invoiced, done, inactive, description, reference_number, company_id, project_id, task_id, source_id, category_id, repeatable, tags, trash, created_at, url, api_url`
- `company_id` aj `task_id` môžu byť `null` (voliteľné)
**POST (vytvorenie) OTESTOVANÉ 2026-07-03 — funguje, testovací záznam bol hneď zmazaný:**

```javascript
fetch(`https://app.caflou.com/api/v1/${cfg.caflou_id}/transfers`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${cfg.caflou_key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ transfer: {
    kind: 'expense',
    project_id: 533235,
    task_id: null,          // voliteľné
    company_id: 1375565,    // POVINNÉ zadať explicitne, inak Caflou defaultne priradí KLIENTA projektu (zlé!)
    category_id: null,      // voliteľné, zoznam kategórií zatiaľ nezistený
    name: '...',
    value: 123.45,
    currency: 'EUR',
    date: '2026-07-03',     // POVINNÉ (YYYY-MM-DD) — bez neho 422 "Datum splatnosti je povinná položka"
    description: '...'
  }})
})
```

- Telo je **nested pod `transfer:`**, presne ako `{ task: {...} }` pri task PATCH — potvrdzuje vzor zvyšku appky
- Jediné povinné pole pri POST je `date`; všetko ostatné je voliteľné
- **Kritické:** ak sa nepošle `company_id`, Caflou ho automaticky doplní na **klienta projektu**, nie na dodávateľa — treba ho VŽDY explicitne nastaviť na Caflou company_id externistu
- Mazanie: `DELETE /api/v1/{account_id}/transfers/{id}` → `200 {"id": ...}`, overené že záznam potom vracia 404
- `category_id` — zoznam kategórií nákladov zatiaľ nezistený (asi `GET /api/v1/{account}/elements?type=...`, analogicky k `elements?type=ProjectStatus` z network logu). Nie je povinné, netreba pre MVP.

**Krok 2 — HOTOVO (2026-07-03):**
- Caflou firmy = `GET /api/v1/{account}/companies` (336 záznamov), podporuje `filter[search]=` pre live search (rovnaký vzor ako project search)
- SQL migrácia `supabase/caflou-company-setup.sql` — `alter table specialists add column if not exists caflou_company_id bigint;` — **treba spustiť ručne v Supabase SQL Editore**
- `ponuky.html`: v modali profesistu (`#modalSpec`) pribudlo pole "Caflou firma (pre výdavky)" s live-search dropdownom (`searchCaflouCompanies`, `selectCaflouCompany`, debounce 300ms) — rovnaký `.suggest-box` vzor ako pri Caflou projekte
- `openSpecModal` pri edite dotiahne názov firmy cez `GET /api/v1/{account}/companies/{id}` (id je uložené, meno sa nezrkadlí v Supabase)
- `saveSpec()` ukladá `caflou_company_id` (parseInt alebo null)
- Mimochodom opravené: `specialists` select v `loadAll()` nemal `reg` ani teraz pridaný `caflou_company_id` v zozname stĺpcov — bez toho by sa pri opätovnom otvorení edit modálu vždy zobrazovalo prázdne pole reg. čísla
- Pole v UI funguje (potvrdené Jozefom); manuálna zhoda cez `ponuky.html` funguje
- **Hromadné priradenie (2026-07-03):** skúšal som to najprv dorobiť externým Node skriptom cez Supabase REST s anon key — skript nahlásil úspech, ale nič sa reálne neuložilo (RLS na `specialists` očividne blokuje zápis mimo prihlásenej session, anon key na čítanie stačí, na zápis nie). Namiesto toho pribudlo tlačidlo **"🔗 Auto-priradiť Caflou firmy"** v záložke Profesisti (`autoAssignCaflouCompanies`, `normCompanyName`, `fetchAllCaflou` v `ponuky.html`) — beží v prihlásenom prehliadači, takže zápis prejde cez RLS. Zhoda v poradí: e-mail profesistu ↔ Caflou kontakt → jeho `company_id`; presná zhoda normalizovaného názvu firmy; meno profesistu ↔ Caflou kontakt (meno) → `company_id`. Pri teste na 60 profesistoch: 41 cez e-mail, 1 cez meno, 16 bez zhody (firmy v Caflou vôbec neexistujú — overené live-search)

**Krok 3 — HOTOVO (2026-07-03):**
- Suma = `Object.values(qt.prices).reduce((a,b) => a + (Number(b)||0), 0)` — súčet všetkých fáz v `quotes.prices` pre víťaznú invitation

**Krok 4 — HOTOVO (2026-07-03, opravené 2026-07-03):**
- `createCaflouExpense(taskId, companyId, amount, description)` v `ponuky.html` — najprv `GET /tasks/{taskId}` na zistenie `project_id`, potom `POST /transfers` s `{transfer: {kind:'expense', project_id, task_id, company_id, name, value, currency:'EUR', date: dnes}}`
- Volané v `selectWinner` po existujúcej task_specialists/closed logike — **nie úplne fire-and-forget ako pôvodne plánované**: beží asynchrónne bez blokovania UI, ale výsledok sa hlási cez toast (úspech aj neúspech), keďže ide o finančné dáta a tichý fail by bol zavádzajúci
- Ak profesista nemá `caflou_company_id`, výdavok sa nevytvorí a zobrazí sa upozornenie namiesto tichého no-op
- **OPRAVA:** pôvodne sa sčítali všetky fázy z `quotes.prices` do jedného výdavku — nesprávne, Jozef to zachytil pri prvom teste. Teraz sa **pre každú fázu v `prices` vytvára samostatný `transfer`** (`description` obsahuje aj názov fázy), volané sekvenčne v cykle
- **ID výdavkov sa ukladá**: `quotes.caflou_transfer_ids` (jsonb mapa `{faza: transfer_id}`, nie `caflou_transfer_id` bigint ako pôvodne — ten je teraz nepoužívaný pozostatok). SQL `supabase/caflou-transfer-id-setup.sql` — treba spustiť ručne. **Zámerne sa zatiaľ nepoužíva na nič ďalšie** — `cancelWinner` transfer nezmaže, len máme ID pripravené na budúce použitie. Rozhodnuté s Jozefom: túto medzeru zatiaľ neriešiť.

**Stav:** Kroky 1-4 implementované, **živo otestované a potvrdené Jozefom (2026-09-11)** — celý flow (výber víťaza → vznik výdavku v Caflou) funguje.

---

## ROZPRACOVANÉ: Nová štruktúra projektového priečinka

**Kontext:** Súčasná štruktúra v `H:\Spoločné disky\1_PROJEKTY\YYYY-NNN-Nazov\` má fázu ako základ a profesie vnútri (`3-PS/ASR`, `3-PS/statika`...). To fragmentuje prácu jednej profesie naprieč fázami (DUR→PS→RP) a mieša "naše" a "zdieľané s profesistom" súbory v jednom priečinku (starý `profesistom` priečinok). Rieši sa od základu, nie len doladenie.

**Finálny koncept** (zatiaľ len návrh — **nič sa v existujúcich priečinkoch nemenilo**, žiadna migrácia neprebehla):

```
YYYY-NNN-Nazov/
├── 0-PODKLADY/                    spoločné vstupy (klient, geodet) — pred rozdelením na profesie
│   └── geo/ foto/ inz-siete/
├── PROFESIE/                      základ = profesia (aj architekt), fáza vnútri — platí od Štúdie po koniec
│   ├── ARCHITEKT/
│   │   ├── 1-STUDIA/              aktuálny súbor bez dátumu v názve + voliteľný ARCHIV/
│   │   ├── 2-DUR/
│   │   ├── 3-PS/
│   │   ├── 4-RP/
│   │   ├── 7-INZINIERING/
│   │   └── 8-PREZENTACIA/
│   ├── ASR/
│   │   ├── 3-PS/
│   │   │   ├── A-PODKLADY-NACENENIE/     zdieľané s profesistom, link = requests.folder_url
│   │   │   ├── B-PODKLADY-VYPRACOVANIE/  zdieľané, link = folder_url_work (aj ich odovzdaný výsledok sem)
│   │   │   └── C-INTERNE/                NEzdieľané — naša revízia/poznámky
│   │   ├── 4-RP/          rovnaká trojica A/B/C
│   │   └── 7-INZINIERING/ (ak profesia rieši pripomienky)
│   ├── STATIKA/  ZTI/  UK/  ELI/  EHB/  PBS/   rovnaká logika — vytvára sa len fáza, kde reálne pracujú
├── 5-ODOSLANE/                    prierezový výstup — čo odišlo klientovi/úradu, kombinuje viac profesií
├── 6-FINAL-PDF/                   finálny kombinovaný PDF balík danej fázy
└── 9-ARCHIV/                      celý projekt uzavretý
```

Top-level mimo `PROFESIE/` ostáva len to, čo nepatrí jednej disciplíne: `0-PODKLADY` (vstup), `5-ODOSLANE`/`6-FINAL-PDF` (prierezový výstup), `9-ARCHIV` (uzavretie).

**Verzovanie:** namiesto ručných dátumovaných kópií (`2026-07-01-Projekt-1.skp`, `-2.skp`...) sa má spoliehať na natívnu históriu verzií v Shared Drive (pravý klik → Spravovať verzie). Manuálny `ARCHIV/` podpriečinok len pri vedomom odložení starej verzie bokom.

**Zdieľanie s profesistami:** priečinky `A-PODKLADY-NACENENIE` a `B-PODKLADY-VYPRACOVANIE` sú presne tie dva Drive linky, ktoré `ponuky.html` ukladá do `requests.folder_url` / `folder_url_work`. To je jediné, čo profesista vidí — žiadne miešanie s internými súbormi (`C-INTERNE`).

**Otvorené body:**
- `suhrn.html` balík na odoslanie (`buildFolderTree`) dnes očakáva jeden fyzický priečinok stupňa — pri profesijnej štruktúre to neplatí. Zatiaľ sa neriešime (Jozef: "aj tak to nepoužívame, lebo to nefunguje").
- Nápad do budúcna: aplikácia/skript s AI na automatické vytváranie odkazov (shortcuts) na priečinky s PDF pri poskladaní balíka na odoslanie — nerozpracované.
- Migrácia existujúcich ~55 projektov na novú štruktúru sa zatiaľ nerieši.

**Stav:** Koncept uzavretý, čaká na rozhodnutie o migrácii a reálne nasadenie.

**Realita overená naživo (2026-08-28, projekt 2026-026):** nasadená štruktúra je jednoduchšia než pôvodný koncept vyššie — plochá, bez `PROFESIE/`/A-B-C trojice:
```
YYYY-NNN-Nazov/                    (priamy potomok Shared Drive "1_PROJEKTY", id 0AAim-BTmMDGAUk9PVA)
├── 00_RIADENIE/
├── 10_MODEL/
├── 20_KOORDINACIA/                 JEDEN spoločný priečinok pre všetky profesie naraz
│   ├── 00_PODKLADY/
│   ├── ARCHITEKTURA/  ELEKTRO/  STATIKA/  TZB/  ...
├── 30_FAZY/
├── 40_PREZENTACIA/
└── 90_ARCHIV/
```
Rozdiel oproti pôvodnému konceptu: **žiadne A/B/C rozlíšenie nacenenie/vypracovanie/interné** — celý `20_KOORDINACIA` sa zdieľa profesistom ako jeden odkaz (pozri "Dopyty" nižšie, `findKoordinaciaFolder` v Apps Scripte). `requests.folder_url` (nacenenie) a `folder_url_work` (vypracovanie) — dva samostatné odkazy — sú teda relevantné len pre **staršie/ručne vytvorené** dopyty; nové (batch, cez `index.html`) majú jeden spoločný `folder_url`.

---

## ROZPRACOVANÉ: Nacenovanie projektov (cenové ponuky, CP)

**Kontext:** Jozef chce vedieť robiť konkrétne cenové ponuky pre nové projekty na základe podkladov od klienta, zmluvných vzorov a histórie v Caflou. Zatiaľ žiadny nástroj v dashboarde, len postup + jeden rozpracovaný draft ako príklad (`podklady k CP/Navrh_CP_REVIVA.md`, gitignored priečinok — obsahuje citlivé cenové/klientske dáta).

### Zdroj historických CP v Caflou

Cenové ponuky (slovensky "CP", nie subdodávateľské dopyty z `ponuky.html`) sú v Caflou vlastný typ dokladu, nie kombinácia transfers/tasks:

- **`GET /api/v1/{account}/invoices?kind=offer&per=100`** — vráti všetky vystavené CP (2026-07-14: 83 záznamov), číslované `CP-YY-NNN`
- Štruktúra záznamu (rovnaká ako `invoices`, len `kind`/`global_kind` = `"offer"`): `text_before` (voľný HTML text — oslovenie, rozpis rozsahu prác po fázach, spôsob/termín dodania), `text_after` (platobné podmienky, poznámky, podpis), `total_cache`/`vat_cache`/`total_vat_cache`, `invoice_items` (skoro vždy prázdne — cena nie je rozpísaná po položkách, len jedna celková suma za fázu/CP), `project_id`, `to_company_id/name`
- Typický vzor platobných podmienok pri malých/stredných CP (rodinné domy, interiéry): **"50 % pred začatím fázy / 50 % po odovzdaní"**, opakuje sa per fáza
- Pri väčších/komplexnejších CP (napr. `CP-26-016`/`CP-26-015` VITA PARK, 340-350k€) je vzor prepracovanejší: bullet-list "V cene je zahrnuté" per fáza, platba **35 %/35 %/30 %** (pred začatím / po ASR / po odovzdaní), poznámky o vylúčeniach (inžinierska činnosť, geodet, IG/HG prieskum...), explicitná väzba ceny na rozsah AŠ ("ceny platia pri zachovaní rozsahu..."), podpis "Spracoval: Ing. arch. Tomáš Tornyos". **Toto je najbližší štýl. vzor pre väčšie/komplexnejšie CP.**

### Zmluvný rámec — Master_ZoD_architt_2026.docx

`podklady k CP/zmluvy o dielo/Master_ZoD_architt_2026.docx` — univerzálny vzor Zmluvy o dielo pre architektonický ateliér (verzia 2026.1, docx, treba unzipovať a čítať `word/document.xml` — Read tool neotvára `.docx` priamo). Kľúčové pre nacenovanie:

- Čl. VI: **Dielo sa realizuje v etapách**, každá etapa sa samostatne odovzdáva, schvaľuje (čl. XI, 10 prac. dní na pripomienky, inak fikcia akceptácie) aj **fakturuje** (čl. VIII) — Príloha č. 1 definuje rozsah/etapy, Príloha č. 2 cenu a platobné podmienky per etapa
- Čl. VIII: cena je pevná per etapa (pokiaľ nie je dohodnutá hodinovka), **záloha 20–30 %** pred začatím etapy, čiastková fakturácia po odovzdaní/míľnikoch, **splatnosť faktúr 14 dní**, indexácia ceny ak medzi podpisom a fakturáciou etapy uplynie >12 mesiacov
- Čl. IX: zmeny rozsahu = "Dodatočné služby", cena/rozsah/termín sa dohodne osobitne (Change Request); limit kumulatívnych zmien 30 % pôvodnej ceny
- Čl. III 3.2: bežné etapy Diela — AŠ, DÚK/ZON (DÚR), DSP/PSP, RP/DRS, tendrová dokumentácia, AD, DSVS, inžinierska činnosť, BIM — odkaz na **Sadzobník UNIKA** ako referenčný honorárový základ (3.3)

**Praktický dopad na CP:** táto zmluva už počíta s postupným zazmluvňovaním etapa po etape (Príloha č. 1 sa dá na začiatku obmedziť len na prvú etapu, ďalšie sa doplnia dodatkom) — postupné oceňovanie projektu (nižšie) nie je odchýlka od vzoru, len sa využíva táto vlastnosť zmluvy naplno.

### Honorárový benchmark — honorar.sk

`podklady k CP/orientacny vypocet so stranky honorar.pdf` (per-projekt, treba prerobiť na www.honorar.sk pre každý nový projekt) — oficiálna kalkulačka slovenského "Honorárového poriadku": vstup = **započítateľné náklady stavby** (odhad) + **honorárová zóna** (I.–V. podľa náročnosti, investor si ju spravidla určuje sám) + prípadné prirážky (modernizácia +10 %, rekonštrukcia +20 %, kultúrna pamiatka +30 %). Výstup = % z nákladov rozpísané po fázach (Prípravná 1+1 %, Návrhová 13 %, Územné konanie 15+2 %, Stavebné konanie 23+2 %, Výber zhotoviteľa 5+1 %, Realizačná-RP 28+1 %, Realizačná-spolupráca výber 1 %, Realizačná-spolupráca výstavba 6+1 %; prvé číslo = základné/projektové výkony, druhé = manažérske služby). Tento honorár pokrýva **celý multiprofesijný honorár** (architekt + subdodávané profesie dokopy, nie len architektonickú časť — čl. 3.3 Master ZoD naň odkazuje ako na "honorár za projektové práce a inžinierske činnosti").

### Rozdelenie honoráru medzi profesie (per-item cenník)

Keď treba CP rozpísať po jednotlivých profesiách (nie jedna lump suma za fázu ako VITA PARK, ale itemizovaný výkaz ako `PR 04 ORIENTACNY VYKAZ VYMER.xlsx` pri type projektu REVIVA), nemáme (zatiaľ) spoľahlivý zdroj reálnych historických cien per profesia:

- **Caflou `transfers` (výdavky) nie sú dobrý zdroj naprieč projektmi** — `project_id` filter na `GET /transfers` sa ignoruje server-side (viď oprava vyššie), treba fetchnúť všetkých ~1500 záznamov a filtrovať klientsky; navyše nové/rozbehnuté projekty (napr. VITA PARK, `project_id=576860`) môžu mať v Caflou **nula** transferov, ak sa CP ešte len rieši a subdodávatelia neboli zazmluvnení/fakturovaní
- **`ponuky.html` Supabase `quotes.prices`** (jsonb `{fáza: suma}` od skutočných profesistov) je principiálne najlepší zdroj skutočných trhových cien per profesia+fáza, ale zatiaľ nebolo preverené naprieč historickými dopytmi pri veľkom projekte podobnom REVIVA — treba doriešiť v ďalšej session, ak bude treba presnejšie čísla než hrubý odhad
- **Dočasné riešenie (draft REVIVA, 2026-07-14):** honorár.sk % súčet per fáza sa rozdelí medzi položky podľa **typických odborových pomerov** (architektúra ~38 %, statika ~14 %, TZB profesie spolu ~26 %, PO ~9 %, ostatné ~13 %) — toto sú všeobecné znalosti, **nie** dáta z Caflou/Supabase tejto firmy, treba označiť ako hrubý odhad a nechať Jozefa poopraviť podľa reálnych cien od jeho subdodávateľov

### Filozofia postupného oceňovania (Jozef, 2026-07-14, kľúčová spätná väzba)

Neoceňovať a nezazmluvňovať veľký viacfázový projekt (DÚR+DSP a ďalej) naraz vopred — pri projektoch typu nadstavba/rekonštrukcia existujúcej budovy (napr. REVIVA: nadstavba +3 podlažia = 2× pôvodné zaťaženie na existujúci skelet) reálne hrozí, že sa **prieskumy ukážu, že zámer vôbec nedáva zmysel** (doprava lokalitu nezvládne, existujúci skelet/základy neunesú nadstavbu) — vtedy je zbytočné mať vopred spočítanú a ponúknutú cenu na DÚR/DSP za stovky tisíc eur.

**Namiesto toho — postupné zadávanie po etapách, cena sa rieši len pre najbližšiu etapu:**
1. **Zásadné/vylučovacie prieskumy** — tie, ktorých negatívny výsledok môže projekt úplne zastaviť (pri REVIVA: diagnostika nosných konštrukcií, dopravno-kapacitné posúdenie). Cenia a zazmluvňujú sa **prvé, samostatne**.
2. **Ostatné prípravné práce** — potrebné pre DÚR/DSP, ale ich výsledok projekt zásadne neohrozí (pri REVIVA: svetlotechnika, hluková štúdia, IGP prieskum). Cenia sa tiež hneď, ale **štartujú až po vyhodnotení bodu 1**.
3. **DÚR** — cení sa (podľa honorár.sk princípov v danom čase) až po vyhodnotení 1+2, keď je jasné že zámer je realizovateľný.
4. **DSP** — cení sa až po DÚR.

Súčty za DÚR/DSP sa do CP môžu uviesť len ako **orientačný rozsah pre klienta** (aby vedel rádovo o akých číslach sa bavíme), nie ako záväzná/ponúkaná cena, kým sa k danej etape reálne nedôjde.

**Korekcia (2026-07-16):** v praxi sa Jozef pri REVIVA napokon rozhodol pre **jednu súhrnnú % cenu voči klientovi** (3 % z celkových investičných nákladov, zahŕňa predprojektovú prípravu + DÚR + DSP naraz — pozri nižšie), nie postupné oceňovanie len najbližšej etapy. **Poradie prác (zásadné prieskumy prvé) ostáva zachované operačne/pri fakturácii** (odporúčanie: fakturovať postupne v tomto poradí, aj keď je cena navonok jedno číslo) — mení sa len to, že klient dostane rovno celkový rámec, nie čakanie na cenu po každej etape. T.j. postupné oceňovanie z predchádzajúceho odseku bol pôvodný návrh/default, reálne rozhodnutie na konkrétnom projekte môže byť iné (bundled % namiesto stage-by-stage) — netreba to brať ako rigidné pravidlo, len ako jednu z možností na zváženie per projekt.

### Stanovenie predbežného investičného nákladu (vstup pre honorár.sk)

Bežné metódy na úrovni architektonickej štúdie (keď ešte nie je výkaz výmer/rozpočet):
1. **€/m³ obostavaného priestoru (OP)** — klasický rozpočtový ukazovateľ podľa typu/štandardu stavby (ÚRS/RTS tabuľky, treba aktualizovať o index cien stavebných prác)
2. **€/m² hrubej podlažnej plochy (HPP)** — dnes bežnejšie než m³; orientačne (SR, 2026): RD štandard 1 200–1 600, RD vyšší štandard 1 800–2 500+, bytový dom 1 400–2 000, polyfunkcia/administratíva 1 600–2 500+, priemyselná hala 500–900 €/m². Presnejšie sú vlastné realizované referencie firmy než všeobecné tabuľky.
3. **Porovnávacia (analogická) metóda** — z 1-2 nedávnych porovnateľných realizácií, prepočítané o index a rozdiely v štandarde/lokalite; vhodné pri netypických stavbách, kde tabuľky nesedia (napr. nadstavba nad existujúcim objektom).
4. **Objektová skladba** — pri väčších/komplexnejších stavbách rozdeliť na SO (hlavný objekt, spevnené plochy, prípojky, oporné múry...) a každý oceniť vlastným ukazovateľom, súčet = celkový náklad. Presnejšie než jedno číslo na celú stavbu.

**Pri rekonštrukcii/nadstavbe** (ako REVIVA): búracie práce sa oceňujú samostatne; nadstavba/vstavba do existujúceho objektu má spravidla **vyššiu** jednotkovú cenu než novostavba rovnakého typu (komplikovanejšia logistika, napojenie na existujúci skelet) — bežne +15–30 %.

**Presnosť podľa stupňa dokumentácie** (dobré komunikovať aj klientovi): architektonická štúdia ±25–35 %, DÚR ±20–25 %, DSP ±15 %, RP+rozpočet ±5–10 %. Toto je hlavný dôvod, prečo nemá zmysel záväzne oceňovať DÚR/DSP na základe čísla so štúdiovou presnosťou.

**Dôležitá nuansa — čo NIE JE v €/m² ceny budovy:** jednotkový ukazovateľ (m²/m³) pokrýva len samotný hlavný objekt. **Parkoviská/spevnené plochy a oporné múry sú samostatné SO**, treba ich oceniť vlastným ukazovateľom (spevnené plochy: €/m² podľa typu povrchu a dopravného zaťaženia, orientačne 60–220 €/m² pri parkovisku/obslužnej komunikácii; oporné múry: €/m² pohľadovej plochy, prudko rastie s výškou, pri múre okolo 5 m orientačne 700–1200+ €/m² kvôli hrubšiemu prierezu/väčšej pätke/prípadnému kotveniu — závisí od geológie z IGP) a **pripočítať ich zvlášť k cene budovy**. Do honorárového základu ("započítateľné náklady") ale napriek tomu patria, ak sú v rozsahu architektovej zákazky — definícia honorár.sk explicitne hovorí "...vrátane exteriérov".

**REVIVA konkrétne čísla (2026-07-16):** budova + parkoviská/obslužná komunikácia (~4 713 m²) + hlavný oporný múr (55×5 m) → **celkový investičný náklad prepočítaný na 16,3 mil. €** (pôvodný honorár.sk PDF bol robený pri 10 mil., treba prerobiť). Na tomto základe dohodnuté **3 % = 491 000 €** za predprojektovú prípravu + DÚR + DSP spolu, rozpísané do `PR 04 ORIENTACNY VYKAZ VYMER - vyplnene.xlsx` (17 000 € prieskumy + 474 000 € DÚR/DSP profesie, pomer profesií = rovnaký hrubý odhad ako v predchádzajúcom odseku).

### Technická poznámka — úprava .xlsx bez knižníc

Toto prostredie nemá Python ani žiadny `xlsx`/zip balík pre Node, a Bash má len `unzip` (nie `zip`). Postup na vyplnenie `PR 04...xlsx`:
1. `unzip` súboru → nájsť `xl/worksheets/sheet1.xml`, cieľové bunky sú self-closing (`<c r="C5" s="8"/>`) → nahradiť za `<c r="C5" s="8"><v>5500</v></c>`; ak stĺpec má súčtový `<f>SUM(...)</f><v>0</v>`, aktualizovať aj cachovanú `<v>` hodnotu (Excel ju pri otvorení prepočíta, ale je dobré mať konzistentné aj bez prepočtu)
2. **Nepoužívať PowerShell `Compress-Archive`** na spätné zabalenie — vytvára cesty so spätnými lomkami (`docProps\app.xml`), OOXML/Excel vyžaduje `/`, hrozí "repair" chyba pri otvorení
3. Vlastný minimalistický ZIP writer v Node (`store`/bez kompresie, `zlib.crc32()` je v Node 24 zabudované) — funguje spoľahlivo, overené round-trip testom (rozbaliť späť a skontrolovať hodnoty/SUM vzorce)

**Stav:** Postup zdokumentovaný, jeden rozpracovaný príklad (REVIVA) v `podklady k CP/Navrh_CP_REVIVA.md` + vyplnený `PR 04...vyplnene.xlsx`. Žiadny nástroj v dashboarde zatiaľ nevzniká — zatiaľ manuálny proces (Claude pripraví draft na základe podkladov, Jozef doladí a ručne vloží do Caflou ako `offer`). Nedorobené: presnejší zdroj per-profesijných cien (`ponuky.html` quotes.prices?), honorár.sk PDF prerobiť na 16,3 mil. €, rozhodnutie či/ako toto zautomatizovať v dashboarde (pozri skorší koncept "nástroj na tvorbu CP" v histórii konverzácie — Caflou historické CP ako referencia + Gemini draft).

---

## Kontakt na zodpovedného projektanta v portáli profesistov (HOTOVO, 2026-08-28)

**Požiadavka (Jozef):** systém ponúk pre profesistov má fungovať tak, že Jozef ho nastavuje sám (zakladá dopyty), bez toho aby profesisti museli niekde vypĺňať niečo navyše — ale zároveň chce, aby sa profesisti vedeli sami prihlásiť do portálu, videli tam aktuálne voľné zákazky a mohli dať ponuku, a pri už dohodnutých zákazkách videli zoznam s odkazmi na podklady, **kontaktom na nášho projektanta/architekta, ktorý má daný projekt na starosti**, a dátumami.

**Zdroj kontaktu — Caflou úloha "Príprava ASR":** každý projekt v projekčnej fáze má internú Caflou úlohu, ktorej názov **obsahuje** (nie presne rovná sa — historicky existujú varianty ako "Príprava ASR_rekonštrukcia") reťazec "príprava ASR" (case-insensitive). Jej `target_user_id` = zodpovedný projektant. Email sa ťahá priamo z Caflou (`GET /api/v1/{account}/users` — vracia aj pre interný tím email, na rozdiel od doteraz ručne udržiavanej `CAFLOU_USERS` mapy, ktorá má len mená; telefón Caflou nevracia).

**`index.html` — `syncResponsibleContacts()`:** fire-and-forget na konci `syncData()`. `fetchCaflouUsers()` načíta `{id: {name, email}}` raz za session. Postaví `projByTaskId` mapu (rovnaký vzor ako `openVytazenieModal`), paginovane prejde všetky Caflou úlohy, pre zhodu s "príprava asr" v názve vezme `target_user_id` → email, a upsertne do Supabase `project_contacts (cislo, name, email, updated_at)` — SQL: `supabase/project-contacts-setup.sql`. Toto je nutné, lebo `portal.html` nemá (a nesmie mať) Caflou API kľúč.

**`portal.html`:** kontakt sa zobrazuje **len pri `selected` (už dohodnutých) dopytoch**, vedľa termínov podkladov — v móde 1 (`renderStatus`, dotiahne sa cez `sb.from('project_contacts')` priamo v `init()`) aj v móde 2 (`renderReqCard`, batch-loadnuté v `initSpecialistView` pre všetky projekty s aspoň jednou `selected` invitation, uložené v `_specCtx.contacts`).

---

## Priebeh projekcie — procesná mapa (2026-09-01)

Jozef si postupným, viackolovým dopĺňaním (nie naraz — po malých krokoch, s priebežnými opravami) vydiktoval detailný priebeh toho, čo sa reálne deje medzi schválením štúdie a podaním žiadosti o stavebný zámer, plus samostatný klientský sprievodca celým procesom. Vznikli dva dokumenty:

1. **Klientský sprievodca "Od nápadu po kolaudáciu"** — 9-krokový proces pre klienta stavajúceho rodinný dom, postavený na aktuálnom zákone č. 25/2025 Z. z. o výstavbe (účinný od 1. 4. 2025) — ten nahradil bývalé samostatné územné rozhodnutie a stavebné povolenie jediným **rozhodnutím o stavebnom zámere**, po ktorom nasleduje ešte úradné **overenie projektu stavby** (30 dní zo zákona, výsledok = overovacia doložka, bez ktorej sa nesmie legálne začať stavať). Existuje len ako **Claude Artifact** (hosted na claude.ai, **nie je committed ako súbor v repe**).
2. **Interný pracovný prehľad "Priebeh projekcie"** — pôvodne 3-stranová A4 procesná mapa (Claude Artifact, tlačiteľná, so schémami a farebným rozlíšením kto čo robí), obsahovo zhrnutá aj do súboru `priebeh-projekcie.md` v repe (bez schém, len text/markdown).

**Kľúčové poznatky zachytené v internom prehľade (užitočné aj mimo dokumentu samotného, napr. pre budúce prepojenie s `harmonogram.html` alebo `ponuky.html`):**

- **Pred štúdiou:** geodetické zameranie + ÚPI/regulatívy lokality (predpoklad na spustenie). **Počas štúdie súbežne:** vyjadrenia správcov sietí k existencii sietí (rieši externá inžinierska firma, nie Projekcia). Dozameranie je priebežná vec podľa potreby (napr. zistí sa nutnosť vjazdu), nie jednorazový krok.
- **Spustenie projekcie — opravené poradie oproti pôvodnému predpokladu:** Štúdia schválená → **Dopyty** (ponuky na profesie) → z cien z dopytov sa až potom zostaví **CP pre investora** → schválenie CP je reálny spúšťač štartu projekcie. (Dopyty teda nie sú dôsledok schválenej CP, ale naopak.)
- **4 súbežné vetvy po štarte projekcie:** HGP/IGP, plyn (SPPD, pripája sa len ~5 % projektov), voda (StVPS), elektrina (SSD/VSD). Posledné tri majú vlastný reťazec končiaci "určením rozsahu vytýčenia", ktoré rieši spoločný **mechanizmus vytýčenia**: Projekcia určí rozsah a požiadavku → externá inžinierska firma objedná fyzické vytýčenie u správcu siete → zavolá geodeta na zameranie → výsledok späť Projekcii.
- **"Inžiniering" nie je interné oddelenie architt** — je to vždy samostatná externá inžinierska firma. Rozdiel je len v tom, kto ju najíma: buď architt (keď je Inžiniering súčasťou kontraktu s investorom), alebo priamo investor sám.
- **HGP** — dôvody: dažďové vody (keď ich kanalizácia ani Slovenský vodohospodársky podnik/recipient nevie prevziať) a studňa. Rozhodovací strom podľa podložia: dobré → vsakovací objekt / slabé → akumulačná nádrž s vírovým ventilom do vsaku / nemožné → akumulácia a odvoz cisternami. **IGP** — okrem základov objektu aj skladba/hĺbka založenia cestnej komunikácie a parkoviska.
- **ASR beží ako nezávislý súbežný prúd** s obojsmernou väzbou voči všetkým napojeným profesiám (PBS, statika, UK, VZT, ELI) — dáva im podklady, dostáva späť ich požiadavky, nie je to jednorazový krok pred nimi.
- **PBS aj statika majú dva dotyky s procesom:** (1) prvotná konzultácia ešte pred ASR, pripomienky sa zapracujú do ASR; (2) PBS dostane kompletnú situáciu (architektúra + doprava) na dopracovanie, statika dostane ASR znova, nezávisle od ostatných profesií, a pre stupeň stavebného zámeru vypracuje **len správu** (nie plný posudok — ten až v ďalšom stupni).
- **Vnútorné ZTI sa v stupni stavebného zámeru vôbec nerieši** — presúva sa celé do ďalšieho stupňa (Projekt stavby).
- **Doprava sa rieši od začiatku**, nie dodatočne — určuje osadenie objektov architektúry. V štúdii ju koncepčne rieši architekt sám (profesia dopravy tam ešte nie je), v projekcii preberá profesista dopravy, ktorý spresní výšky. Je podklad pre PBS, vonkajšie ZTI aj návrh prípojok/distribučných vedení — tie realizuje investor na vlastné náklady a dodatočne sa prevedú na správcov sietí.
- **Zbiehanie:** zameraná vytýčená sieť + technické podmienky od distribučky (StVPS/SPPD/SSD-VSD) + doprava → dokumentácia jednotlivých prípojok (voda/kanál/elektrika/plyn), robí príslušná profesia.
- **Uzáver PD:** keď sú hotové vonkajšie siete od všetkých profesií + doprava + PBS + správa statika → aktualizuje sa koordinačná situácia na finálnu verziu → vypracuje sa súhrnná správa (rovnaký koncept ako existujúca funkcia "B – Súhrnná správa" v `suhrn.html`) → tým sa uzatvára vypracovanie PD pre stavebný zámer.
- **Zoznam dotknutých orgánov a právnických osôb** (orientačný, treba overovať per projekt — pozri artifact): OÚ životné prostredie, OR HaZZ (hasiči), RÚVZ (hygiena), krajský pamiatkový úrad, dopravný inšpektorát, pozemkové a lesné oddelenie, orgán ochrany prírody, Slovenský vodohospodársky podnik (recipient/záplavové územie/vodné stavby ako vsak či ČOV), obec (súlad s ÚP); správcovia sietí (voda, elektrina, plyn, telekomunikácie). Ak je niektoré stanovisko záporné/s pripomienkami, zapracujú sa do PD a žiada sa znova.
- **Po podaní žiadosti:** správne konanie → rozhodnutie o stavebnom zámere (platí 2 roky) → ďalší stupeň **Projekt stavby**, kde sa dorábajú vnútorné siete (ZTI, ELI, VZT, UK, SLP), plný statický výpočet + realizačný návrh nosných konštrukcií a ASR vo väčšom detaile/mierke → overenie projektu (30 dní zo zákona) → overovacia doložka (platí, ak sa začne stavať do 2 rokov od vydania).

**Stav:** oba dokumenty existujú len ako Artifacts, nie sú premietnuté do žiadnej funkcie dashboardu. Potenciálne budúce prepojenia: `harmonogram.html` podpodfázy (najmä "príprava pre profesie"), presné načasovanie spúšťača Dopytov v `ponuky.html`/`index.html` (Dopyty idú hneď po schválení štúdie, nie po CP), prípadne rozšírenie zoznamu dotknutých orgánov ako súčasť Dopytov/checklistov v dashboarde. Nič z toho zatiaľ nebolo rozhodnuté ani implementované.

---

## NÁPAD: Schválenie kľúčových podkladov investorom pred odovzdaním profesistom (2026-09-11, nerozhodnuté)

**Kontext, v ktorom vznikol:** diskusia o tom, že profesisti chcú mať v Dopytoch/portáli lepší prehľad, kedy dostanú zaplatené — vyplynulo z reálneho zaseknutého projektu, kde je práca dávno hotová a odovzdaná, ale investor má stále výhrady a nechce prevziať/zaplatiť, takže firma nemá z čoho platiť profesie. Termín platby sa **rozhodlo neriešiť ako dátum** (Jozef: "tie úhrady neriešme, nám stačí že máme termín na odovzdanie a z toho sa dá odvodiť aj fakturovanie") — namiesto toho vznikla táto širšia myšlienka priamo od Jozefa, zatiaľ len na premyslenie pre šéfa, nič nerozhodnuté ani neimplementované.

**Nápad:** presne v momente, keď sa štúdia schváli a spúšťajú sa Dopyty pre profesie (existujúci bod, pozri "Priebeh projekcie" vyššie — "Štúdia schválená → Dopyty"), by mal investor **formálne schváliť kľúčové/podstatné veci týkajúce sa stavby** predtým, než tieto podklady dostanú profesisti do rúk. Tým sa vytvorí pevný základ, ktorý investor nemôže dodatočne ľubovoľne meniť. Súčasne by mal byť investor jasne informovaný, že **akákoľvek zmena podkladov po začatí projekcie bude spoplatnená navyše** — čo v podstate len robí viditeľným mechanizmus, ktorý ZoD (Master_ZoD_architt_2026.docx) už má v čl. IX ako "Dodatočné služby"/Change Request, len sa v praxi zatiaľ takto viditeľne pri odovzdávaní nepoužíva. K tomu by mal investor dostať aj **vlastný jasný termín**, kedy mu bude projekt odovzdaný a fakturovaný, s konkrétnou splatnosťou faktúry — teda rovnaká transparentnosť, akú by mali dostať profesisti, len na strane klienta.

**Dôležité obmedzenie:** toto rieši len projekty, kde má architt **priamu ZoD s investorom**. Na projekty, kde je architt subdodávateľ inej firmy/architekta (napr. konkrétny zaseknutý prípad vyššie — architt je subdodávateľ pre "šéfovho kamaráta", nemá priamy vzťah s investorom vôbec) sa táto páka nedá použiť priamo — tam by riešenie muselo ísť cez zmluvný vzťah kamarát↔investor, mimo dosahu architt.

**Riziko, na ktoré Claude upozornil:** ak investor schválenie kľúčových podkladov naťahuje/odflákne, presúva sa tým rovnaký problém (čakanie na investora) len o krok skôr v procese. Aby to nefungovalo kontraproduktívne, schválenie by malo byť rýchle a ľahké (napr. jeden mail/podpis k pár bodom), nie ďalší byrokratický krok.

**Stav:** len nápad na premyslenie, čaká sa na rozhodnutie šéfa. Nerozhodnuté: či/ako by sa toto premietlo do dashboardu (nový krok/checklist pri spúšťaní Dopytov?), akou formou by prebiehalo schválenie, ako presne by sa definovalo čo je "podstatné"/"kľúčové".
