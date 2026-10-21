// Client-side cache of course data ({course, progress, stats, masteryStreak}) + progress mutations.
import { api, storage, toast, auth } from './ui.js';

const cache = new Map();

export async function loadCourse(id, { force = false } = {}) {
  if (!force && cache.has(id)) return cache.get(id);
  await flushSessions(id); // the reply carries the course's rounds: send this device's pending saves first
  const data = await api('GET', `/api/courses/${encodeURIComponent(id)}`);
  data.byId = new Map(data.course.questions.map((q) => [q.id, q]));
  adoptSessions(id, data.sessions || {});
  cache.set(id, data);
  return data;
}

/** Cached data for a course without fetching (undefined if not loaded yet). */
export function peekCourse(id) {
  return cache.get(id);
}

export function invalidate(id) {
  if (id) cache.delete(id); else cache.clear();
}

export async function recordAttempt(id, payload) {
  const p = await api('POST', `/api/courses/${encodeURIComponent(id)}/attempt`, payload);
  const d = cache.get(id);
  if (d) d.progress.questions[payload.qid] = p;
  return p;
}

export async function setFlags(id, payload) {
  const p = await api('POST', `/api/courses/${encodeURIComponent(id)}/flag`, payload);
  const d = cache.get(id);
  if (d) d.progress.questions[payload.qid] = p;
  return p;
}

/** A past mock exam sitting (questions, answers, results), as saved when it was handed in. */
export const examDetail = (id, examId) => api('GET', `/api/courses/${encodeURIComponent(id)}/exams/${examId}`);

export async function recordExam(id, exam) {
  const e = await api('POST', `/api/courses/${encodeURIComponent(id)}/exam`, exam);
  const d = cache.get(id);
  if (d) d.progress.exams.push(e);
  return e;
}

// ---------- in-progress sessions, kept on the server so every address and device opens the same round ----------
// One saved session per course *and module*, so starting a mock exam never wipes an unfinished practice.
// Slots: the four modules, plus 'drill' for one-off sets ("Practice the missed", "Most missed") and 'review', a past
// mock exam sitting opened for review.
// Reads are synchronous from `live` (filled whenever the course loads); saves go to the server shortly after.
// localStorage only holds rounds from before (or saves that could not reach the server); they move up on the next load.
export const SLOTS = ['practice', 'exam', 'mistakes', 'starred', 'drill', 'review'];
// per user, so a round kept on a shared device never shows up for someone else
const key = (courseId, slot) => `exam.session.${auth.user?.id ?? 0}.${courseId}.${slot}`;
const live = new Map(); // courseId → { slot: session }
const pending = new Map(); // `${courseId}\n${slot}` → { timer, courseId, slot }
const queues = new Map(); // courseId → promise chain, so a round's saves and deletes reach the server in order
const SAVE_DELAY = 400;
const sessionUrl = (courseId, slot) => `/api/courses/${encodeURIComponent(courseId)}/sessions${slot ? `/${slot}` : ''}`;
const answeredCount = (s) => Object.values(s?.entries || {}).filter((e) => e.submitted || e.response != null).length;
const slotsOf = (courseId) => { if (!live.has(courseId)) live.set(courseId, {}); return live.get(courseId); };

function enqueue(courseId, job) {
  const next = (queues.get(courseId) || Promise.resolve()).then(job, job);
  queues.set(courseId, next.catch(() => {}));
  return next;
}

let warned = false;
function push(courseId, slot) {
  const s = live.get(courseId)?.[slot];
  if (!s) return Promise.resolve();
  return enqueue(courseId, async () => {
    try {
      await api('PUT', sessionUrl(courseId, slot), s);
      storage.del(key(courseId, slot));
      warned = false;
    } catch (e) {
      storage.set(key(courseId, slot), s); // keep it on this device; it moves up on the next load
      if (!warned) { warned = true; toast(`Progress kept on this device only: ${e.message}`, 'warn', 4000); }
    }
  });
}

function schedule(courseId, slot) {
  const k = `${courseId}\n${slot}`;
  clearTimeout(pending.get(k)?.timer);
  pending.set(k, { courseId, slot, timer: setTimeout(() => { pending.delete(k); push(courseId, slot); }, SAVE_DELAY) });
}

/** Send a course's pending saves now and wait until the server has everything (or failed). */
export async function flushSessions(courseId) {
  for (const [k, p] of [...pending]) {
    if (p.courseId !== courseId) continue;
    clearTimeout(p.timer);
    pending.delete(k);
    push(p.courseId, p.slot);
  }
  await queues.get(courseId);
}

