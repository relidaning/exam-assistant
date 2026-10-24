// SQLite storage (Node's built-in node:sqlite): data/exam.db.
//   users, logins   — accounts (scrypt password hashes; '' for accounts that only sign in with Google/GitHub) and
//                     their sign-in tokens (stored hashed)
//   identities      — Google/GitHub accounts linked to a user (provider + the provider's stable user id)
//   courses         — one row per course: owner, private/public, what it was forked from, default study settings
//   questions       — canonical question JSON per row, import order kept in `position`
//   user_courses    — each user's own study settings for a course (falls back to the course's defaults), and whether they pinned it
// Progress is private, so every table below is keyed by user_id as well as course:
//   attempts        — every answer ever given, with time (the log stats are built from)
//   question_state  — per-question summary (counts, streak, last answer) and flags (star, note, cleared)
//   exams           — mock exam results
//   sessions        — the unfinished round of each module (shared by every browser and device of that user)
//   sources         — import history (per course)
//   course_log      — every change to a course (details, publishing, imports, question edits, settings), for its History
//   dms             — direct messages between two users (optionally about a course)
//   reports         — a learner's report of a mistake in a question, to the course's owner, and the owner's answer
// Rows from before accounts carry owner_id NULL / user_id 0; the first account to sign up claims them.
// Older JSON data (data/courses, data/progress) is migrated on first open and moved to data/json-backup/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { normalizeQuestion } from './normalize.mjs';
import { TYPES, grade, isOpen } from '../public/js/grade.js';
import { scoreExam } from '../public/js/session.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.EXAM_DATA_DIR || path.join(ROOT, 'data'));
export const DB_FILE = () => path.join(DATA_DIR, 'exam.db');
export const MEDIA_DIR = () => path.join(DATA_DIR, 'media');

/** A question leaves the mistakes book after this many consecutive correct answers. */
export const MASTERY_STREAK = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  login TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE TABLE IF NOT EXISTS logins (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  exam_date TEXT,
  settings TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_id INTEGER,
  visibility TEXT NOT NULL DEFAULT 'private',
  forked_from TEXT,
  published_at TEXT
);
CREATE TABLE IF NOT EXISTS questions (
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  type TEXT NOT NULL,
  chapter TEXT,
  data TEXT NOT NULL,
  PRIMARY KEY (course_id, id)
);
CREATE TABLE IF NOT EXISTS user_courses (
  user_id INTEGER NOT NULL,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  settings TEXT,
  PRIMARY KEY (user_id, course_id)
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  at TEXT NOT NULL,
  correct INTEGER NOT NULL,
  score REAL,
  response TEXT,
  mode TEXT,
  user_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS question_state (
  user_id INTEGER NOT NULL DEFAULT 0,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  wrong INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  last_at TEXT,
  last_wrong_at TEXT,
  last_score REAL,
  last_response TEXT,
  last_mode TEXT,
  history TEXT NOT NULL DEFAULT '[]',
  starred INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  cleared INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, course_id, question_id)
);
CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  title TEXT,
  total INTEGER, score REAL, max_score REAL, correct INTEGER, duration_sec INTEGER,
  by_type TEXT,
  user_id INTEGER NOT NULL DEFAULT 0,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  kind TEXT, name TEXT, at TEXT, count INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  user_id INTEGER NOT NULL DEFAULT 0,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, course_id, slot)
);
CREATE TABLE IF NOT EXISTS course_log (
  id INTEGER PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS dms (
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  reported_qid TEXT NOT NULL,
  from_course TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'other',
  message TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reply TEXT,
  created_at TEXT NOT NULL,
  replied_at TEXT,
  owner_seen INTEGER NOT NULL DEFAULT 0,
  reporter_seen INTEGER NOT NULL DEFAULT 1
);
`;

// created after the accounts migration (they name user_id, which older databases only have after it)
const INDEXES = `
CREATE INDEX IF NOT EXISTS attempts_user_course_at ON attempts (user_id, course_id, at);
CREATE INDEX IF NOT EXISTS attempts_question ON attempts (course_id, question_id);
CREATE INDEX IF NOT EXISTS exams_user_course ON exams (user_id, course_id, at);
CREATE INDEX IF NOT EXISTS courses_owner ON courses (owner_id);
CREATE INDEX IF NOT EXISTS reports_course ON reports (course_id, question_id);
CREATE INDEX IF NOT EXISTS reports_user ON reports (user_id);
CREATE INDEX IF NOT EXISTS course_log_course ON course_log (course_id, at);
CREATE INDEX IF NOT EXISTS dms_to ON dms (to_id, read_at);
CREATE INDEX IF NOT EXISTS dms_pair ON dms (from_id, to_id, created_at);
`;

let db = null;

/** The shared connection (opened lazily; WAL lets the server and the import CLI write side by side). */
export function conn() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE());
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const hadLog = !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'course_log'").get();
  db.exec(SCHEMA);
  // columns added after the first release: where a question came from, for re-parsing
  const cols = new Set(db.prepare('PRAGMA table_info(questions)').all().map((c) => c.name));
  for (const [name, type] of [['raw', 'TEXT'], ['src_file', 'TEXT'], ['src_line', 'INTEGER']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE questions ADD COLUMN ${name} ${type}`);
  }
  migrateAccounts(db);
  // a mock exam's questions and answers, so a sitting can be reviewed later (none for sittings from before)
  if (!db.prepare('PRAGMA table_info(exams)').all().some((c) => c.name === 'detail')) db.exec('ALTER TABLE exams ADD COLUMN detail TEXT');
  // when the user pinned the course to the top of My courses (NULL = not pinned)
  if (!db.prepare('PRAGMA table_info(user_courses)').all().some((c) => c.name === 'pinned_at')) db.exec('ALTER TABLE user_courses ADD COLUMN pinned_at TEXT');
  db.exec(INDEXES);
  migrateJson(db);
  if (!hadLog) backfillLog(db);
  return db;
}

export function closeDb() {
  if (db) { db.close(); db = null; }
}

const get = (sql, ...args) => conn().prepare(sql).get(...args);
const all = (sql, ...args) => conn().prepare(sql).all(...args);
const run = (sql, ...args) => conn().prepare(sql).run(...args);

