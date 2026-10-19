# Exam Assistant

Local web app for exam prep: simple course cards (name, description, countdown) → course page with module panels
(practice, mistakes, mock exam, starred) and tools (statistics, settings, questions) → an answer flow fitted to each
question type. All numbers live on the Statistics page. Questions are always shuffled; per-course Settings (chapters,
types per module, exam composition/duration) decide what each module asks. Theme colour: amber. Node ≥ 20, no framework, no build step.

## Commands

- `npm start` — server on `http://localhost:8710` (binds 0.0.0.0 so a phone on the LAN can use it; `PORT`, `HOST`,
  `EXAM_DATA_DIR` env vars override). No service starts it, so start it detached (`nohup setsid npm start …`), or it
  stops when the shell exits. To check UI changes in a browser, run a second server on a copy of the data
  (`EXAM_DATA_DIR=<copy> PORT=8799`) so the user's real sessions and stats aren't touched
- `npm test` — unit + API tests (node:test). `npm run test:e2e` — Playwright run through every question type at
  desktop and phone sizes (uses /usr/bin/google-chrome; screenshots dir as optional arg)
- `npm run import -- --course "<name>" [--dry-run] <files…>` — import Markdown/JSON (see `scripts/import.mjs` header)
- `npm run demo` — (re)load the demo course from `examples/demo-course.md`
- `npm run backup` — consistent snapshot of the database to `data/backups/` (keeps 30)
- `npm run icons` — re-render the PNG home-screen icons from `public/icon.svg` (iOS can't use SVG touch icons)

## Loading questions (the user's three sources)

Use the project skill **exam-import** (`.claude/skills/exam-import/SKILL.md`): web search for past papers by course
name, questions the user pastes, or notes in the Obsidian vault (`/data/nextcloud_client/obsidian/lidaning`).
Format reference: `docs/FORMAT.md`. Never write to `data/exam.db` by hand — go through the importer or `lib/store.mjs`.

## Layout

- `server.mjs` — HTTP API (`/api/courses…`, `/api/import/preview`) + static files + `/media/` (range requests)
- `lib/normalize.mjs` — loose input → canonical question schema; type aliases & inference; stable ids
- `lib/parse-md.mjs` — Markdown/Obsidian/pasted-paper parser (EN + 中文 keywords)
- `lib/importer.mjs` — payload detection, media localization (copies embeds into `data/media/<course>/`)
- `lib/store.mjs` — SQLite via built-in `node:sqlite`, one file `data/exam.db` (WAL). Tables: courses (+ settings
  JSON), questions (canonical JSON + type/chapter), attempts (every answer, timestamped), question_state (summary +
  star/note/cleared), exams, sources, sessions (each module's unfinished round, so every address/device shares it;
  the browser keeps a live copy in `public/js/data.js` and saves back after 400 ms). Migrates old JSON storage on first open (→ `data/json-backup/`).
  Mistakes-book rule: wrong > 0 and streak < 3, unless cleared
- `public/js/grade.js` — shared by browser + Node: expression evaluator, per-type grading, answer text
- `public/js/session.js` — modules, settings → picking config, shuffled picking, exam summary/scoring (pure)
- `public/js/answer.js` — question card + per-type answer widgets; `run.js` — answer flow/result; `app.js` — router/pages
- `data/` is user data (git-ignored); `examples/` holds the demo bank

## Conventions

- Keep grading logic in `public/js/grade.js` so server tests cover what the browser runs.
- Every new question field: normalize it in `lib/normalize.mjs`, document it in `docs/FORMAT.md`.
- UI must work at 360 px wide with no horizontal scroll, and in dark mode; check with `npm run test:e2e`.
