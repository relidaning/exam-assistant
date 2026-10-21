// Pure logic for picking questions for a session (practice / mistakes / exam / starred). No DOM.
// What each module draws from is decided in the course settings; questions always come in random order.
import { TYPE_LABELS } from './grade.js';

export const MODULES = {
  practice: { label: 'Practice', icon: '📝', desc: 'Instant feedback after every question' },
  exam: { label: 'Mock exam', icon: '⏱️', desc: 'Timed, scored at the end' },
  mistakes: { label: 'Mistakes', icon: '❌', desc: 'Questions you got wrong' },
  starred: { label: 'Starred', icon: '⭐', desc: 'Your bookmarks' },
};

/** Default points per type for mock exams (a question's own `score` wins). */
export const DEFAULT_POINTS = { single: 2, multi: 3, judge: 1, fill: 2, calc: 5, short: 5, essay: 15, term: 3 };

// the order sections appear in on a real paper (definitions come before short answers)
const TYPE_ORDER = ['judge', 'single', 'multi', 'fill', 'calc', 'term', 'short', 'essay'];

/** Tag carried by questions imported from past exam papers; the mock exam can draw from these only. */
export const PAST_PAPER_TAG = 'past-paper';

export function inMistakes(p, mastery = 3) {
  return !!p && p.wrong > 0 && (p.streak || 0) < mastery && !p.cleared;
}

export function accuracy(p) {
  return p && p.attempts ? p.correct / p.attempts : null;
}

export function shuffled(list, rand = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** The mock exam is set up once at least one question type has a count. */
export function examConfigured(settings) {
  return Object.values(settings?.exam?.perType || {}).some((n) => n > 0);
}

/** Turn course settings into the picking config for a module. */
export function moduleConfig(module, settings = {}) {
  const chapters = settings.chapters || [];
  if (module === 'practice') return { module, chapters, types: settings.practice?.types || [], count: settings.practice?.count || 0 };
  if (module === 'mistakes') return { module, chapters, types: settings.mistakes?.types || [], frequentOnly: !!settings.mistakes?.frequentOnly };
  // a mock exam drawn from past papers spans every chapter, so the chapter filter does not apply
  if (module === 'exam') return { module, chapters: settings.exam?.tag ? [] : chapters, perType: settings.exam?.perType || {}, tag: settings.exam?.tag || '' };
  return { module, chapters };
}

/**
 * @param course {questions}
 * @param progress {questions: {qid: p}}
 * @param cfg { module, types[], chapters[], count, frequentOnly, perType, mastery }
 * @param rand function returning [0,1) (injectable for tests)
 */
export function pickQuestions(course, progress, cfg, rand = Math.random) {
  const prog = progress.questions || {};
  const mastery = cfg.mastery ?? 3;
  const qs = course.questions.filter((q) => {
    if (cfg.types?.length && !cfg.types.includes(q.type)) return false;
    if (cfg.tag && !(q.tags || []).includes(cfg.tag)) return false;
    if (cfg.chapters?.length && !cfg.chapters.includes(q.chapter || '')) return false;
    const p = prog[q.id];
    if (cfg.module === 'mistakes' && !inMistakes(p, mastery)) return false;
    if (cfg.module === 'mistakes' && cfg.frequentOnly && !(p.wrong >= 2)) return false;
    if (cfg.module === 'starred' && !p?.starred) return false;
    return true;
  });

  if (cfg.module === 'exam') {
    // sample each type at random, then group by type like a real paper (random within each group)
    const byType = {};
    for (const q of shuffled(qs, rand)) (byType[q.type] ||= []).push(q);
    return TYPE_ORDER.flatMap((t) => (byType[t] || []).slice(0, Number(cfg.perType?.[t]) || 0));
  }
  const out = shuffled(qs, rand);
  const count = Number(cfg.count) || 0;
  return count > 0 ? out.slice(0, count) : out;
}

export function pointsFor(q, pointsCfg = DEFAULT_POINTS) {
  return q.score ?? pointsCfg[q.type] ?? 1;
}

/** Summary of the configured exam for display: [{type, label, count, points}], total questions/points, minutes. */
export function examSummary(settings, available = {}) {
  const exam = settings?.exam || {};
  const points = { ...DEFAULT_POINTS, ...(exam.points || {}) };
  const rows = TYPE_ORDER.filter((t) => exam.perType?.[t] > 0).map((t) => {
    const count = Math.min(exam.perType[t], available[t] ?? exam.perType[t]);
    return { type: t, label: TYPE_LABELS[t], count, points: points[t] };
  });
  return {
    rows,
    questions: rows.reduce((a, r) => a + r.count, 0),
    maxScore: rows.reduce((a, r) => a + r.count * r.points, 0),
    timeMin: exam.timeMin || 0,
    points,
  };
}

/** Score an answered exam. results: {qid: {score: 0..1, correct}} */
export function scoreExam(questions, results, pointsCfg = DEFAULT_POINTS) {
  const byType = {};
  let score = 0, maxScore = 0, correct = 0;
  for (const q of questions) {
    const pts = pointsFor(q, pointsCfg);
    const r = results[q.id];
    const got = r ? pts * (r.score || 0) : 0;
    const t = (byType[q.type] ||= { total: 0, correct: 0, score: 0, maxScore: 0 });
    t.total++; t.maxScore += pts; t.score += got;
    if (r?.correct) { t.correct++; correct++; }
    score += got; maxScore += pts;
  }
  const round = (x) => Math.round(x * 10) / 10;
  for (const t of Object.values(byType)) { t.score = round(t.score); }
  return { score: round(score), maxScore, correct, total: questions.length, byType };
}
