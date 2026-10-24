# Exam Assistant

Local web app for exam prep, with accounts: courses are private or public (owner edits, others practise or fork);
each user's progress is private. Four tabs: My courses (the start page), In progress, Public, Settings. Simple course cards (name, description, countdown) → course page
with module panels (practice, mock exam, mistakes, starred) and Statistics → an answer flow fitted to each
question type. All numbers live on the Statistics page. Questions are always shuffled; per-course Settings (chapters,
types per module, exam composition/duration) decide what each module asks. Theme colour: amber. Node ≥ 20, no framework, no build step.

## Commands

- `npm start` — server on `http://localhost:8710` (binds 0.0.0.0 so a phone on the LAN can use it; `PORT`, `HOST`,
  `EXAM_DATA_DIR` env vars override). No service starts it, so start it detached (`nohup setsid npm start …`), or it
  stops when the shell exits. To restart, kill the old one by PID with an anchored pattern (`pgrep -f "^node server.mjs"`)
  in its own command, then start it in the next: an unanchored `pgrep/pkill -f "node server.mjs"` or `"npm start"` also
  matches the agent's own shell, whose command line contains the pattern. To check UI changes in a browser, run a second server on a copy of the data
  (`EXAM_DATA_DIR=<copy> PORT=8799`) so the user's real sessions and stats aren't touched
- `npm test` — unit + API tests (node:test). `npm run test:e2e` — Playwright run through every question type at
  desktop and phone sizes (uses /usr/bin/google-chrome; screenshots dir as optional arg)
- `npm run import -- --course "<name>" [--owner <user>] [--public] [--dry-run] <files…>` — import Markdown/JSON (see
  `scripts/import.mjs` header). New courses go to the admin and start private
- `npm run demo` — (re)load the demo course from `examples/demo-course.md`
- `npm run backup` — consistent snapshot of the database to `data/backups/` (keeps 30)
- `node scripts/merge-account.mjs --from <user> --into <user>` — fold a stray account (a Google/GitHub sign-in that made
  a new account instead of linking) into the real one; refuses if it has progress. Back up first