function tx(fn) {
  const d = conn();
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

const now = () => new Date().toISOString();
const parse = (s, fallback = null) => { if (s == null) return fallback; try { return JSON.parse(s); } catch { return fallback; } };

export function slugify(name) {
  const s = String(name).normalize('NFKC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 60) || 'course';
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function safeId(id) {
  const s = String(id);
  if (!s || s.includes('/') || s.includes('\\') || s.startsWith('.')) throw httpError(400, 'Bad course id');
  return s;
}

// a course with its owner's name and (when the viewer may follow it) the course it was forked from
const COURSE_SELECT = `
  SELECT c.*, u.username AS owner_name, f.name AS fork_name, f.visibility AS fork_visibility, f.owner_id AS fork_owner
    FROM courses c LEFT JOIN users u ON u.id = c.owner_id LEFT JOIN courses f ON f.id = c.forked_from`;

function courseRow(id) {
  const r = get(`${COURSE_SELECT} WHERE c.id = ?`, safeId(id));
  if (!r) throw httpError(404, `No course "${id}"`);
  return r;
}

function courseMeta(r) {
  const forkShown = r.forked_from && r.fork_name != null && (r.fork_visibility === 'public' || r.fork_owner === r.owner_id);
  return {
    id: r.id, name: r.name, description: r.description,
    ...(r.exam_date ? { examDate: r.exam_date } : {}),
    owner: r.owner_id == null ? null : { id: r.owner_id, username: r.owner_name },
    visibility: r.visibility,
    ...(forkShown ? { forkedFrom: { id: r.forked_from, name: r.fork_name } } : {}),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/**
 * What a user may do with a course: view (public, or their own), edit questions and details (owner only),
 * manage = publish/unpublish/delete (owner, or an admin for public courses). Private courses of others are a 404.
 * Courses from before accounts (no owner yet) belong to the admin.
 */
const ownsRow = (r, user) => !!user && (r.owner_id === user.id || (r.owner_id == null && !!user.isAdmin));

export function courseAccess(id, user) {
  const r = courseRow(id);
  const isOwner = ownsRow(r, user);
  if (!isOwner && r.visibility !== 'public') throw httpError(404, `No course "${id}"`);
  return { row: r, isOwner, canEdit: isOwner, canManage: isOwner || (!!user?.isAdmin && r.visibility === 'public') };
}

/** How many other people have practised a course (shown to its owner before unpublishing or deleting). */
export function learnerCount(id, exceptUid) {
  return get('SELECT count(DISTINCT user_id) AS n FROM question_state WHERE course_id = ? AND user_id != ?', id, exceptUid ?? -1).n;
}

// ---------- courses ----------

/** Every course the user can see (their own and all public ones), with that user's own numbers. */
export function listCourses(uid) {
  const byType = {};
  for (const r of all('SELECT course_id, type, count(*) AS n FROM questions GROUP BY course_id, type')) {
    (byType[r.course_id] ||= {})[r.type] = r.n;
  }
  const agg = {};
  for (const r of all(`
    SELECT s.course_id,
           sum(s.attempts > 0) AS answered, sum(s.attempts) AS attempts, sum(s.correct) AS correct, sum(s.starred) AS starred,
           sum(s.wrong > 0 AND s.streak < ? AND NOT s.cleared) AS wrongBook, max(s.last_at) AS lastAt
      FROM question_state s JOIN questions q ON q.course_id = s.course_id AND q.id = s.question_id
     WHERE s.user_id = ?
     GROUP BY s.course_id`, MASTERY_STREAK, uid)) agg[r.course_id] = r;
  const exams = Object.fromEntries(all('SELECT course_id, count(*) AS n FROM exams WHERE user_id = ? GROUP BY course_id', uid).map((r) => [r.course_id, r.n]));
  const forks = Object.fromEntries(all('SELECT forked_from, count(*) AS n FROM courses WHERE forked_from IS NOT NULL GROUP BY forked_from').map((r) => [r.forked_from, r.n]));
  const pins = Object.fromEntries(all('SELECT course_id, pinned_at FROM user_courses WHERE user_id = ? AND pinned_at IS NOT NULL', uid).map((r) => [r.course_id, r.pinned_at]));
  return all(`${COURSE_SELECT} WHERE c.visibility = 'public' OR c.owner_id = ? ORDER BY c.updated_at DESC`, uid).map((r) => {
    const types = byType[r.id] || {};
    const a = agg[r.id] || {};
    return {
      ...courseMeta(r),
      mine: r.owner_id === uid,
      pinnedAt: r.owner_id === uid ? pins[r.id] || null : null,
      forks: forks[r.id] || 0,
      stats: {
        total: Object.values(types).reduce((x, y) => x + y, 0), byType: types,
        answered: a.answered || 0, attempts: a.attempts || 0, correct: a.correct || 0,
        wrongBook: a.wrongBook || 0, starred: a.starred || 0, exams: exams[r.id] || 0, lastAt: a.lastAt || null,
      },
    };
  });
}

export function courseStats(course, prog) {
  const byType = {};
  let answered = 0, correct = 0, attempts = 0, wrongBook = 0, starred = 0, lastAt = null;
  for (const q of course.questions) {
    byType[q.type] = (byType[q.type] || 0) + 1;
    const p = prog.questions[q.id];
    if (!p) continue;
    if (p.attempts) answered++;
    attempts += p.attempts || 0;
    correct += p.correct || 0;
    if (inWrongBook(p)) wrongBook++;
    if (p.starred) starred++;
    if (p.lastAt && (!lastAt || p.lastAt > lastAt)) lastAt = p.lastAt;
  }
  return { total: course.questions.length, byType, answered, attempts, correct, wrongBook, starred, exams: prog.exams.length, lastAt };
}

export function inWrongBook(p) {
  return !!p && p.wrong > 0 && (p.streak || 0) < MASTERY_STREAK && !p.cleared;
}

export function getCourse(id) {
  const r = courseRow(id);
  return {
    ...courseMeta(r),
    sources: all('SELECT kind, name, at, count FROM sources WHERE course_id = ? ORDER BY id', r.id),
    questions: all('SELECT data FROM questions WHERE course_id = ? ORDER BY position', r.id).map((x) => JSON.parse(x.data)),
  };
}

export function courseExists(id) {
  try { return !!get('SELECT 1 AS x FROM courses WHERE id = ?', safeId(id)); } catch { return false; }
}

/** base, or base-2, base-3… — the first id no course has yet. */
function freeId(base) {
  let cid = base, n = 1;
  while (courseExists(cid)) cid = `${base.slice(0, 56)}-${++n}`;
  return cid;
}

export function createCourse({ name, description = '', id, ownerId = null }) {
  if (!name || !String(name).trim()) throw httpError(400, 'Course name required');
  let cid;
  if (id) {
    cid = safeId(id);
    if (courseExists(cid)) throw httpError(409, `Course "${cid}" already exists`);
  } else cid = freeId(slugify(name)); // another user may already have a course of that name
  const t = now();
  run('INSERT INTO courses (id, name, description, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    cid, String(name).trim(), String(description || ''), ownerId ?? null, t, t);
  logChange(cid, ownerId, 'created', `Created “${String(name).trim()}”`);
  return getCourse(cid);
}

export function updateCourse(id, patch, { by = null } = {}) {
  const r = courseRow(id);
  const visibility = patch.visibility === undefined ? r.visibility : patch.visibility;
  if (!['private', 'public'].includes(visibility)) throw httpError(400, 'visibility must be "private" or "public"');
  const next = {
    name: patch.name !== undefined && String(patch.name).trim() ? String(patch.name).trim() : r.name,
    description: patch.description !== undefined ? String(patch.description) : r.description,
    examDate: patch.examDate !== undefined ? (patch.examDate || null) : r.exam_date,
  };
  tx(() => {
    run('UPDATE courses SET name = ?, description = ?, exam_date = ?, visibility = ?, published_at = ?, updated_at = ? WHERE id = ?',
      next.name, next.description, next.examDate,
      visibility, visibility === 'public' ? (r.visibility === 'public' ? r.published_at : now()) : null,
      now(), r.id);
    const before = { name: r.name, description: r.description, examDate: r.exam_date };
    const changed = Object.keys(next).filter((k) => (before[k] ?? '') !== (next[k] ?? ''));
    if (changed.length) {
      const label = { name: 'name', description: 'description', examDate: 'exam date' };
      logChange(r.id, by, 'details', `Changed the ${changed.map((k) => label[k]).join(', ')}`,
        { fields: Object.fromEntries(changed.map((k) => [k, { before: before[k] ?? null, after: next[k] ?? null }])) });
    }
    if (visibility !== r.visibility) logChange(r.id, by, visibility === 'public' ? 'published' : 'unpublished', visibility === 'public' ? 'Published' : 'Unpublished');
  });
  return getCourse(r.id);
}

export function deleteCourse(id) {
  courseRow(id);
  run('DELETE FROM courses WHERE id = ?', id); // questions, attempts, state, exams, sources, settings cascade
}

/** Find a course by name/id, or create it (owned by ownerId). */
export function ensureCourse(nameOrId, ownerId = null) {
  if (courseExists(slugify(nameOrId))) return getCourse(slugify(nameOrId));
  if (courseExists(nameOrId)) return getCourse(nameOrId);
  return createCourse({ name: nameOrId, ownerId });
}

/**
 * Copy a course into a new private course owned by `user`, to edit freely. Question ids are content hashes, so with
 * withProgress the user's answers, stars, notes, exams and settings come along. The note a question was imported
 * from stays linked only when you fork your own course (it is a file on the owner's side).
 */
export function forkCourse(id, user, { name, withProgress = true } = {}) {
  const src = courseRow(id);
  const ownFork = src.owner_id === user.id;
  const title = String(name || '').trim() || src.name;
  return tx(() => {
    const cid = freeId(slugify(ownFork ? `${title} copy` : `${title} ${user.username}`));
    const t = now();
    run(`INSERT INTO courses (id, name, description, exam_date, settings, owner_id, visibility, forked_from, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'private', ?, ?, ?)`, cid, title, src.description, src.exam_date, src.settings, user.id, src.id, t, t);
    run(`INSERT INTO questions (course_id, id, position, type, chapter, data, raw, src_file, src_line)
         SELECT ?, id, position, type, chapter, data, raw, ${ownFork ? 'src_file, src_line' : 'NULL, NULL'} FROM questions WHERE course_id = ?`, cid, src.id);
    const n = get('SELECT count(*) AS n FROM questions WHERE course_id = ?', cid).n;
    run('INSERT INTO sources (course_id, kind, name, at, count) VALUES (?, ?, ?, ?, ?)', cid, 'fork', `${src.name}${src.owner_name ? ` by ${src.owner_name}` : ''}`, t, n);
    logChange(cid, user.id, 'forked', `Forked from “${src.name}”${src.owner_name ? ` by ${src.owner_name}` : ''}`, { from: src.id, count: n });
    if (withProgress) {
      const cols = (table) => conn().prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).filter((c) => c !== 'course_id' && c !== 'id');
      for (const table of ['question_state', 'attempts', 'exams', 'user_courses']) {
        const c = cols(table).join(', ');
        run(`INSERT INTO ${table} (course_id, ${c}) SELECT ?, ${c} FROM ${table} WHERE course_id = ? AND user_id = ?`, cid, src.id, user.id);
      }
    }
    return getCourse(cid);
  });
}

/**
 * Merge raw questions into a course. Questions with the same id are updated (progress is kept since ids are stable).
 * Raw items may carry `_raw` (source text), `_file` and `_line` (where it came from) for later re-parsing.
 * mode: 'merge' (default) | 'replace' (drop questions not in this import)
 */
export function importQuestions(id, rawList, { mode = 'merge', defaults = {}, source, by = null } = {}) {
  const course = courseRow(id);
  const questions = [];
  const errors = [];
  rawList.forEach((raw, index) => {
    try {
      questions.push({ q: normalizeQuestion(raw, defaults), src: { raw: raw?._raw ?? null, file: raw?._file ?? null, line: raw?._line ?? null } });
    } catch (e) {
      errors.push({ index, stem: String(raw?.stem ?? raw?.question ?? '').slice(0, 60), error: e.message });
    }
  });
  return tx(() => {
    const existing = new Map(all('SELECT id, data FROM questions WHERE course_id = ?', course.id).map((r) => [r.id, r.data]));
    let pos = get('SELECT coalesce(max(position), 0) AS p FROM questions WHERE course_id = ?', course.id).p;
    const insert = conn().prepare('INSERT INTO questions (course_id, id, position, type, chapter, data, raw, src_file, src_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const update = conn().prepare('UPDATE questions SET type = ?, chapter = ?, data = ? WHERE course_id = ? AND id = ?');
    // the source is refreshed on every import, even when the question itself is unchanged
    const updateSrc = conn().prepare('UPDATE questions SET raw = coalesce(?, raw), src_file = coalesce(?, src_file), src_line = coalesce(?, src_line) WHERE course_id = ? AND id = ?');
    let added = 0, updated = 0, unchanged = 0, removed = 0;
    const seen = new Set();
    for (const { q, src } of questions) {
      if (seen.has(q.id)) { unchanged++; continue; }
      seen.add(q.id);
      const json = JSON.stringify(q);
      const old = existing.get(q.id);
      if (old === undefined) { insert.run(course.id, q.id, ++pos, q.type, q.chapter ?? null, json, src.raw, src.file, src.line); added++; continue; }
      if (old === json) unchanged++;
      else { update.run(q.type, q.chapter ?? null, json, course.id, q.id); regradeQuestion(course.id, q); updated++; }
      updateSrc.run(src.raw, src.file, src.line, course.id, q.id);
    }
    if (mode === 'replace') {
      const del = conn().prepare('DELETE FROM questions WHERE course_id = ? AND id = ?');
      for (const qid of existing.keys()) if (!seen.has(qid)) { del.run(course.id, qid); removed++; }
    }
    const t = now();
    if (source) run('INSERT INTO sources (course_id, kind, name, at, count) VALUES (?, ?, ?, ?, ?)', course.id, source.kind ?? null, source.name ?? null, t, questions.length);
    run('UPDATE courses SET updated_at = ? WHERE id = ?', t, course.id);
    const total = get('SELECT count(*) AS n FROM questions WHERE course_id = ?', course.id).n;
    if (added || updated || removed) {
      const parts = [added && `${added} added`, updated && `${updated} updated`, removed && `${removed} removed`].filter(Boolean).join(', ');
      logChange(course.id, by, 'import', `Imported${source?.name ? ` from ${sourceLabel(source.name)}` : ''}: ${parts}`, { added, updated, removed, unchanged, total, source: source || null });
    }
    return { added, updated, unchanged, removed, errors, total };
  });
}

/** One question with where it came from: { question, raw, file, line } (raw/file/line may be null). */
export function getQuestionSource(id, qid) {
  courseRow(id);
  const r = get('SELECT data, raw, src_file, src_line FROM questions WHERE course_id = ? AND id = ?', id, String(qid));
  if (!r) throw httpError(404, 'No such question');
  return { question: JSON.parse(r.data), raw: r.raw, file: r.src_file, line: r.src_line };
}

/**
 * Replace a question with a re-parsed version. If its content id changes (stem/options edited), the question,
 * its state and its answer log move to the new id, so progress is kept and a later re-import of the fixed
 * source matches it instead of adding a duplicate. If the course already has a question with that id (the edit made
 * it a copy of another one), the two are merged into that one: answers, stars and notes from both are kept.
 */
export function replaceQuestion(id, qid, q, { raw = null, file = null, line = null, by = null, why = null } = {}) {
  courseRow(id);
  return tx(() => {
    const old = get('SELECT data FROM questions WHERE course_id = ? AND id = ?', id, qid);
    if (!old) throw httpError(404, 'No such question');
    if (q.id !== qid && get('SELECT 1 AS x FROM questions WHERE course_id = ? AND id = ?', id, q.id)) return mergeInto(id, qid, q, { by, why });
    if (q.id !== qid) {
      run('DELETE FROM question_state WHERE course_id = ? AND question_id = ?', id, q.id); // stale row of a deleted twin
      run('UPDATE question_state SET question_id = ? WHERE course_id = ? AND question_id = ?', q.id, id, qid);
      run('UPDATE attempts SET question_id = ? WHERE course_id = ? AND question_id = ?', q.id, id, qid);
      run('UPDATE reports SET question_id = ? WHERE course_id = ? AND question_id = ?', q.id, id, qid);
      run('UPDATE reports SET reported_qid = ? WHERE from_course = ? AND reported_qid = ?', q.id, id, qid); // the reporter's own copy
      moveInRounds(id, qid, q.id);
    }
    run(`UPDATE questions SET id = ?, type = ?, chapter = ?, data = ?, raw = ?, src_file = coalesce(?, src_file), src_line = coalesce(?, src_line)
          WHERE course_id = ? AND id = ?`, q.id, q.type, q.chapter ?? null, JSON.stringify(q), raw, file, line, id, qid);
    run('UPDATE courses SET updated_at = ? WHERE id = ?', now(), id);
    const regraded = regradeQuestion(id, q);
    if (old.data !== JSON.stringify(q)) logQuestionEdit(id, by, parse(old.data), q, regraded, why);
    return q;
  });
}

/**
 * An edited question (qid) became identical to another one (q.id): fold it into that one. Its answer log, reports
 * and rounds move over; each user's summary is rebuilt from the combined log, keeping a star or note from either.
 * The twin keeps its place and source; its content becomes the edited version. Runs inside replaceQuestion's tx.
 */
function mergeInto(id, qid, q, { by, why }) {
  const dup = parse(get('SELECT data FROM questions WHERE course_id = ? AND id = ?', id, qid).data);
  for (const s of all('SELECT * FROM question_state WHERE course_id = ? AND question_id = ?', id, qid)) {
    const t = readState(id, s.user_id, q.id);
    const notes = [...new Set([t.note, s.note].filter(Boolean))];
    run('DELETE FROM question_state WHERE user_id = ? AND course_id = ? AND question_id = ?', s.user_id, id, qid);
    const later = (s.last_at || '') > (t.last_at || '') ? s : t;
    writeState({
      ...t, attempts: t.attempts + s.attempts, starred: t.starred || s.starred, note: notes.join('\n\n') || null,
      cleared: t.cleared && s.cleared, last_at: later.last_at, last_response: later.last_response, last_mode: later.last_mode,
    });
  }
  const users = all('SELECT DISTINCT user_id FROM attempts WHERE course_id = ? AND question_id = ?', id, qid).map((r) => r.user_id);
  run('UPDATE attempts SET question_id = ? WHERE course_id = ? AND question_id = ?', q.id, id, qid);
  run('UPDATE reports SET question_id = ? WHERE course_id = ? AND question_id = ?', q.id, id, qid);
  run('UPDATE reports SET reported_qid = ? WHERE from_course = ? AND reported_qid = ?', q.id, id, qid);
  moveInRounds(id, qid, q.id);
  run('DELETE FROM questions WHERE course_id = ? AND id = ?', id, qid);
  run('UPDATE questions SET type = ?, chapter = ?, data = ? WHERE course_id = ? AND id = ?', q.type, q.chapter ?? null, JSON.stringify(q), id, q.id);
  run('UPDATE courses SET updated_at = ? WHERE id = ?', now(), id);
  // the counts, streak and history of everyone who answered the edited copy, from the now combined log
  for (const uid of users) rebuildState(id, uid, q.id);
  const regraded = regradeQuestion(id, q); // the moved answers were graded against the copy's key
  logChange(id, by, 'question', `Merged a duplicate question into its twin: ${stemLine(q.stem)}`, {
    qid: q.id, oldId: qid, merged: true, before: dup, after: q, why: why || undefined,
    regraded: regraded.attempts || regraded.exams || regraded.sessions ? regraded : undefined,
  });
  return q;
}

/** Merge fields into a stored question (id, source text and progress stay as they are); null removes a field. */
export function patchQuestion(id, qid, fields, { by = null } = {}) {
  courseRow(id);
  const r = get('SELECT data FROM questions WHERE course_id = ? AND id = ?', id, String(qid));
  if (!r) throw httpError(404, 'No such question');
  const q = { ...parse(r.data), ...fields };
  for (const [k, v] of Object.entries(fields)) if (v == null) delete q[k];
  if (q.id !== String(qid)) throw httpError(400, 'A question keeps its id');
  tx(() => {
    run('UPDATE questions SET data = ? WHERE course_id = ? AND id = ?', JSON.stringify(q), id, String(qid));
    run('UPDATE courses SET updated_at = ? WHERE id = ?', now(), id);
    const regraded = regradeQuestion(id, q);
    if (r.data !== JSON.stringify(q)) logQuestionEdit(id, by, parse(r.data), q, regraded);
  });
  return q;
}

/**
 * A question got a new id: saved sittings and rounds point at the new one. A finished round keeps its answer (graded
 * again by regradeQuestion); an unfinished one drops it, to be answered afresh.
 */
function moveInRounds(courseId, oldId, newId) {
  // when the round already has the new id (a merge into a twin), the old one just leaves it and the twin's entry stays
  const swap = (ids) => (ids?.includes(newId) ? ids.filter((x) => x !== oldId) : ids?.map((x) => (x === oldId ? newId : x)));
  const move = (d, keep) => {
    const twin = d.qids?.includes(newId);
    // a dropped place moves the current one back if it came after it
    const shift = (ids, k) => { const p = ids?.indexOf(oldId) ?? -1; if (twin && p >= 0 && Number.isInteger(d[k]) && d[k] > p) d[k]--; };
    shift(d.qids, 'idx');
    shift(d.gradingQids, 'gradeIdx');
    d.qids = swap(d.qids);
    if (d.gradingQids) d.gradingQids = swap(d.gradingQids);
    if (twin && Number.isInteger(d.idx)) d.idx = Math.min(d.idx, Math.max(0, d.qids.length - 1));
    if (d.entries) {
      const e = d.entries[oldId];
      delete d.entries[oldId];
      if (!twin) delete d.entries[newId];
      if (e && keep && !twin) d.entries[newId] = e;
    }
    return d;
  };
  for (const x of all('SELECT id, detail FROM exams WHERE course_id = ? AND detail LIKE ?', courseId, `%"${oldId}"%`)) {
    const d = parse(x.detail);
    if (d) run('UPDATE exams SET detail = ? WHERE id = ?', JSON.stringify(move(d, true)), x.id);
  }
  for (const x of all('SELECT user_id, slot, data FROM sessions WHERE course_id = ? AND data LIKE ?', courseId, `%"${oldId}"%`)) {
    const d = parse(x.data);
    if (!d || !Array.isArray(d.qids)) continue;
    move(d, d.phase === 'done');
    d.savedAt = Date.now();
    run('UPDATE sessions SET data = ?, updated_at = ? WHERE user_id = ? AND course_id = ? AND slot = ?', JSON.stringify(d), now(), x.user_id, courseId, x.slot);
  }
}

/**
 * A question's answer key changed (a fix after a report, a re-parse, a re-import): grade again what everyone answered
 * to it in this course, so their records follow the fixed key. Covers the answer log and the per-question summary
 * (mistakes book, streaks), saved mock exam sittings and the rounds kept in sessions. Self-graded written answers and
 * answers left blank keep their grade. Runs inside the caller's transaction.
 */
export function regradeQuestion(courseId, q) {
  if (isOpen(q.type)) return { attempts: 0, exams: 0, sessions: 0 };
  const regrade = (response) => { try { return grade(q, response); } catch { return null; } };
  const out = { attempts: 0, exams: 0, sessions: 0 };

  // the answer log, then each affected user's summary rebuilt from it
  const users = new Set();
  for (const a of all('SELECT id, user_id, correct, score, response FROM attempts WHERE course_id = ? AND question_id = ? AND response IS NOT NULL', courseId, q.id)) {
    const r = regrade(parse(a.response));
    if (!r || (!!r.correct === !!a.correct && r.score === a.score)) continue;
    run('UPDATE attempts SET correct = ?, score = ? WHERE id = ?', r.correct ? 1 : 0, r.score, a.id);
    users.add(a.user_id);
    out.attempts++;
  }
  for (const uid of users) rebuildState(courseId, uid, q.id);

  // one sitting or round: the entry graded again, and its summary redone when it has one
  const questionsOf = (qids) => {
    const byId = new Map(all('SELECT id, data FROM questions WHERE course_id = ?', courseId).map((r) => [r.id, r.data]));
    return qids.filter((id) => byId.has(id)).map((id) => JSON.parse(byId.get(id)));
  };
  const regradeRound = (d) => {
    const e = d?.entries?.[q.id];
    if (!e || !e.result || e.blank || e.selfGrade || e.response == null) return false;
    const r = regrade(e.response);
    if (!r || (!!r.correct === !!e.result.correct && r.score === e.result.score)) return false;
    e.result = r;
    if (d.summary && Array.isArray(d.qids)) {
      const qs = questionsOf(d.qids);
      const sum = scoreExam(qs, Object.fromEntries(qs.map((x) => [x.id, d.entries[x.id]?.result])), d.points || undefined);
      d.summary = { ...d.summary, ...sum };
    }
    return true;
  };
  for (const x of all('SELECT id, detail FROM exams WHERE course_id = ? AND detail LIKE ?', courseId, `%"${q.id}"%`)) {
    const d = parse(x.detail);
    if (!regradeRound(d)) continue;
    const sum = d.summary || {};
    run('UPDATE exams SET score = ?, max_score = ?, correct = ?, by_type = ?, detail = ? WHERE id = ?',
      sum.score ?? 0, sum.maxScore ?? 0, sum.correct ?? 0, JSON.stringify(sum.byType || {}), JSON.stringify(d), x.id);
    out.exams++;
  }
  for (const x of all('SELECT user_id, slot, data FROM sessions WHERE course_id = ? AND data LIKE ?', courseId, `%"${q.id}"%`)) {
    const d = parse(x.data);
    if (!regradeRound(d)) continue;
    d.savedAt = Date.now(); // newer than any copy a browser still holds
    run('UPDATE sessions SET data = ?, updated_at = ? WHERE user_id = ? AND course_id = ? AND slot = ?', JSON.stringify(d), now(), x.user_id, courseId, x.slot);
    out.sessions++;
  }
  return out;
}

export function deleteQuestion(id, qid, { by = null } = {}) {
  courseRow(id);
  tx(() => {
    const old = get('SELECT data FROM questions WHERE course_id = ? AND id = ?', id, String(qid));
    if (!old) throw httpError(404, 'No such question');
    run('DELETE FROM questions WHERE course_id = ? AND id = ?', id, String(qid));
    run('UPDATE courses SET updated_at = ? WHERE id = ?', now(), id);
    const q = parse(old.data);
    logChange(id, by, 'question-deleted', `Deleted a question: ${stemLine(q.stem)}`, { qid: q.id, before: q });
  });
}

// ---------- history ----------
// What was changed in a course, by whom and when (course_log). Question edits keep the question before and after, so
// the History can show what changed; imports keep their counts.
const stemLine = (stem) => {
  const t = String(stem ?? '').replace(/!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]*\]\]/g, '🖼').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
};

// where an import came from, as file names (a scratch folder's full path says nothing)
const sourceLabel = (name) => String(name || '').split(', ').map((x) => path.basename(x)).join(', ');

function logChange(courseId, by, action, summary, detail = null) {
  run('INSERT INTO course_log (course_id, at, user_id, action, summary, detail) VALUES (?, ?, ?, ?, ?, ?)',
    courseId, now(), by ?? null, action, summary, detail == null ? null : JSON.stringify(detail));
}

function logQuestionEdit(courseId, by, before, after, regraded, why) {
  logChange(courseId, by, 'question', `Edited a question: ${stemLine(after.stem)}`, {
    qid: after.id, oldId: before.id !== after.id ? before.id : undefined, before, after, why: why || undefined,
    regraded: regraded && (regraded.attempts || regraded.exams || regraded.sessions) ? regraded : undefined,
  });
}

/** A course's history, newest first, a page at a time: { entries: [{ id, at, by, action, summary, detail }], total }. */
export function courseHistory(id, { limit = 100, offset = 0 } = {}) {
  const r = courseRow(id);
  const rows = all(`SELECT l.*, u.username FROM course_log l LEFT JOIN users u ON u.id = l.user_id
                     WHERE l.course_id = ? ORDER BY l.at DESC, l.id DESC LIMIT ? OFFSET ?`, r.id, Number(limit), Number(offset) || 0);
  return {
    entries: rows.map((x) => ({ id: x.id, at: x.at, by: x.username ?? null, action: x.action, summary: x.summary, detail: parse(x.detail) })),
    total: get('SELECT count(*) AS n FROM course_log WHERE course_id = ?', r.id).n,
  };
}

/** The first time History exists: what the database already knows (creation, imports and forks, answered reports). */
function backfillLog(d) {
  const ins = d.prepare('INSERT INTO course_log (course_id, at, user_id, action, summary, detail) VALUES (?, ?, ?, ?, ?, ?)');
  for (const c of d.prepare('SELECT id, name, owner_id, created_at, forked_from FROM courses').all()) {
    const sources = d.prepare('SELECT kind, name, at, count FROM sources WHERE course_id = ? ORDER BY id').all(c.id);
    if (!sources.some((x) => x.kind === 'fork')) ins.run(c.id, c.created_at, c.owner_id, 'created', `Created “${c.name}”`, null);
    for (const x of sources) {
      if (x.kind === 'fork') ins.run(c.id, x.at, c.owner_id, 'forked', `Forked from “${x.name}”`, JSON.stringify({ from: c.forked_from, count: x.count }));
      else ins.run(c.id, x.at, null, 'import', `Imported${x.name ? ` from ${sourceLabel(x.name)}` : ''}: ${x.count} question${x.count === 1 ? '' : 's'}`, JSON.stringify({ source: { kind: x.kind, name: x.name }, count: x.count }));
    }
  }
  const statusText = { open: 'still open', fixed: 'fixed', declined: 'no change needed' };
  for (const r of d.prepare('SELECT r.*, c.owner_id, u.username FROM reports r JOIN courses c ON c.id = r.course_id LEFT JOIN users u ON u.id = r.user_id WHERE r.replied_at IS NOT NULL').all()) {
    ins.run(r.course_id, r.replied_at, r.owner_id, 'report', `Answered ${r.username || 'a'}'s report: ${statusText[r.status]}`,
      JSON.stringify({ report: r.id, status: r.status, reply: r.reply, message: r.message, qid: r.question_id }));
  }
}

// ---------- progress ----------

function stateToProgress(r) {
  const p = { attempts: r.attempts, correct: r.correct, wrong: r.wrong, streak: r.streak };
  if (r.last_at) p.lastAt = r.last_at;
  if (r.last_wrong_at) p.lastWrongAt = r.last_wrong_at;
  if (r.last_score != null) p.lastScore = r.last_score;
  if (r.last_response != null) p.lastResponse = parse(r.last_response);
  if (r.last_mode) p.lastMode = r.last_mode;
  p.history = parse(r.history, []);
  if (r.starred) p.starred = true;
  if (r.note) p.note = r.note;
  if (r.cleared) p.cleared = true;
  return p;
}

/** A user's summary of one question (counts, streak, history) redone from their answer log. */
function rebuildState(courseId, uid, qid) {
  const log = all('SELECT at, correct, score FROM attempts WHERE user_id = ? AND course_id = ? AND question_id = ? ORDER BY at, id', uid, courseId, qid);
  const s = readState(courseId, uid, qid);
  s.correct = log.filter((a) => a.correct).length;
  s.wrong = log.length - s.correct;
  s.streak = 0;
  for (let i = log.length - 1; i >= 0 && log[i].correct; i--) s.streak++;
  s.last_score = log.at(-1)?.score ?? s.last_score;
  s.last_wrong_at = log.filter((a) => !a.correct).at(-1)?.at ?? null;
  s.history = JSON.stringify(log.slice(-20).map((a) => (a.correct ? 1 : 0)));
  writeState(s);
}

/**
 * Mock exam answers left blank used not to be logged; now they count as wrong. This logs them for the sittings
 * recorded before (those with a `detail`), at the time the sitting was handed in. Safe to run again: a blank already
 * logged for that sitting is skipped. Questions no longer in the course are left out. `cleared` is kept as it is.
 */
export function logBlankExamAnswers({ dryRun = false } = {}) {
  return tx(() => {
    const added = [];
    for (const ex of all('SELECT id, user_id, course_id, at, detail FROM exams WHERE detail IS NOT NULL ORDER BY at, id')) {
      const d = parse(ex.detail, null);
      if (!d?.qids || !d.entries) continue;
      const at = d.finishedAt ? new Date(d.finishedAt).toISOString() : ex.at;
      for (const qid of d.qids) {
        if (!d.entries[qid]?.blank) continue;
        if (!get('SELECT 1 AS x FROM questions WHERE course_id = ? AND id = ?', ex.course_id, qid)) continue;
        if (get('SELECT 1 AS x FROM attempts WHERE user_id = ? AND course_id = ? AND question_id = ? AND at = ?', ex.user_id, ex.course_id, qid, at)) continue;
        added.push({ exam: ex.id, uid: ex.user_id, course: ex.course_id, qid, at });
        if (dryRun) continue;
        run(`INSERT INTO attempts (user_id, course_id, question_id, at, correct, score, response, mode) VALUES (?, ?, ?, ?, 0, 0, NULL, 'exam')`, ex.user_id, ex.course_id, qid, at);
        const s = readState(ex.course_id, ex.user_id, qid);
        s.attempts++;
        if (!s.last_at || s.last_at < at) { s.last_at = at; s.last_mode = 'exam'; s.last_score = 0; }
        writeState(s);
        rebuildState(ex.course_id, ex.user_id, qid);
      }
    }
    return added;
  });
}

function readState(courseId, uid, qid) {
  return get('SELECT * FROM question_state WHERE user_id = ? AND course_id = ? AND question_id = ?', uid, courseId, qid)
    || { user_id: uid, course_id: courseId, question_id: qid, attempts: 0, correct: 0, wrong: 0, streak: 0, history: '[]', starred: 0, cleared: 0 };
}

function writeState(s) {
  run(`INSERT INTO question_state (user_id, course_id, question_id, attempts, correct, wrong, streak, last_at, last_wrong_at, last_score,
         last_response, last_mode, history, starred, note, cleared)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, course_id, question_id) DO UPDATE SET
         attempts = excluded.attempts, correct = excluded.correct, wrong = excluded.wrong, streak = excluded.streak,
         last_at = excluded.last_at, last_wrong_at = excluded.last_wrong_at, last_score = excluded.last_score,
         last_response = excluded.last_response, last_mode = excluded.last_mode, history = excluded.history,
         starred = excluded.starred, note = excluded.note, cleared = excluded.cleared`,
  s.user_id, s.course_id, s.question_id, s.attempts, s.correct, s.wrong, s.streak, s.last_at ?? null, s.last_wrong_at ?? null,
  s.last_score ?? null, s.last_response ?? null, s.last_mode ?? null, s.history ?? '[]', s.starred ? 1 : 0, s.note ?? null, s.cleared ? 1 : 0);
}

function examRow(r) {
  return { id: r.id, at: r.at, title: r.title, total: r.total, score: r.score, maxScore: r.max_score, correct: r.correct, durationSec: r.duration_sec, byType: parse(r.by_type, {}), reviewable: !!r.reviewable };
}
const EXAM_COLS = 'id, at, title, total, score, max_score, correct, duration_sec, by_type, detail IS NOT NULL AS reviewable';

/** One user's progress on a course: { questions: {qid: state}, exams, settings }. */
export function getProgress(id, uid) {
  const r = courseRow(id);
  const questions = {};
  for (const s of all('SELECT * FROM question_state WHERE user_id = ? AND course_id = ?', uid, r.id)) questions[s.question_id] = stateToProgress(s);
  const own = get('SELECT settings FROM user_courses WHERE user_id = ? AND course_id = ?', uid, r.id);
  return {
    questions,
    exams: all(`SELECT ${EXAM_COLS} FROM exams WHERE user_id = ? AND course_id = ? ORDER BY at, id`, uid, r.id).map(examRow),
    settings: sanitizeSettings(parse(own?.settings ?? r.settings, {})),
  };
}

export function recordAttempt(id, uid, { qid, correct, score, response, mode }) {
  courseRow(id);
  if (!qid) throw httpError(400, 'qid required');
  return tx(() => {
    const s = readState(id, uid, String(qid));
    const t = now();
    s.attempts++;
    if (correct) { s.correct++; s.streak++; }
    else { s.wrong++; s.streak = 0; s.last_wrong_at = t; s.cleared = 0; }
    s.last_at = t;
    s.last_score = typeof score === 'number' ? score : (correct ? 1 : 0);
    if (response !== undefined) s.last_response = JSON.stringify(response);
    if (mode) s.last_mode = String(mode);
    s.history = JSON.stringify([...parse(s.history, []), correct ? 1 : 0].slice(-20));
    writeState(s);
    run('INSERT INTO attempts (user_id, course_id, question_id, at, correct, score, response, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      uid, id, String(qid), t, correct ? 1 : 0, s.last_score, response === undefined ? null : JSON.stringify(response), mode ? String(mode) : null);
    return stateToProgress(s);
  });
}

export function setFlags(id, uid, { qid, starred, note, cleared }) {
  courseRow(id);
  if (!qid) throw httpError(400, 'qid required');
  return tx(() => {
    const s = readState(id, uid, String(qid));
    if (starred !== undefined) s.starred = starred ? 1 : 0;
    if (note !== undefined) s.note = note ? String(note) : null;
    if (cleared !== undefined) s.cleared = cleared ? 1 : 0;
    writeState(s);
    return stateToProgress(s);
  });
}

export function recordExam(id, uid, exam) {
  courseRow(id);
  const entry = {
    at: now(),
    title: exam.title || 'Mock exam',
    total: Number(exam.total) || 0,
    score: Number(exam.score) || 0,
    maxScore: Number(exam.maxScore) || 0,
    correct: Number(exam.correct) || 0,
    durationSec: Number(exam.durationSec) || 0,
    byType: exam.byType || {},
  };
  // the sitting itself (questions, answers, results), kept for reviewing it later; a huge one is not kept
  let detail = exam.detail && typeof exam.detail === 'object' ? JSON.stringify(exam.detail) : null;
  if (detail && detail.length > 2_000_000) detail = null;
  const { lastInsertRowid } = run('INSERT INTO exams (user_id, course_id, at, title, total, score, max_score, correct, duration_sec, by_type, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    uid, id, entry.at, entry.title, entry.total, entry.score, entry.maxScore, entry.correct, entry.durationSec, JSON.stringify(entry.byType), detail);
  return { id: Number(lastInsertRowid), ...entry, reviewable: !!detail };
}

/** A past sitting's questions and answers, to review it. */
export function examDetail(id, uid, examId) {
  const r = courseRow(id);
  const row = get('SELECT detail FROM exams WHERE id = ? AND user_id = ? AND course_id = ?', Number(examId), uid, r.id);
  if (!row?.detail) throw httpError(404, 'This sitting was not saved for review');
  return parse(row.detail, {});
}

/** Clears one user's attempts, flags, exam history and unfinished rounds; questions and study settings stay. */
export function resetProgress(id, uid) {
  courseRow(id);
  tx(() => {
    for (const t of ['attempts', 'question_state', 'exams', 'sessions']) run(`DELETE FROM ${t} WHERE course_id = ? AND user_id = ?`, id, uid);
  });
}

// ---------- unfinished rounds ----------
// One per user, course and slot (the four modules, plus 'drill' for one-off sets and 'review', a past mock exam sitting
// opened for review). The browser owns the shape; the server only checks it looks like a round, so every address and
// device opens the same one.
export const SESSION_SLOTS = ['practice', 'mistakes', 'exam', 'starred', 'drill', 'review'];

function sessionSlot(slot) {
  if (!SESSION_SLOTS.includes(slot)) throw httpError(400, `Bad session slot "${slot}"`);
  return slot;
}

/** { slot: session } for a user's course. */
export function getSessions(id, uid) {
  const r = courseRow(id);
  const out = {};
  for (const s of all('SELECT slot, data FROM sessions WHERE user_id = ? AND course_id = ?', uid, r.id)) {
    const data = parse(s.data);
    if (data) out[s.slot] = data;
  }
  return out;
}

/** Every unfinished round of a user across the courses they can still see, newest save first. */
export function listSessions(uid) {
  return all(`SELECT s.course_id, s.slot, s.data, s.updated_at, c.name FROM sessions s JOIN courses c ON c.id = s.course_id
               WHERE s.user_id = ? AND (c.visibility = 'public' OR c.owner_id = ?) ORDER BY s.updated_at DESC`, uid, uid)
    .map((r) => ({ courseId: r.course_id, courseName: r.name, slot: r.slot, updatedAt: r.updated_at, session: parse(r.data) }))
    .filter((r) => r.session);
}

export function saveSession(id, uid, slot, data) {
  const r = courseRow(id);
  if (!data || typeof data !== 'object' || !Array.isArray(data.qids)) throw httpError(400, 'Not a session');
  const t = now();
  run(`INSERT INTO sessions (user_id, course_id, slot, data, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, course_id, slot) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    uid, r.id, sessionSlot(slot), JSON.stringify(data), t);
  return { updatedAt: t };
}

/** Remove one slot, or every unfinished round of the course when no slot is given. */
export function deleteSession(id, uid, slot) {
  const r = courseRow(id);
  if (slot) run('DELETE FROM sessions WHERE user_id = ? AND course_id = ? AND slot = ?', uid, r.id, sessionSlot(slot));
  else run('DELETE FROM sessions WHERE user_id = ? AND course_id = ?', uid, r.id);
}

/**
 * Answers per local day for the last `days` days (oldest first, zero-filled).
 * tzMinutes: the viewer's UTC offset in minutes (e.g. 480 for UTC+8) so days split at local midnight.
 */
export function getActivity(id, uid, { days = 30, tzMinutes = 0 } = {}) {
  courseRow(id);
  const n = Math.max(1, Math.min(366, Math.round(days)));
  const tz = Math.max(-840, Math.min(840, Math.round(tzMinutes)));
  const shift = `${tz >= 0 ? '+' : ''}${tz} minutes`;
  const localToday = new Date(Date.now() + tz * 60000).toISOString().slice(0, 10);
  const from = new Date(Date.parse(localToday) - (n - 1) * 86400000).toISOString().slice(0, 10);
  const rows = all(`SELECT date(at, ?) AS day, count(*) AS answers, sum(correct) AS correct
                      FROM attempts WHERE user_id = ? AND course_id = ? AND date(at, ?) >= ? GROUP BY day`, shift, uid, id, shift, from);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = 0; i < n; i++) {
    const day = new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10);
    const r = byDay.get(day);
    out.push({ day, answers: r?.answers || 0, correct: r?.correct || 0 });
  }
  return out;
}

/**
 * Study settings per user and course (shared by phone and desktop); the owner's also become the course's defaults,
 * which everyone else starts from:
 *   chapters: []                         — chapters every module draws from (empty = all)
 *   practice: { types: [], count }       — types (empty = all), questions per session (0 = all)
 *   mistakes: { types: [], frequentOnly }
 *   exam:     { perType: {type: n}, points: {type: pts}, timeMin, tag } — set up when any perType > 0;
 *             tag: only questions carrying this tag (e.g. 'past-paper'), chapters ignored
 */
export function sanitizeSettings(s = {}) {
  s = s || {};
  const types = (a) => (Array.isArray(a) ? [...new Set(a.filter((t) => TYPES.includes(t)))] : []);
  const num = (v, max) => Math.max(0, Math.min(max, Number(v) || 0));
  const perType = {}, points = {};
  for (const t of TYPES) {
    const n = num(s.exam?.perType?.[t], 1000);
    if (n) perType[t] = Math.round(n);
    if (s.exam?.points?.[t] != null) points[t] = num(s.exam.points[t], 1000);
  }
  return {
    chapters: Array.isArray(s.chapters) ? s.chapters.map(String) : [],
    practice: { types: types(s.practice?.types), count: Math.round(num(s.practice?.count, 10000)) },
    mistakes: { types: types(s.mistakes?.types), frequentOnly: !!s.mistakes?.frequentOnly },
    exam: { perType, points, timeMin: Math.round(num(s.exam?.timeMin ?? 0, 600)), tag: typeof s.exam?.tag === 'string' ? s.exam.tag.slice(0, 40) : '' },
  };
}

/** Pin a course to the top of the user's My courses (or unpin it). Only a course the user owns can be pinned. */
export function setPinned(id, uid, pinned) {
  const r = courseRow(id);
  if (r.owner_id !== uid) throw httpError(403, 'Only your own courses can be pinned');
  const at = pinned ? new Date().toISOString() : null;
  run(`INSERT INTO user_courses (user_id, course_id, pinned_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id, course_id) DO UPDATE SET pinned_at = excluded.pinned_at`, uid, r.id, at);
  return { pinnedAt: at };
}

export function setSettings(id, uid, input) {
  const r = courseRow(id);
  const json = JSON.stringify(sanitizeSettings(input));
  run(`INSERT INTO user_courses (user_id, course_id, settings) VALUES (?, ?, ?)
       ON CONFLICT (user_id, course_id) DO UPDATE SET settings = excluded.settings`, uid, r.id, json);
  if (r.owner_id === uid && json !== r.settings) {
    run('UPDATE courses SET settings = ? WHERE id = ?', json, r.id);
    // saves in a row (tweaking, then tweaking again) make one entry, from the first state to the last
    const last = get('SELECT id, user_id, at, action, detail FROM course_log WHERE course_id = ? ORDER BY at DESC, id DESC LIMIT 1', r.id);
    if (last?.action === 'settings' && last.user_id === uid && Date.now() - Date.parse(last.at) < 30 * 60000) {
      const d = parse(last.detail, {});
      if (JSON.stringify(d.before) === json) run('DELETE FROM course_log WHERE id = ?', last.id); // back where it started
      else run('UPDATE course_log SET at = ?, detail = ? WHERE id = ?', now(), JSON.stringify({ ...d, after: JSON.parse(json) }), last.id);
    } else {
      logChange(r.id, uid, 'settings', 'Changed the study settings', { before: sanitizeSettings(parse(r.settings, {})), after: JSON.parse(json) });
    }
  }
  return JSON.parse(json);
}

// ---------- question reports ----------
// A learner who finds a mistake in a question reports it to the course's owner, who answers (fixed, or no change
// needed) and may edit the question; the reporter sees the answer. Learners practise their own forks, so a report from
// a fork goes up to the course it was forked from: the first one up the chain they don't own and can still see.
export const REPORT_KINDS = ['answer', 'question', 'explanation', 'typo', 'other'];
export const REPORT_STATUSES = ['open', 'fixed', 'declined'];

/** The course a report about a question of course `id` goes to, or null when it would only reach yourself. */
export function reportTarget(id, user) {
  let r = courseRow(id);
  for (let hops = 0; ownsRow(r, user); hops++) {
    if (!r.forked_from || hops > 20) return null;
    const up = get(`${COURSE_SELECT} WHERE c.id = ?`, r.forked_from);
    if (!up || (!ownsRow(up, user) && up.visibility !== 'public')) return null;
    r = up;
  }
  return { id: r.id, name: r.name, owner: r.owner_id == null ? null : { id: r.owner_id, username: r.owner_name } };
}

/** Where a report about question `qid` of course `id` would go: { target, exists, openId } (target null: nowhere). */
export function reportInfo(id, user, qid) {
  const target = reportTarget(id, user);
  if (!target) return { target: null, exists: false, openId: null };
  const exists = !!get('SELECT 1 AS x FROM questions WHERE course_id = ? AND id = ?', target.id, String(qid));
  const open = get("SELECT id FROM reports WHERE course_id = ? AND question_id = ? AND user_id = ? AND status = 'open'", target.id, String(qid), user.id);
  return { target, exists, openId: open?.id ?? null };
}

export function createReport(id, user, { qid, kind, message }) {
  const { target, exists, openId } = reportInfo(id, user, qid);
  if (!target) throw httpError(400, 'This is your own course: fix the question with Re-parse');
  if (!exists) throw httpError(409, `This question is no longer in “${target.name}”: it was changed or removed there, or you changed your copy`);
  if (openId) throw httpError(409, 'You already reported this question. The answer will show under Messages');
  const text = String(message ?? '').trim();
  if (!text) throw httpError(400, 'Describe what is wrong');
  if (text.length > 2000) throw httpError(400, 'Keep the report under 2000 characters');
  const q = get('SELECT data FROM questions WHERE course_id = ? AND id = ?', target.id, String(qid));
  const { lastInsertRowid } = run(`INSERT INTO reports (course_id, question_id, reported_qid, from_course, user_id, kind, message, question, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, target.id, String(qid), String(qid), safeId(id), user.id,
  REPORT_KINDS.includes(kind) ? kind : 'other', text, q.data, now());
  return getReport(Number(lastInsertRowid), user, { markSeen: false });
}

const REPORT_SELECT = `
  SELECT r.*, c.name AS course_name, c.owner_id, u.username AS reporter, o.username AS owner_name
    FROM reports r JOIN courses c ON c.id = r.course_id LEFT JOIN users u ON u.id = r.user_id LEFT JOIN users o ON o.id = c.owner_id`;

function reportSummary(r, unread) {
  return {
    id: r.id, kind: r.kind, status: r.status, course: { id: r.course_id, name: r.course_name },
    reporter: r.reporter, owner: r.owner_name ?? null, stem: String(parse(r.question, {}).stem ?? '').slice(0, 140),
    message: r.message.slice(0, 140), createdAt: r.created_at, repliedAt: r.replied_at, unread,
  };
}

/** A user's reports: on the courses they own (received) and the ones they sent, newest first, with the unread count. */
export function listReports(user) {
  const received = all(`${REPORT_SELECT} WHERE (c.owner_id = ? OR (c.owner_id IS NULL AND ?)) ORDER BY r.created_at DESC, r.id DESC`, user.id, user.isAdmin ? 1 : 0)
    .map((r) => reportSummary(r, !r.owner_seen));
  const sent = all(`${REPORT_SELECT} WHERE r.user_id = ? ORDER BY coalesce(r.replied_at, r.created_at) DESC, r.id DESC`, user.id)
    .map((r) => reportSummary(r, !r.reporter_seen));
  return { received, sent, unread: [...received, ...sent].filter((r) => r.unread).length };
}

/** Reports waiting for this user: new ones on their courses, answers to theirs. */
export function unreadReports(user) {
  return get(`SELECT
      (SELECT count(*) FROM reports r JOIN courses c ON c.id = r.course_id WHERE NOT r.owner_seen AND (c.owner_id = ? OR (c.owner_id IS NULL AND ?)))
    + (SELECT count(*) FROM reports WHERE user_id = ? AND NOT reporter_seen) AS n`, user.id, user.isAdmin ? 1 : 0, user.id).n;
}

function reportRow(rid, user) {
  const r = get(`${REPORT_SELECT} WHERE r.id = ?`, Number(rid));
  const isOwner = !!r && ownsRow(r, user);
  const isReporter = !!r && r.user_id === user.id;
  if (!isOwner && !isReporter) throw httpError(404, 'No such report');
  return { r, isOwner, isReporter };
}

/** One report in full, for its course's owner or its reporter (opening it marks it read for that side). */
export function getReport(rid, user, { markSeen = true } = {}) {
  const { r, isOwner, isReporter } = reportRow(rid, user);
  if (markSeen && isOwner && !r.owner_seen) run('UPDATE reports SET owner_seen = 1 WHERE id = ?', r.id);
  if (markSeen && isReporter && !r.reporter_seen) run('UPDATE reports SET reporter_seen = 1 WHERE id = ?', r.id);
  const cur = get('SELECT data FROM questions WHERE course_id = ? AND id = ?', r.course_id, r.question_id);
  // the reporter's own copy (a fork) can take the owner's fixed version, if it still has the question as reported
  let fromCourse = null, canApply = false;
  const from = isReporter && r.from_course && r.from_course !== r.course_id ? get('SELECT id, name, owner_id FROM courses WHERE id = ?', r.from_course) : null;
  if (from && from.owner_id === user.id) {
    fromCourse = { id: from.id, name: from.name };
    const mine = get('SELECT data FROM questions WHERE course_id = ? AND id = ?', from.id, r.reported_qid);
    canApply = !!cur && !!mine && mine.data !== cur.data;
  }
  return {
    ...reportSummary(r, false), message: r.message, reply: r.reply ?? null, qid: r.question_id,
    question: cur ? JSON.parse(cur.data) : null, reported: parse(r.question), changed: !cur || cur.data !== r.question,
    role: isOwner ? 'owner' : 'reporter', fromCourse, canApply,
  };
}

/** The owner's answer: a status (open / fixed / declined) and a reply; the reporter sees it as new. */
export function replyReport(rid, user, { status, reply }) {
  const { r, isOwner } = reportRow(rid, user);
  if (!isOwner) throw httpError(403, 'Only the course owner answers a report');
  const st = status === undefined ? r.status : status;
  if (!REPORT_STATUSES.includes(st)) throw httpError(400, `status must be one of ${REPORT_STATUSES.join(', ')}`);
  const text = reply === undefined ? r.reply : String(reply ?? '').trim() || null;
  if (text && text.length > 4000) throw httpError(400, 'Keep the reply under 4000 characters');
  if (st !== r.status || text !== r.reply) {
    run('UPDATE reports SET status = ?, reply = ?, replied_at = ?, reporter_seen = 0, owner_seen = 1 WHERE id = ?', st, text, now(), r.id);
    logChange(r.course_id, user.id, 'report', `Answered ${r.reporter || 'a'}'s report: ${{ open: 'still open', fixed: 'fixed', declined: 'no change needed' }[st]}`,
      { report: r.id, status: st, reply: text, message: r.message, qid: r.question_id });
  }
  return getReport(r.id, user);
}

/** The reporter withdraws a report. */
export function deleteReport(rid, user) {
  const { r, isReporter } = reportRow(rid, user);
  if (!isReporter) throw httpError(403, 'Only the one who sent a report can withdraw it');
  run('DELETE FROM reports WHERE id = ?', r.id);
}

/** Put the owner's current version of a reported question into the reporter's fork (their progress on it is kept). */
export function applyReportFix(rid, user) {
  const rep = getReport(rid, user, { markSeen: false });
  if (!rep.canApply) throw httpError(409, 'Your copy has nothing to update for this report');
  const { r } = reportRow(rid, user);
  const src = get('SELECT data, raw FROM questions WHERE course_id = ? AND id = ?', r.course_id, r.question_id);
  const q = JSON.parse(src.data);
  if (q.id !== r.reported_qid && get('SELECT 1 AS x FROM questions WHERE course_id = ? AND id = ?', r.from_course, q.id)) {
    throw httpError(409, `“${rep.fromCourse.name}” already has the fixed version of this question`);
  }
  replaceQuestion(r.from_course, r.reported_qid, q, { raw: src.raw, by: user.id, why: `The fixed version from “${r.course_name}”` }); // moves reported_qid along with it
  return { courseId: r.from_course, question: q, oldId: r.reported_qid };
}

// ---------- owners' profiles and direct messages ----------
// A course's public page shows its owner: name, since when, their public courses, and a way to message them. Anyone
// may start a conversation with someone whose course they can see; after that both sides can write.

/** What anyone signed in may see about a user: name, since when, their public courses. */
export function userProfile(username, viewer) {
  const u = get('SELECT id, username, is_admin, created_at FROM users WHERE username = ?', String(username ?? ''));
  if (!u) throw httpError(404, `No user “${username}”`);
  const courses = all(`SELECT c.id, c.name, c.description, (SELECT count(*) FROM questions q WHERE q.course_id = c.id) AS questions,
                              (SELECT count(*) FROM courses f WHERE f.forked_from = c.id) AS forks
                         FROM courses c WHERE c.owner_id = ? AND c.visibility = 'public' ORDER BY c.updated_at DESC`, u.id)
    .map((c) => ({ id: c.id, name: c.name, summary: String(c.description || '').trim().split('\n')[0].trim(), questions: c.questions, forks: c.forks }));
  return {
    id: u.id, username: u.username, isAdmin: !!u.is_admin, memberSince: u.created_at, courses,
    isYou: viewer?.id === u.id, canMessage: !!viewer && viewer.id !== u.id && mayMessage(viewer, u.id),
  };
}

/** You may write to someone who owns a course you can see, or who has written to you (or you to them) before. */
function mayMessage(viewer, toId) {
  return !!get(`SELECT 1 AS x FROM courses WHERE owner_id = ? AND (visibility = 'public' OR owner_id = ?)
                UNION SELECT 1 FROM dms WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) LIMIT 1`,
  toId, viewer.id, viewer.id, toId, toId, viewer.id);
}

const dmOut = (m, uid) => ({
  id: m.id, mine: m.from_id === uid, body: m.body, at: m.created_at, read: !!m.read_at,
  ...(m.course_id ? { course: { id: m.course_id, name: m.course_name ?? null } } : {}),
});

export function sendDm(viewer, toUsername, { body, courseId = null }) {
  const to = get('SELECT id, username FROM users WHERE username = ?', String(toUsername ?? ''));
  if (!to) throw httpError(404, `No user “${toUsername}”`);
  if (to.id === viewer.id) throw httpError(400, 'That is you');
  if (!mayMessage(viewer, to.id)) throw httpError(403, `You can message ${to.username} once they have a course you can see`);
  const text = String(body ?? '').trim();
  if (!text) throw httpError(400, 'Write a message first');
  if (text.length > 4000) throw httpError(400, 'Keep a message under 4000 characters');
  // the course it is about: one the sender can see
  let cid = null;
  if (courseId) {
    const c = get('SELECT id, owner_id, visibility FROM courses WHERE id = ?', String(courseId));
    if (c && (c.visibility === 'public' || ownsRow(c, viewer))) cid = c.id;
  }
  const { lastInsertRowid } = run('INSERT INTO dms (from_id, to_id, course_id, body, created_at) VALUES (?, ?, ?, ?, ?)', viewer.id, to.id, cid, text, now());
  const m = get('SELECT d.*, c.name AS course_name FROM dms d LEFT JOIN courses c ON c.id = d.course_id WHERE d.id = ?', Number(lastInsertRowid));
  return dmOut(m, viewer.id);
}

/** A user's conversations, newest first: the other person, the last message, how many are unread. */
export function conversations(uid) {
  return all(`SELECT d.*, u.username AS other_name,
                     (SELECT count(*) FROM dms x WHERE x.to_id = ? AND x.from_id = u.id AND x.read_at IS NULL) AS unread
                FROM dms d JOIN users u ON u.id = CASE WHEN d.from_id = ? THEN d.to_id ELSE d.from_id END
               WHERE d.id IN (SELECT max(id) FROM dms WHERE from_id = ? OR to_id = ? GROUP BY CASE WHEN from_id = ? THEN to_id ELSE from_id END)
               ORDER BY d.created_at DESC, d.id DESC`, uid, uid, uid, uid, uid)
    .map((m) => ({ with: m.other_name, last: { body: m.body.slice(0, 140), at: m.created_at, mine: m.from_id === uid }, unread: m.unread }));
}

/** The messages between the viewer and another user, oldest first; opening it marks theirs as read. */
export function dmThread(viewer, otherUsername) {
  const o = get('SELECT id, username, created_at FROM users WHERE username = ?', String(otherUsername ?? ''));
  if (!o) throw httpError(404, `No user “${otherUsername}”`);
  const msgs = all(`SELECT d.*, c.name AS course_name FROM dms d LEFT JOIN courses c ON c.id = d.course_id
                     WHERE (d.from_id = ? AND d.to_id = ?) OR (d.from_id = ? AND d.to_id = ?) ORDER BY d.created_at, d.id`, viewer.id, o.id, o.id, viewer.id);
  const out = msgs.map((m) => dmOut(m, viewer.id)); // as they were before this visit: the new ones still show as new
  run('UPDATE dms SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL', now(), viewer.id, o.id);
  return { with: { username: o.username }, messages: out, canMessage: o.id !== viewer.id && mayMessage(viewer, o.id) };
}

export function unreadDms(uid) {
  return get('SELECT count(*) AS n FROM dms WHERE to_id = ? AND read_at IS NULL', uid).n;
}

// ---------- accounts ----------

export const USERNAME_RE = /^[\p{L}\p{N}_.-]{2,32}$/u;
const userOut = (r) => r && { id: r.id, username: r.username, isAdmin: !!r.is_admin, createdAt: r.created_at, hasPassword: !!r.pass };

function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  return `scrypt$${salt}$${crypto.scryptSync(String(password), salt, 64).toString('base64url')}`;
}

function passwordMatches(password, stored) {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const a = Buffer.from(hashPassword(password, salt).split('$')[2]);
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 6) throw httpError(400, 'Password needs at least 6 characters');
  if (password.length > 200) throw httpError(400, 'Password too long');
}

export function userCount() {
  return get('SELECT count(*) AS n FROM users').n;
}

/** Register an account. The first one becomes admin and takes over everything from before accounts. */
export function createUser({ username, password }) {
  const name = String(username ?? '').normalize('NFKC').trim();
  if (!USERNAME_RE.test(name)) throw httpError(400, 'Username: 2–32 letters, digits, _ . or -');
  checkPassword(password);
  return tx(() => {
    if (get('SELECT 1 AS x FROM users WHERE username = ?', name)) throw httpError(409, `The name "${name}" is taken`);
    return getUser(insertUser(name, hashPassword(password)));
  });
}

/** Add a user row (inside a transaction); the first one becomes admin and claims what came before accounts. */
function insertUser(name, pass) {
  const first = userCount() === 0;
  const uid = Number(run('INSERT INTO users (username, pass, is_admin, created_at) VALUES (?, ?, ?, ?)', name, pass, first ? 1 : 0, now()).lastInsertRowid);
  if (first) {
    run('UPDATE courses SET owner_id = ? WHERE owner_id IS NULL', uid);
    for (const t of ['question_state', 'attempts', 'exams', 'sessions', 'user_courses']) run(`UPDATE ${t} SET user_id = ? WHERE user_id = 0`, uid);
  }
  return uid;
}

// ---------- Google / GitHub sign-in ----------
// An identity is matched only by the provider's own user id, never by email: an account is joined to another one
// only when its owner links it while signed in.

/** The user an identity belongs to, or null. */
export function userForIdentity(provider, subject) {
  const r = get('SELECT user_id FROM identities WHERE provider = ? AND subject = ?', provider, String(subject));
  return r ? getUser(r.user_id) : null;
}

/** A new account for a first sign-in with a provider; named after the provider login (made unique). */
export function createIdentityUser(provider, profile) {
  return tx(() => {
    const base = [profile.login, profile.email?.split('@')[0], profile.name, provider]
      .map((x) => String(x ?? '').normalize('NFKC').trim().replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 28))
      .find((x) => USERNAME_RE.test(x));
    let name = base, n = 1;
    while (get('SELECT 1 AS x FROM users WHERE username = ?', name)) name = `${base}-${++n}`;
    const uid = insertUser(name, '');
    linkIdentity(uid, provider, profile);
    return getUser(uid);
  });
}

export function linkIdentity(uid, provider, { subject, email = null, login = null }) {
  const owner = get('SELECT user_id FROM identities WHERE provider = ? AND subject = ?', provider, String(subject));
  if (owner && owner.user_id !== uid) throw httpError(409, `That ${providerLabel(provider)} account is already linked to another user`);
  if (!owner && get('SELECT 1 AS x FROM identities WHERE user_id = ? AND provider = ?', uid, provider)) {
    throw httpError(409, `You already have a ${providerLabel(provider)} account linked. Unlink it first`);
  }
  run(`INSERT INTO identities (provider, subject, user_id, email, login, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, subject) DO UPDATE SET email = excluded.email, login = excluded.login`,
  provider, String(subject), uid, email, login, now());
}

/** Unlink a provider, as long as the account keeps another way to sign in. */
export function unlinkIdentity(uid, provider) {
  const r = get('SELECT pass FROM users WHERE id = ?', uid);
  const others = get('SELECT count(*) AS n FROM identities WHERE user_id = ? AND provider != ?', uid, provider).n;
  if (!r?.pass && !others) throw httpError(400, 'Set a password first, or you could no longer sign in');
  run('DELETE FROM identities WHERE user_id = ? AND provider = ?', uid, provider);
}

/**
 * Fold a stray account into another one (e.g. a first Google/GitHub sign-in that made a new account instead of linking):
 * its sign-in methods and courses move over, then it is deleted. Refused while it has progress of its own, which has
 * no safe place to go when both accounts answered the same questions.
 */
export function mergeAccount(fromUid, intoUid) {
  return tx(() => {
    const from = getUser(fromUid), into = getUser(intoUid);
    if (!from || !into || from.id === into.id) throw httpError(400, 'Name two different existing accounts');
    for (const t of ['attempts', 'question_state', 'exams', 'sessions', 'user_courses']) {
      if (get(`SELECT count(*) AS n FROM ${t} WHERE user_id = ?`, from.id).n) throw httpError(409, `“${from.username}” has its own progress (${t}); not merging`);
    }
    for (const { provider } of all('SELECT provider FROM identities WHERE user_id = ?', from.id)) {
      if (get('SELECT 1 AS x FROM identities WHERE user_id = ? AND provider = ?', into.id, provider)) throw httpError(409, `“${into.username}” already has a ${providerLabel(provider)} account linked`);
    }
    const moved = {
      identities: run('UPDATE identities SET user_id = ? WHERE user_id = ?', into.id, from.id).changes,
      courses: run('UPDATE courses SET owner_id = ? WHERE owner_id = ?', into.id, from.id).changes,
      reports: run('UPDATE reports SET user_id = ? WHERE user_id = ?', into.id, from.id).changes,
      messages: run('UPDATE dms SET from_id = ? WHERE from_id = ?', into.id, from.id).changes + run('UPDATE dms SET to_id = ? WHERE to_id = ?', into.id, from.id).changes,
    };
    run('DELETE FROM logins WHERE user_id = ?', from.id);
    run('DELETE FROM users WHERE id = ?', from.id);
    return moved;
  });
}

export function identitiesOf(uid) {
  return all('SELECT provider, email, login, created_at AS createdAt FROM identities WHERE user_id = ? ORDER BY provider', uid).map((r) => ({ ...r }));
}

const providerLabel = (p) => ({ google: 'Google', github: 'GitHub' })[p] || p;

export function getUser(uid) {
  return userOut(get('SELECT * FROM users WHERE id = ?', uid));
}

export function findUser(username) {
  return userOut(get('SELECT * FROM users WHERE username = ?', String(username ?? '').normalize('NFKC').trim()));
}

/** The admin new courses from the import CLI go to by default (null before anyone has signed up). */
export function defaultOwner() {
  return userOut(get('SELECT * FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1'));
}

/** The user for a name and password, or null. */
export function verifyUser(username, password) {
  const r = get('SELECT * FROM users WHERE username = ?', String(username ?? '').normalize('NFKC').trim());
  if (!r) { hashPassword(String(password ?? '')); return null; } // same work either way: no timing hint that the name exists
  return passwordMatches(password, r.pass) ? userOut(r) : null;
}

/** Change the password; an account that only signs in with Google/GitHub sets its first one without `current`. */
export function changePassword(uid, current, password) {
  const r = get('SELECT * FROM users WHERE id = ?', uid);
  if (!r || (r.pass && !passwordMatches(current, r.pass))) throw httpError(403, 'Current password is wrong');
  checkPassword(password);
  run('UPDATE users SET pass = ? WHERE id = ?', hashPassword(password), uid);
}

const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** Start a sign-in: returns the token for the cookie (only its hash is stored). */
export function createLogin(uid) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  run('INSERT INTO logins (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)', tokenHash(token), uid, t, t);
  return token;
}

export const LOGIN_DAYS = 365;

/** The signed-in user for a cookie token, or null. Sign-ins unused for LOGIN_DAYS expire. */
export function userForToken(token) {
  if (!token) return null;
  const h = tokenHash(token);
  const r = get('SELECT l.last_seen, u.* FROM logins l JOIN users u ON u.id = l.user_id WHERE l.token_hash = ?', h);
  if (!r) return null;
  const age = Date.now() - Date.parse(r.last_seen);
  if (age > LOGIN_DAYS * 86400000) { run('DELETE FROM logins WHERE token_hash = ?', h); return null; }
  if (age > 3600000) run('UPDATE logins SET last_seen = ? WHERE token_hash = ?', now(), h);
  return userOut(r);
}

export function deleteLogin(token) {
  if (token) run('DELETE FROM logins WHERE token_hash = ?', tokenHash(token));
}

// ---------- one-time migration to accounts ----------
// Courses get an owner and a visibility (everything from before is published), and progress tables get user_id
// (0 until the first account claims it). question_state and sessions are rebuilt: user_id joins their primary key.
// The database is copied to data/backups/ first.

function migrateAccounts(d) {
  const has = (table, col) => d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (has('question_state', 'user_id')) return;
  if (d.prepare('SELECT count(*) AS n FROM courses').get().n) {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `exam-before-accounts-${Date.now()}.db`);
    d.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    console.log(`Adding accounts to the database. Backup first: ${file}`);
  }
  const t = now();
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const [col, type] of [['owner_id', 'INTEGER'], ['visibility', "TEXT NOT NULL DEFAULT 'private'"], ['forked_from', 'TEXT'], ['published_at', 'TEXT']]) {
      if (!has('courses', col)) d.exec(`ALTER TABLE courses ADD COLUMN ${col} ${type}`);
    }
    d.prepare("UPDATE courses SET visibility = 'public', published_at = ?").run(t);
    for (const table of ['attempts', 'exams']) if (!has(table, 'user_id')) d.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0`);
    d.exec('DROP INDEX IF EXISTS attempts_course_at; DROP INDEX IF EXISTS exams_course;');
    for (const table of ['question_state', 'sessions']) {
      const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).join(', ');
      d.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
      const create = SCHEMA.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))[0];
      d.exec(create);
      d.exec(`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM ${table}_old; DROP TABLE ${table}_old;`);
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw new Error(`Adding accounts to the database failed (nothing changed): ${e.message}`);
  }
}

// ---------- one-time migration from the JSON-file storage ----------

function migrateJson(d) {
  const coursesDir = path.join(DATA_DIR, 'courses');
  const progressDir = path.join(DATA_DIR, 'progress');
  let files = [];
  try { files = fs.readdirSync(coursesDir).filter((f) => f.endsWith('.json')); } catch { return; }
  if (!files.length) return;
  if (d.prepare('SELECT count(*) AS n FROM courses').get().n) return; // already migrated

  const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const st = (sql) => d.prepare(sql);
  const counts = { courses: 0, questions: 0, states: 0, exams: 0 };
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const f of files) {
      const c = readJson(path.join(coursesDir, f));
      if (!c?.id) continue;
      const p = readJson(path.join(progressDir, f)) || {};
      const t = now();
      st('INSERT INTO courses (id, name, description, exam_date, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(c.id, c.name || c.id, c.description || '', c.examDate || null, JSON.stringify(sanitizeSettings(p.settings)), c.createdAt || t, c.updatedAt || t);
      const ins = st('INSERT OR IGNORE INTO questions (course_id, id, position, type, chapter, data) VALUES (?, ?, ?, ?, ?, ?)');
      (c.questions || []).forEach((q, i) => { ins.run(c.id, q.id, i + 1, q.type, q.chapter ?? null, JSON.stringify(q)); counts.questions++; });
      for (const s of c.sources || []) st('INSERT INTO sources (course_id, kind, name, at, count) VALUES (?, ?, ?, ?, ?)').run(c.id, s.kind ?? null, s.name ?? null, s.at ?? null, s.count ?? null);
      const insState = st(`INSERT INTO question_state (course_id, question_id, attempts, correct, wrong, streak, last_at, last_wrong_at, last_score,
                             last_response, last_mode, history, starred, note, cleared) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const [qid, q] of Object.entries(p.questions || {})) {
        insState.run(c.id, qid, q.attempts || 0, q.correct || 0, q.wrong || 0, q.streak || 0, q.lastAt ?? null, q.lastWrongAt ?? null,
          q.lastScore ?? null, q.lastResponse === undefined ? null : JSON.stringify(q.lastResponse), q.lastMode ?? null,
          JSON.stringify(q.history || []), q.starred ? 1 : 0, q.note ?? null, q.cleared ? 1 : 0);
        counts.states++;
      }
      for (const e of p.exams || []) {
        st('INSERT INTO exams (course_id, at, title, total, score, max_score, correct, duration_sec, by_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(c.id, e.at || t, e.title ?? null, e.total ?? 0, e.score ?? 0, e.maxScore ?? 0, e.correct ?? 0, e.durationSec ?? 0, JSON.stringify(e.byType || {}));
        counts.exams++;
      }
      counts.courses++;
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw new Error(`Migration from JSON failed (nothing changed): ${e.message}`);
  }
  // keep the old files, out of the way
  let backup = path.join(DATA_DIR, 'json-backup');
  if (fs.existsSync(backup)) backup += `-${Date.now()}`;
  fs.mkdirSync(backup, { recursive: true });
  for (const dir of [coursesDir, progressDir]) if (fs.existsSync(dir)) fs.renameSync(dir, path.join(backup, path.basename(dir)));
  console.log(`Migrated JSON data to SQLite: ${counts.courses} courses, ${counts.questions} questions, ${counts.states} question states, ${counts.exams} exams. Old files: ${backup}`);
}
