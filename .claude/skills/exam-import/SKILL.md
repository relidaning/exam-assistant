---
name: exam-import
description: Load exam questions into the Exam Assistant app (this repo). Use when the user gives a course name to research past papers on the web, pastes/provides test questions, or points at vault notes / files holding questions — "find past papers for X", "load my notes in Courses/Y", "add these questions to Z". Covers searching, crawling, PDF extraction, converting to the question schema, importing with the CLI, and verifying.
---

# Loading questions into Exam Assistant

The app lives in this repo (`/data/apps/exam-assistant`). Banks live in the SQLite database `data/exam.db` (never edit it by hand); the importer normalizes
loose JSON/Markdown (`docs/FORMAT.md` is the reference — read it before writing questions).

Always finish with: dry run → import → report counts per type and any skipped questions → remind the user of the
URL (`http://localhost:8710`, or the LAN address printed by `npm start` for a phone).

## Common steps

1. Pick the course name exactly as the user says it. `--course` creates it when missing (id = slug of the name).
   The app has accounts: a new course belongs to the admin (the user's account), or to `--owner <username>`,
   and starts **private**. Add `--public` when the user wants others to see it (they can also publish it from the
   course page). Importing into an existing course keeps its owner and visibility.
2. Write the questions to a file in the session scratchpad (never into `data/` by hand): Markdown for
   human-readable papers, JSON when you are generating structured data.
3. `node scripts/import.mjs --course "<name>" --source "<where from>" --dry-run --json <file>`
   — check every question has the right `type` and `answer`. Fix the file, repeat until 0 errors.
4. `node scripts/import.mjs --course "<name>" --source "<where from>" <file>` (add `--chapter`, `--tags`).
   Re-importing the same question updates it in place (stable ids), so it's safe to re-run.
5. Server running? `curl -s localhost:8710/api/auth/me` — if not, start it detached (`nohup setsid npm start …`).

Question quality rules:
- Keep the original language of the paper. Keep math in `$…$` LaTeX.
- Choose the type that fits how the question is really answered: numeric results → `calc` (with `unit`, and a
  `tol` when the paper rounds), one-word/phrase answers → `fill` with alternatives `a | b`, proofs/essays → `short`
  with `keywords` listing the scoring points.
- Put the worked solution in `explanation` whenever you have it.
- **Never invent an answer key silently.** If the source has no answers and you solve them yourself, add the tag
  `ai-answer` and say so in `source` (e.g. `"2022 midterm (answers by Claude)"`), and tell the user.
- Skip questions you cannot represent faithfully (e.g. a diagram you could not obtain) and list them in your report.

## A. Course name → search the web for past papers

1. Search (WebSearch; use `extended` mode for niche courses) with several phrasings in the course's language:
   `"<course>" past exam paper`, `"<course>" final exam solutions pdf`, `<course> 期末试题 答案`, `<course> 历年真题`,
   plus the university/course code if the user gave one. Prefer official course pages, university repositories,
   and open courseware; avoid paywalled or login-only content.
2. Fetch candidates (WebFetch). For PDFs download into a **new empty scratch directory** and extract text:
   `pdftotext -layout paper.pdf paper.txt` (scanned PDFs: use the `pdf` skill's OCR path).
3. Convert to Markdown/JSON per `docs/FORMAT.md`. Use `--source "<paper title> — <URL>"` and a tag per paper/year.
4. Report which papers were imported (title + URL), how many questions each, and which had no answer key.

## B. The user provides the questions

Pasted text, a screenshot, or a file. Transcribe into Markdown (keeping numbering, options and answers), dry-run,
import. The user can also paste straight into the app (course Settings → Import, with preview) — mention it for future use.

## C. Questions in the Obsidian vault

The vault is a plain directory: `/data/nextcloud_client/obsidian/lidaning` (folders like `1_Math`, `2_Economic`,
attachments in `attachs/`). Read notes directly with Read/Grep/Glob; the `obsidian-local` skill is only needed for
writing back to the vault.

1. Find the notes: `Glob`/`Grep` under the folder the user names. Read them.
2. If a note already follows the format (numbered questions, `Answer:`/`答案：` lines, `- [x]` checkboxes,
   `{{cloze}}`, `> [!answer]` callouts), import the note file directly — embeds `![[img.png]]` are resolved inside
   the vault automatically:
   `node scripts/import.mjs --course "<name>" --dry-run "/data/nextcloud_client/obsidian/lidaning/<folder>/<note>.md"`
3. Otherwise convert the note's questions into a scratch Markdown/JSON file (pass `--vault <vault path>` so image
   embeds still resolve) and import that. Use the note's headings as `chapter`.
4. If the notes are study notes without questions and the user wants questions generated from them, generate them
   (mixed types, answers from the notes), tag them `generated`, and say so.

## Checking the result

- The API needs a sign-in, so check through the store instead:
  `node -e 'import("./lib/store.mjs").then((s) => { for (const c of s.listCourses(s.defaultOwner()?.id ?? 0)) console.log(c.id, c.visibility, c.stats.total, c.stats.byType) })'`
- Open `http://localhost:8710/#/c/<id>/settings` to see the course.
- `npm test` must still pass if you touched code.
