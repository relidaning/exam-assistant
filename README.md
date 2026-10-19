# Exam Assistant

A local practice app for upcoming tests. Questions are organized by **course → module → question type**. Each
question type gets an answer UI that fits it.

```bash
npm install
npm run demo     # optional: sample course with every question type
npm start        # http://localhost:8710  (also printed: the LAN address for your phone/tablet)
```

## Accounts and sharing

Everyone signs in, with a username and password or with **Google / GitHub**; anyone who can reach the app can create
an account. The first account becomes the **admin** and takes over the courses and progress that existed before
accounts. On the **Account** page (the round button top right) you can link Google and GitHub to an existing account,
unlink them, and set or change a password.

- **Courses** are private (only you see them) or **public** (everyone signed in sees them under *Public courses* and
  can practise them). A course you create starts private; **Publish** on its page shares it, **Make private** takes
  it back. Courses from before accounts start out public.
- **Only the owner edits** a course: details, importing, re-parsing and deleting questions. Anyone else can **Fork**
  it, which makes a private copy they own and edit freely, and can publish too. Question ids stay the same, so a fork
  can bring your progress with it.
- **Progress is private.** Every answer, star, note, mock exam result, unfinished round and study setting belongs to
  your account. Your settings start from the owner's and changing them affects only you.
- The admin can unpublish or delete any public course (moderation), but can't edit it or see private courses.

### Setting up Google / GitHub sign-in

The buttons appear once a provider has a client id and secret, in `data/oauth.json` (read on every sign-in, no
restart needed) or in environment variables (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, `EXAM_PUBLIC_URL`, `GOOGLE_PUBLIC_URL`, `GITHUB_PUBLIC_URL`):

```json
{
  "publicUrl": "http://192.168.1.7:8710",
  "github": { "clientId": "…", "clientSecret": "…" },
  "google": { "clientId": "…", "clientSecret": "…", "publicUrl": "http://localhost:8710" }
}
```

The callback to register with a provider is `<publicUrl>/api/auth/oauth/<google|github>/callback`. Sign-in always
finishes at that address, so open the app there.

- **GitHub**: Settings → Developer settings → OAuth Apps → New OAuth App. Homepage URL `<publicUrl>`, callback URL as
  above. A LAN address like `http://192.168.1.7:8710` works.
- **Google**: Google Cloud console → APIs & Services → Credentials → Create OAuth client ID (Web application), with
  the callback as an authorized redirect URI. Google accepts only `localhost` or a real domain (for example an HTTPS
  name from a reverse proxy or Tailscale), not a LAN IP, so on a phone over the LAN use GitHub or the password. With a `localhost` address, the Google button
  shows only in a browser on the server machine.

Accounts are matched by the provider's user id, never by email; joining a Google/GitHub account to an existing one
only happens by linking it from the Account page while signed in.

## Flow

1. **Pick a course.** The list is kept simple: each card has the course name, description and exam countdown.
   The numbers are on the Statistics page.
2. **Pick a module**. The course page holds only the modules. Questions always come in random order. Each module
   keeps its own unfinished session: its tile shows "In progress · 12/215", and tapping it offers Resume or Start new.
   Starting one module never discards another's progress.
   - **Practice**: instant feedback after each question.
   - **Mistakes**: every question you got wrong. A question leaves after 3 correct answers in a row, or when you
     remove it by hand.
   - **Mock exam**: timed, with no feedback until you hand in. Its badge shows the setup: question types, counts,
     points and duration. You grade short answers against the reference, then get a score and its history.
   - **Starred**: your bookmarks.
   - **Statistics**: all the numbers. That's how much you've practiced, your accuracy, how many questions are
     waiting for review, your best mock exam and the mix of question types. It also has accuracy by type and by chapter, an exam score trend, and your most-missed questions.
   - **Settings**: the course's name, description and exam date, importing more questions, export, printing and
     deleting the course. It also sets which chapters every module draws from, which question types Practice and Mistakes use, and how
     many questions there are per session. Also the mock exam setup: questions and points per type, and duration.
     Settings are stored on the server, so your phone and desktop share them.
3. **Answer.** The input fits each question type:

| Type | How you answer |
|---|---|
| Single choice | tap an option (or press A–D / 1–4); it submits right away |
| Multiple choice | toggle options, then submit; picking only correct ones but not all earns partial credit |
| True / False | two big buttons (T / F) |
| Fill in the blank | inline inputs inside the sentence; Enter moves to the next blank; full-width, case and numeric variants are accepted |
| Calculation | one input per part, with units. Accepts expressions (`1/3`, `2*sqrt(2)`, `pi/4`, `1.2e-3`) with a live preview. Includes a keypad and a scratch pad. Tolerance is set per question, ±1 % by default |
| Short answer | free text, then the reference answer with its key points highlighted, then you grade yourself |

Everywhere: LaTeX math (KaTeX, with mhchem for chemistry), images (tap to zoom), audio and video, and Markdown tables
and code. You can star questions and keep notes on them. If a question was read wrongly from your notes, the **Re-parse** button under the question (or press P) opens its original
source text. Fix the text, or load the note's current version if you've corrected the note, check the preview,
and save. Your progress on the question is kept. A small **Verify** button next to Submit/Next (or press G) opens a
Google search for the question in a new tab, so you can double-check an answer. It's hidden while you're answering a mock exam. The keyboard works throughout (←/→, Enter, S to star, P to re-parse, M for
the question list; in practice Ctrl+Enter submits, or shows the answer when you leave it blank — counted as wrong; Y/P/N grade a
short answer as got it / partly / missed it and move on to the next question), and you can swipe between questions on touch screens. Sessions resume after a reload, and
are kept on the server, so another device or address (localhost vs. the LAN IP) opens the same round.

## Responsive and media

The layout adapts from phones (bottom action bar, bottom-sheet question list, large touch targets, safe-area
insets) to tablets and desktops (a side navigator panel). It supports light and dark themes and reduced motion. You can install it on a phone's home screen as a PWA, and Settings can produce a
printable paper with an answer key.

## Getting questions in

- **Ask Claude** (Claude Code in this folder):
  - "find past papers for *Signals and Systems* and load them"
  - "load the questions in my vault folder *1_Math/Calculus*"
  - "add these questions to *Economics*: …"

  See `.claude/skills/exam-import/SKILL.md`.
- **In the app**: a course's Settings → Import, or **Import questions** on the course list. Paste text or drop `.md` / `.txt` / `.json` files, preview them, then import.
- **CLI**: `npm run import -- --course "Linear Algebra" notes/*.md`. New courses go to the admin
  (`--owner <username>` for someone else), private unless you add `--public`.

The format is forgiving: numbered questions, `A. B. C. D.` options (on one line or several), `Answer:` or `答案：`,
`Explanation:` or `解析：`, section headings such as `一、单项选择题`, Obsidian `![[image.png]]` embeds, `- [x]`
checkboxes and `{{cloze}}` blanks. The full reference is in [docs/FORMAT.md](docs/FORMAT.md).

## Data

Everything is stored in one SQLite file, `data/exam.db`: accounts (scrypt password hashes), question banks, and each
user's answers (with their time), stars, notes, mock exam results and settings. Images and audio go in `data/media/<course>/`. It's written as you go,
so restarting the app loses nothing.

- `npm run backup` writes a snapshot to `data/backups/` and keeps the newest 30. It's safe while the app is running.
- You can export a course's questions as JSON from its Settings → Export.
