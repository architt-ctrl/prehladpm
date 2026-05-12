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
| `dennikMap` | `pmDennik` | `{cislo: [{datum, text}]}` — also written to Caflou comments |
| `geminiMap` | `pmGemini` | `{cislo: 'AI summary text'}` |
| `ulohy` | `pmUlohy` | `{cislo: [{id,profesia,stav,...}]}` |
| `cfg` | `pmCfg3` | `{caflou_key, caflou_id, url (Gemini Apps Script)}` |
| `activeFaza` | — | Current tab: `'Štúdia'\|'Projekcia'\|'Inžiniering'\|'Archív'` |
| `activeStav` | — | Current status filter: `'pripravovany'\|'aktivny'\|'pozastaveny'` |

### Data flow – Caflou

- `syncData()` fetches all projects from `https://app.caflou.com/api/v1/{caflou_id}/projects` (paginated, per=100). Caflou supports CORS (`*`) so calls are made directly from the browser.
- `parseCaflouProject(p)` maps each Caflou project using `CAFLOU_STATUS_MAP` (status→fáza/podfáza) and `CAFLOU_TYPE_PODFAZA` (type overrides podfáza).
- `saveProjCaflouStatus()` PATCHes `project_status_id` back to Caflou when fáza changes in the dashboard.
- `caflouAddComment()` writes denník entries to Caflou as project comments (`POST /comments`).
- Credentials stored in `caflou.env` (gitignored) and in localStorage. If no credentials, `loadDemo()` loads hardcoded sample data.

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

### Gemini integration

`geminiZhrnVsetky()` calls Apps Script (`cfg.url`) action `zhrniProjekt` for each visible project. Result stored in `geminiMap`.

## Other files

### ponuky.html

Profession quotes management module. Accessible at `ponuky.html` (linked from `index.html` via `module-nav`).

**Supabase backend** (`cfjkomqxzqflotrqxfyl.supabase.co`):
- `requests` — quote requests (project, profession, phases, notes, `folder_url`, `folder_url_work`)
- `specialists` — professionals (name, profession, email, phone)
- `invitations` — links request↔specialist, has `token` (UUID) and `status`: `sent|viewed|submitted|selected|rejected`
- `quotes` — submitted quotes (`prices` JSONB `{phase: amount}`, `notes`, `submitted_at`)

**Key patterns:**
- `_loading` guard prevents concurrent `loadAll()` calls
- `loadAll()` has 10s timeout — shows error instead of infinite spinner
- `loadCaflouProjects()` uses `d.results` (not `d.data`), filter `!p.trash && !p.template`
- `searchProjects()` uses `p.order_number` (not `p.number`)
- Save functions (`saveReq`, `saveSpec`) set `_loading = false` before calling `loadAll()`
- Toast notifications via `showToast(msg)`
- Caflou project search in request modal — dropdown appears after typing

**request modal fields:** project (Caflou search), profession, phases (checkboxes), notes, `folder_url` (Podklady na nacenenie), `folder_url_work` (Podklady na vypracovanie)

### portal.html

Specialist-facing quote submission form. Accessed via token link: `portal.html?token=UUID`.

**Flow:** `init()` → loads invitation by token → if `selected`/`rejected` → `renderStatus()`, otherwise `renderForm()`

- `_submitCtx` global holds `{invId, phases, curPhase}` to avoid JSON.stringify in onclick attribute
- `renderForm`: price table per phase, notes field (no deadline field)
- `renderStatus`: shows reqBlock (folder links, notes) + quoteBlock (submitted prices, notes)
- Both folder links shown side by side: `folder_url` (nacenenie) + `folder_url_work` (vypracovanie)

### sync-fazy.ps1

PowerShell script that reads projects from Caflou and creates `.lnk` shortcuts in `H:\Spoločné disky\1_PROJEKTY\_Fazy\` grouped by phase. Run after any phase change in Caflou. Uses wildcard path `H:\Spo*disky\...` to avoid PowerShell 5.1 diacritics encoding issues.

Shortcut on desktop: `Sync Fazy.lnk` (runs with `-NoExit -ExecutionPolicy Bypass`).

Project folders are named `2024-021-NazovProjektu` (4-digit year), Caflou uses `24-021` (2-digit) — the script handles this conversion.

### caflou.env (gitignored)

Contains `CAFLOU_API_KEY` and `CAFLOU_ACCOUNT_ID`. Never commit this file.