- `node scripts/screenshots.mjs` — re-take the README screenshots in `docs/screenshots/` (own server on sample data,
  never the user's)
- `npm run icons` — re-render the PNG home-screen icons from `public/icon.svg` (iOS can't use SVG touch icons). The SVG
  is drawn on a 100×100 grid, which the script expects, in the style of the user's BeSmart/FloatingSphere icons (dark
  `#0d0e13` tile, segmented amber ring, glass disc): keep that family look when changing it

## Loading questions (the user's three sources)

Use the project skill **exam-import** (`.claude/skills/exam-import/SKILL.md`): web search for past papers by course
name, questions the user pastes, or notes in the Obsidian vault (`/data/nextcloud_client/obsidian/lidaning`).
Format reference: `docs/FORMAT.md`. Never write to `data/exam.db` by hand — go through the importer or `lib/store.mjs`.

## Layout

- `server.mjs` — HTTP API (`/api/auth/…`, `/api/courses…`, `/api/import/preview`) + static files + `/media/` (range
  requests). Every API route but `/api/auth/*` needs the `ea_sid` cookie; routes check view / edit (owner) / manage
  (owner, or admin on public courses) through `store.courseAccess`. Writes from another Origin are refused.
  Google/GitHub sign-in: `lib/oauth.mjs` (config from env or `data/oauth.json`; `PROVIDERS` endpoints, which tests
  point at a fake), state in the short-lived `ea_oauth` cookie, accounts in the `identities` table (matched by the
  provider's user id only; linking happens from `#/account` while signed in)
- `lib/normalize.mjs` — loose input → canonical question schema; type aliases & inference; stable ids
- `lib/parse-md.mjs` — Markdown/Obsidian/pasted-paper parser (EN + 中文 keywords)
- `lib/importer.mjs` — payload detection, media localization (copies embeds into `data/media/<course>/`)
- `lib/store.mjs` — SQLite via built-in `node:sqlite`, one file `data/exam.db` (WAL). Tables: users, logins (hashed
  tokens), courses (owner, visibility, forked_from, default settings JSON), questions (canonical JSON + type/chapter),
  user_courses (a user's own settings, and `pinned_at` when they pinned one of their own courses to the top of My courses). Per user (`user_id`): attempts (every answer, timestamped), question_state
  (summary + star/note/cleared), exams (`detail` holds a sitting's questions and answers so it can be reviewed later;
  NULL for sittings from before 2026-10-21), sessions (each module's unfinished round, so every address/device shares it;
  the browser keeps a live copy in `public/js/data.js` and saves back after 400 ms), reports (a learner's report of a
  mistake in a question → the course owner, who answers fixed / no change; from a fork it goes up to the course it was
  forked from, `store.reportTarget`; `question_id` follows re-parses; the reporter can pull the fix into their fork).
  Changing a question's answer key (re-parse, re-import, patch) re-grades everyone's stored answers to it
  (`store.regradeQuestion`: attempts + question_state, exam sittings, sessions); the browser then reloads its rounds
  (`sessions.reload`) instead of saving its older copies over them. A question's id is a hash of type + stem + options,
  so a re-parse that changes them moves its progress to the new id; if that id already exists in the course, the two
  copies merge (`mergeInto`: both answer logs, stars and notes kept, the twin keeps its place, logged as a merge).
  course_log: every change to a course (created/forked, details, publish, imports, question edits with before/after,
  deletes, the owner's study settings — saves within 30 min merge into one entry — and answered reports), shown at
  `#/settings/c/<id>/history` to whoever may manage the course. Store functions take `{ by: userId }` to name who did it
  (the import CLI leaves it null). Backfilled once from sources/reports when the table first appears.
  dms: direct messages between two users (optionally about a course). You may start a conversation with someone who
  owns a course you can see; after that both sides write. The public course page shows the owner (`GET /api/users/<name>`)
  with a Message button → `#/messages/u/<name>`; the bell counts unread reports + messages (`GET /api/inbox/unread`) Migrates old JSON storage on first open (→ `data/json-backup/`).
  Mistakes-book rule: wrong > 0 and streak < 3 (`MASTERY_STREAK`), unless cleared. A mock-exam answer left blank is logged as wrong at hand-in (`store.logBlankExamAnswers` logged the blanks of sittings from before 2026-10-23); in practice, Skip (and Finish with questions unanswered) logs the question as wrong once per round; a line under the question (not a toast) says so. End (in the run bar of practice-style rounds) stops a round early: the results cover only the questions answered or skipped, the rest are dropped from the round and not logged. Pre-accounts rows have owner NULL / user_id 0 and
  are claimed by the first account (admin)
- `public/js/grade.js` — shared by browser + Node: expression evaluator, per-type grading, answer text
- `public/js/session.js` — modules, settings → picking config, shuffled picking, exam summary/scoring (pure)
- `public/js/answer.js` — question card + per-type answer widgets; `run.js` — answer flow/result; `app.js` — router/pages.
  Four tabs (`ui.js` `tabbar`, bottom bar under 900 px, left sidebar from 900 px, rendered after the header): My courses `#/` (hub:
  four modules + Statistics; old `#/courses` links redirect), In progress `#/progress` (`GET /api/sessions`, resume/delete), Public `#/public`
  (search; every course opens its public page `#/p/<id>`, info only, even your own; practising someone else's needs a
  fork, enforced only in the UI; the server still accepts answers there), Settings `#/settings` (each course's settings at `#/settings/c/<id>`, account, theme). Messages `#/messages` (the bell in
  the top bar, unread count): reports on your courses and your own reports; `report.js` is the Report dialog in the runner.
  `nav.js` keeps Back = parent page; a course page's parent is the tab it was opened from. Only an admin publishes or
  unpublishes (server-enforced). A course description's first line is its summary; the rest is the public page's About
- `data/` is user data (git-ignored); `examples/` holds the demo bank

## Conventions

- Keep grading logic in `public/js/grade.js` so server tests cover what the browser runs.
- Every new question field: normalize it in `lib/normalize.mjs`, document it in `docs/FORMAT.md`.
- UI must work at 360 px wide with no horizontal scroll, and in dark mode; check with `npm run test:e2e`.
- Anything that imports `lib/store.mjs` (server, `npm run import`, `npm run backup`) runs pending schema migrations
  on the database it opens. After a schema change, try it with `EXAM_DATA_DIR=<copy>` first, then restart the live
  server right after the real database migrates (the old process can't write to the new schema).