/** Same for every course: before asking the server for all of the user's rounds. */
export async function flushAllSessions() {
  const ids = new Set([...[...pending.values()].map((p) => p.courseId), ...queues.keys()]);
  await Promise.all([...ids].map(flushSessions));
}

const exitHooks = new Set();
/** Run fn just before pending saves go out when the page is hidden or left (e.g. to bank a running clock). */
export function beforeExit(fn) { exitHooks.add(fn); return () => exitHooks.delete(fn); }

/** Leaving or hiding the page: send pending saves in a request that outlives it. */
function flushOnExit() {
  for (const fn of exitHooks) fn();
  for (const [k, p] of [...pending]) {
    clearTimeout(p.timer);
    pending.delete(k);
    const s = live.get(p.courseId)?.[p.slot];
    if (!s) continue;
    storage.set(key(p.courseId, p.slot), s); // in case the request is lost; dropped again once the server has it
    fetch(sessionUrl(p.courseId, p.slot), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s), keepalive: true }).catch(() => {});
  }
}
addEventListener('pagehide', flushOnExit);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushOnExit(); });

/** Take the server's rounds for a course; a round saved only in this browser moves up when it is newer (or further along). */
function adoptSessions(courseId, server) {
  const slots = { ...server };
  const legacy = storage.get(`exam.session.${courseId}`); // before per-module slots: one session per course
  if (legacy) {
    legacy.slot = SLOTS.includes(legacy.module) ? legacy.module : 'drill';
    if (!storage.get(key(courseId, legacy.slot))) storage.set(key(courseId, legacy.slot), legacy);
    storage.del(`exam.session.${courseId}`);
  }
  for (const slot of SLOTS) { // before accounts: rounds were kept per browser, not per user
    const old = storage.get(`exam.session.${courseId}.${slot}`);
    if (!old) continue;
    if (!storage.get(key(courseId, slot))) storage.set(key(courseId, slot), old);
    storage.del(`exam.session.${courseId}.${slot}`);
  }
  const moved = [];
  for (const slot of SLOTS) {
    const local = storage.get(key(courseId, slot));
    if (!local) continue;
    const other = slots[slot];
    // newer save wins; rounds from before syncing have no save time, so the one further along wins
    const better = !other || (local.savedAt && other.savedAt ? local.savedAt > other.savedAt : answeredCount(local) > answeredCount(other));
    if (better) {
      slots[slot] = local;
      moved.push(slot);
    } else storage.del(key(courseId, slot));
  }
  live.set(courseId, slots);
  for (const slot of moved) push(courseId, slot);
}

/** Re-read a course's rounds from the server (another device may have moved on). */
export async function syncSessions(courseId) {
  await flushSessions(courseId);
  adoptSessions(courseId, await api('GET', sessionUrl(courseId)));
}

export const sessions = {
  get(courseId, slot) {
    return live.get(courseId)?.[slot] ?? null;
  },
  save(s) {
    s.savedAt = Date.now();
    slotsOf(s.courseId)[s.slot] = s;
    schedule(s.courseId, s.slot);
  },
  /** Clear one slot, or every slot of the course when no slot is given. */
  clear(courseId, slot) {
    const slots = slotsOf(courseId);
    for (const sl of slot ? [slot] : SLOTS) {
      delete slots[sl];
      const k = `${courseId}\n${sl}`;
      clearTimeout(pending.get(k)?.timer);
      pending.delete(k);
      storage.del(key(courseId, sl));
    }
    if (!slot) storage.del(`exam.session.${courseId}`);
    enqueue(courseId, () => api('DELETE', sessionUrl(courseId, slot)).catch((e) => toast(`Could not discard the round: ${e.message}`, 'warn')));
  },
  /** Unfinished sessions of a course, with how far along they are. */
  unfinished(courseId) {
    const slots = live.get(courseId) || {};
    return SLOTS.map((sl) => slots[sl])
      .filter((s) => s && s.phase !== 'done')
      .map((s) => ({ ...s, answered: answeredCount(s) }));
  },
  /** A question was re-parsed (and may have a new id): point every session at it and drop the old answer state. */
  replaceQuestion(courseId, oldId, newId) {
    const swap = (ids) => ids?.map((x) => (x === oldId ? newId : x));
    for (const s of Object.values(live.get(courseId) || {})) {
      s.qids = swap(s.qids);
      if (s.gradingQids) s.gradingQids = swap(s.gradingQids);
      delete s.entries[oldId];
      delete s.entries[newId];
      sessions.save(s);
    }
  },
};
