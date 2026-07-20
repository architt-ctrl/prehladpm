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

### Vyhľadávanie projektov

`searchQuery` — globálna premenná. Search input v `phase-bar`. Keď je neprázdny, `renderProjects()` zobrazí všetky zodpovedajúce projekty naprieč všetkými fázami s farebnými fáza badges. Plné project rows s detail divmi — projekt možno rozkliknúť priamo vo výsledkoch.

### Názov projektu v title karty prehliadača (2026-07-20)

Keď je otvorený jeden projekt na viacerých kartách naraz, karty sú nerozlíšiteľné (všetky "Prehľad"). `toggleProjDetail(cislo)` preto pri otvorení detailu nastaví `document.title = p.nazov`; pri zatvorení sa vráti na `DEFAULT_TITLE` (pôvodný `<title>`, zachytený raz pri načítaní skriptu) — alebo na názov iného projektu, ak ostal otvorený iný `.proj-detail.open`.

### Odkaz na projektový priečinok (📁, 2026-07-20)

Tlačidlo 📁 pri každom projekte otvára priečinok projektu v reálnom Windows Prieskumníku. `folderSearchLink(cislo)` vracia `search-ms:` URI (`query=<cislo>&crumb=location:H:\Spoločné disky\1_PROJEKTY`), nie priamy `file://` odkaz — presný názov priečinka na disku sa môže líšiť od Caflou (rovnaký dôvod, prečo `sync-fazy.ps1` hľadá priečinky prefix-regexom, nie presnou zhodou), a `file://` linky z `https://` stránky navyše prehliadač spoľahlivo neotvára v Exploreri. `search-ms` funguje len ak má Windows Search zaindexovaný daný H: disk (Indexing Options).

**Šablóna riadku projektu existuje na 3 miestach** (`projRowHtml`, výsledky vyhľadávania a Archív v `renderProjects()`) — akúkoľvek zmenu tlačidiel v riadku (📁, ✎...) treba spraviť na všetkých troch, inak zmizne len v niektorých pohľadoch (stalo sa pri prvom pridaní 📁 — chýbalo vo vyhľadávaní aj Archíve).

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

**Stav:** Kroky 1-4 implementované, čaká sa na živé otestovanie celého flow (výber víťaza → vznik výdavku v Caflou) od Jozefa.

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
