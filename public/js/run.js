// The answer flow: one question at a time, adapted to the session module.
//   practice / mistakes / starred — instant feedback after each question
//   exam      — no feedback, timer, hand in → self-grade short answers → score
//   review    — read-only walk through a finished session
import { $, $$, esc, toast, confirmDialog, fmtDuration, pct, topbar } from './ui.js';
import { grade, isBlank, TYPE_LABELS, isOpen } from './grade.js';
import { questionCard, googleUrl } from './answer.js';
import { loadCourse, recordAttempt, setFlags, recordExam, sessions, syncSessions, beforeExit } from './data.js';
import { MODULES, scoreExam, pointsFor, inMistakes } from './session.js';
import { navigate } from './nav.js';
import { openReparse } from './reparse.js';

let timerHandle = null;
let keyHandler = null;

// Practice clock: only time spent with the round on screen counts. s.activeMs holds the banked time;
// clock.since is when it last resumed (null while paused: round left, tab hidden, phone locked).
// Every save carries the time so far; pausing only banks it here, so an idle page left open never pushes its
// stale copy over progress made on another device — time after the last answer goes out with the next save.
const clock = { s: null, since: null };
const activeMs = (s) => (s.activeMs || 0) + (clock.s === s && clock.since ? Date.now() - clock.since : 0);
function bankClock(s) {
  if (clock.s !== s || !clock.since) return;
  s.activeMs = activeMs(s);
  clock.since = Date.now();
}
function pauseClock() {
  bankClock(clock.s);
  clock.since = null;
}
function resumeClock() {
  if (clock.s && !clock.since && document.visibilityState === 'visible') clock.since = Date.now();
}
beforeExit(pauseClock);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resumeClock(); });

/** opts.slot: where it is saved (default: its module; one-off sets use 'drill'). */
export function newSession(courseId, module, qids, opts = {}) {
  return {
    v: 1,
    courseId,
    module,
    slot: opts.slot || module,
    title: opts.title || MODULES[module]?.label || 'Practice',
    qids,
    idx: 0,
    entries: {},
    instant: module !== 'exam',
    startedAt: Date.now(),
    timeLimitSec: opts.timeLimitSec || 0,
    points: opts.points || null,
    phase: 'answering',
  };
}

export function teardownRun() {
  pauseClock();
  clock.s = null;
  clearInterval(timerHandle);
  timerHandle = null;
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = null;
}

function entry(s, qid) {
  return (s.entries[qid] ||= {});
}

/** Render the runner for a course's saved session in one slot (practice, mistakes, exam, starred, drill). */
export async function renderRun(root, courseId, slot, { reviewIdx } = {}) {
  teardownRun();
  const data = await loadCourse(courseId);
  await syncSessions(courseId); // another device may have moved this round on
  const s = sessions.get(courseId, slot);
  if (!s) { navigate(`#/c/${encodeURIComponent(courseId)}`); return; }
  s.slot ||= slot;
  const page = (what) => `#/c/${encodeURIComponent(courseId)}/${what}/${slot}`; // run / result pages of this slot
  // drop questions deleted since the session started
  s.qids = s.qids.filter((id) => data.byId.has(id));
  if (!s.qids.length) { sessions.clear(courseId, slot); toast('This session has no questions left', 'warn'); navigate(`#/c/${encodeURIComponent(courseId)}`); return; }
  if (reviewIdx != null) s.idx = Math.min(Math.max(0, reviewIdx), s.qids.length - 1);

  const isExam = s.module === 'exam';
  const view = () => {
    if (s.phase === 'grading') return { ids: s.gradingQids, mode: 'grade' };
    if (s.phase === 'done') return { ids: s.qids, mode: 'review' };
    return { ids: s.qids, mode: isExam ? 'exam' : 'practice' };
  };
  const curIdx = () => (s.phase === 'grading' ? (s.gradeIdx ||= 0) : s.idx);
  const setIdx = (i) => { if (s.phase === 'grading') s.gradeIdx = i; else s.idx = i; };

  root.innerHTML = `
    <div class="run ${isExam ? 'is-exam' : ''}">
      <header class="run-bar">
        <button class="icon-btn" data-act="exit" title="Leave (progress is kept)" aria-label="Leave">✕</button>
        <div class="run-title"><span class="run-module">${esc(s.title)}</span><span class="run-count" aria-live="polite"></span></div>
        <span class="timer" hidden></span>
        <button class="icon-btn" data-act="nav" title="Question list (M)" aria-label="Question list">▦</button>
      </header>
      <div class="progress" aria-hidden="true"><div class="progress-fill"></div></div>
      <div class="run-body">
        <main class="run-main" tabindex="-1"></main>
        <aside class="navigator" aria-label="Questions"><div class="nav-head"><b>Questions</b><button class="icon-btn" data-act="nav-close" aria-label="Close">✕</button></div><div class="nav-legend"></div><div class="nav-grid"></div></aside>
      </div>
      <footer class="run-actions">
        <a class="btn ghost verify" target="_blank" rel="noopener" title="Look this question up on Google (G)"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>Verify</a>
        <button class="btn primary" data-act="main"></button>
      </footer>
    </div>`;
  const main = $('.run-main', root);
  const nav = $('.navigator', root);

  const save = () => { bankClock(s); sessions.save(s); };

  function q() { const { ids } = view(); return data.byId.get(ids[curIdx()]); }

  // saving an answer is async: if the user has already left the page, there is nothing left to redraw
  function draw({ focus = false } = {}) {
    if (!main.isConnected) return;
    const { ids, mode } = view();
    const question = q();
    const st = entry(s, question.id);
    const p = data.progress.questions[question.id];
    const showFeedback = mode === 'review' || mode === 'grade' || (mode === 'practice' && st.submitted);
    const ctx = {
      mode: mode === 'grade' || mode === 'review' ? 'review' : mode,
      showFeedback,
      locked: mode === 'review' || mode === 'grade' || (mode === 'practice' && st.submitted),
      autoSubmit: mode === 'practice',
      points: isExam ? pointsFor(question, s.points || undefined) : null,
      onChange: (resp, redraw) => {
        st.response = resp;
        save();
        if (redraw) draw();
        else updateActions();
        drawNav();
      },
      onSubmit: (reveal = false) => (mode === 'practice' ? submit({ reveal }) : mode === 'exam' ? go(1) : null),
      onSelfGrade: (mode === 'practice' || mode === 'grade' || (mode === 'review' && isOpen(question.type) && !isExam)) ? (v) => selfGrade(question, st, v, mode) : null,
      footer: showFeedback && mode !== 'grade' ? noteFooter(question, p) : null,
    };
    main.replaceChildren(questionCard(question, st, ctx), questionTools(p, mode));
    $('.run-count', root).textContent = mode === 'grade'
      ? `Grade short answers · ${curIdx() + 1} / ${ids.length}`
      : `${curIdx() + 1} / ${ids.length}`;
    const done = ids.filter((id) => s.entries[id]?.submitted || (isExam && !isBlank(data.byId.get(id), s.entries[id]?.response))).length;
    $('.progress-fill', root).style.width = `${pct(done, ids.length)}%`;
    updateActions();
    drawNav();
    main.scrollTo?.({ top: 0 });
    window.scrollTo({ top: 0 });
    if (focus) {
      const first = main.querySelector('.blank-input:not([readonly]), .calc-row input:not([readonly]), .short-input:not([readonly])');
      if (first && matchMedia('(pointer: fine)').matches) first.focus({ preventScroll: true });
      else main.focus({ preventScroll: true });
    }
  }

  function updateActions() {
    if (!main.isConnected) return;
    const { ids, mode } = view();
    const i = curIdx();
    const question = q();
    const st = entry(s, question.id);
    const btn = $('[data-act="main"]', root);
    const last = i === ids.length - 1;
    btn.disabled = false;
    delete btn.dataset.skip;
    // Verify: Google search for this question, hidden while a mock exam is being answered
    const verify = $('.verify', root);
    verify.hidden = mode === 'exam';
    verify.href = googleUrl(question);
    if (mode === 'practice') {
      // the single action button: Submit once something is entered, Skip while the answer is empty
      if (!st.submitted && !isBlank(question, st.response)) { btn.textContent = 'Submit'; btn.dataset.do = 'submit'; }
      else if (!st.submitted) { btn.textContent = last ? 'Skip & finish' : 'Skip ›'; btn.dataset.do = last ? 'finish' : 'next'; btn.dataset.skip = '1'; }
      else if (last) { btn.textContent = 'Finish'; btn.dataset.do = 'finish'; }
      else { btn.textContent = 'Next ›'; btn.dataset.do = 'next'; }
      if (ungraded()) btn.dataset.blocked = '1'; else delete btn.dataset.blocked;
    } else if (mode === 'exam') {
      if (last) { btn.textContent = 'Hand in'; btn.dataset.do = 'handin'; }
      else { btn.textContent = 'Next ›'; btn.dataset.do = 'next'; }
    } else if (mode === 'grade') {
      if (last) { btn.textContent = 'See results'; btn.dataset.do = 'finalize'; }
      else { btn.textContent = 'Next ›'; btn.dataset.do = 'next'; }
    } else {
      if (last) { btn.textContent = 'Results'; btn.dataset.do = 'results'; }
      else { btn.textContent = 'Next ›'; btn.dataset.do = 'next'; }
    }
  }

  function stateOf(id) {
    const st = s.entries[id];
    const question = data.byId.get(id);
    if (!st) return '';
    if (s.phase === 'done' || st.submitted || st.selfGrade) {
      if (isOpen(question.type) && !st.selfGrade && s.phase !== 'done') return 'answered';
      const r = st.result;
      if (!r) return isBlank(question, st.response) ? 'skipped' : 'answered';
      return r.correct ? 'right' : r.score > 0 ? 'partial' : 'wrong';
    }
    return isBlank(question, st.response) ? '' : 'answered';
  }

  function drawNav() {
    if (!main.isConnected) return;
    const { ids } = view();
    const i = curIdx();
    $('.nav-grid', nav).innerHTML = ids.map((id, n) => {
      const qq = data.byId.get(id);
      const starred = data.progress.questions[id]?.starred;
      return `<button class="nav-cell ${stateOf(id)} ${n === i ? 'current' : ''} ${starred ? 'starred' : ''}" data-go="${n}" title="${esc(TYPE_LABELS[qq.type])}${starred ? ' · starred' : ''}" aria-label="Question ${n + 1}${starred ? ', starred' : ''}">${n + 1}${starred ? '<i aria-hidden="true">★</i>' : ''}</button>`;
    }).join('');
    $('.nav-legend', nav).innerHTML = isExam && s.phase === 'answering'
      ? '<span class="lg answered">answered</span><span class="lg">open</span><span class="lg-star">starred</span>'
      : '<span class="lg right">right</span><span class="lg wrong">wrong</span><span class="lg partial">partial</span><span class="lg-star">starred</span>';
  }

  /** Practice: a revealed short answer / definition must be self-graded before moving on (else it is never counted). */
  function ungraded() {
    const question = q();
    const st = s.entries[question.id];
    return view().mode === 'practice' && isOpen(question.type) && !!st?.submitted && !st.selfGrade;
  }
  function blockedByGrading() {
    if (!ungraded()) return false;
    toast('Grade it first: Y got it · P partly · N missed it', 'info');
    const row = $('.selfgrade', main);
    if (row) { row.classList.remove('nudge'); void row.offsetWidth; row.classList.add('nudge'); row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    return true;
  }

  function go(delta) {
    const { ids } = view();
    const n = curIdx() + delta;
    if (n < 0 || n >= ids.length) return;
    if (blockedByGrading()) return;
    setIdx(n);
    save();
    draw({ focus: true });
  }

  /** reveal: Ctrl+Enter with nothing entered — show the answer, counted as wrong ("I don't know"). */
  async function submit({ reveal = false } = {}) {
    const question = q();
    const st = entry(s, question.id);
    const blank = isBlank(question, st.response);
    if (st.submitted || (blank && !reveal)) return;
    if (blank) st.blank = true;
    st.result = grade(question, st.response);
    st.submitted = true;
    save();
    draw();
    if (!isOpen(question.type)) {
      try { await recordAttempt(courseId, { qid: question.id, correct: st.result.correct, score: st.result.score, response: st.response, mode: s.module }); }
      catch (e) { toast(`Not saved: ${e.message}`, 'error'); }
      drawNav();
      draw();
    }
  }

  async function selfGrade(question, st, v, mode) {
    const first = !st.selfGrade;
    st.selfGrade = v;
    const score = v === 'right' ? 1 : v === 'partial' ? 0.5 : 0;
    st.result = { ...(st.result || {}), correct: v === 'right', score };
    save();
    if (mode !== 'grade' && first) {
      try { await recordAttempt(courseId, { qid: question.id, correct: v === 'right', score, response: st.response, mode: s.module }); }
      catch (e) { toast(`Not saved: ${e.message}`, 'error'); }
    }
    draw();
    // first grade moves on by itself after a beat (so the choice shows); re-grading stays put, the last question waits for Finish
    const at = curIdx();
    if (first && mode !== 'review' && at < view().ids.length - 1) {
      setTimeout(() => { if (main.isConnected && curIdx() === at && q() === question) go(1); }, 350);
    }
  }

  async function handIn(auto = false) {
    const unanswered = s.qids.filter((id) => isBlank(data.byId.get(id), s.entries[id]?.response)).length;
    if (!auto && !(await confirmDialog('Hand in the exam?', unanswered ? `${unanswered} question(s) are unanswered.` : 'All questions answered.', 'Hand in'))) return;
    clearInterval(timerHandle);
    s.finishedAt = Date.now();
    for (const id of s.qids) {
      const qq = data.byId.get(id);
      const st = entry(s, id);
      st.blank = isBlank(qq, st.response);
      st.result = st.blank ? { correct: false, score: 0 } : grade(qq, st.response);
      st.submitted = true;
    }
    s.gradingQids = s.qids.filter((id) => isOpen(data.byId.get(id).type) && !s.entries[id].blank);
    if (s.gradingQids.length) {
      s.phase = 'grading';
      s.gradeIdx = 0;
      save();
      toast(auto ? 'Time is up — grade your short answers' : 'Now grade your short answers against the reference', 'info', 4000);
      renderRun(root, courseId, slot);
      return;
    }
    await finalize();
  }

  let finalizing = false;
  async function finalize() {
    if (finalizing) return; // a second tap (or the timer) while saving would record the exam twice
    finalizing = true;
    if (s.phase === 'grading') {
      const missing = s.gradingQids.filter((id) => !s.entries[id].selfGrade);
      if (missing.length && !(await confirmDialog('Some answers are ungraded', `${missing.length} short answer(s) not graded yet — they will count as 0.`, 'Continue'))) { finalizing = false; return; }
      for (const id of missing) s.entries[id].result = { correct: false, score: 0 };
    }
    s.phase = 'done';
    s.finishedAt ||= Date.now();
    const questions = s.qids.map((id) => data.byId.get(id));
    const results = Object.fromEntries(s.qids.map((id) => [id, s.entries[id]?.result]));
    s.summary = scoreExam(questions, results, s.points || undefined);
    s.summary.durationSec = Math.round((s.finishedAt - s.startedAt) / 1000);
    save();
    try {
      // blank answers are not counted as attempts: running out of time is not the same as getting it wrong
      for (const id of s.qids) {
        const st = s.entries[id];
        if (st.blank || !st.result) continue;
        await recordAttempt(courseId, { qid: id, correct: !!st.result.correct, score: st.result.score, response: st.response, mode: 'exam' });
      }
      await recordExam(courseId, { title: s.title, ...s.summary });
    } catch (e) { toast(`Not saved: ${e.message}`, 'error'); }
    navigate(page('result'));
  }

  function finish() {
    if (blockedByGrading()) return;
    s.phase = 'done';
    s.finishedAt = Date.now();
    pauseClock();
    const questions = s.qids.map((id) => data.byId.get(id));
    const results = Object.fromEntries(s.qids.map((id) => [id, s.entries[id]?.result]));
    s.summary = scoreExam(questions, results);
    s.summary.durationSec = Math.round(activeMs(s) / 1000);
    s.summary.attempted = s.qids.filter((id) => s.entries[id]?.result).length;
    save();
    navigate(page('result'));
  }

  /** Star and re-parse, under the question card (re-parse is hidden during a mock exam, no peeking at the source, and for courses you don't own). */
  function questionTools(p, mode) {
    const bar = document.createElement('div');
    bar.className = 'q-tools';
    bar.innerHTML = `<button type="button" class="btn ghost ${p?.starred ? 'on' : ''}" data-act="star" aria-pressed="${!!p?.starred}">${p?.starred ? '★ Starred' : '☆ Star'}<kbd class="key-hint">S</kbd></button>
      ${mode === 'exam' || !data.course.access?.canEdit ? '' : `<button type="button" class="btn ghost" data-act="reparse" title="Fix how this question was read from its source"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/><path d="M15 20h5"/></svg>Re-parse<kbd class="key-hint">P</kbd></button>`}`;
    return bar;
  }

  function noteFooter(question, p) {
    const wrap = document.createElement('div');
    wrap.className = 'note-footer';
    const inBook = inMistakes(p, data.masteryStreak);
    wrap.innerHTML = `
      <details ${p?.note ? 'open' : ''}><summary>📝 My note</summary><textarea rows="2" placeholder="Why I got it wrong, a trick to remember…">${esc(p?.note || '')}</textarea></details>
      <div class="note-meta">${p?.attempts ? `Seen ${p.attempts}× · right ${p.correct} · wrong ${p.wrong}${p.streak ? ` · streak ${p.streak}` : ''}` : ''}
      ${inBook ? `<button type="button" class="link-btn" data-act="clear">Remove from mistakes</button>` : ''}</div>`;
    const ta = $('textarea', wrap);
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    ta.addEventListener('change', async () => {
      try { await setFlags(courseId, { qid: question.id, note: ta.value }); toast('Note saved'); } catch (e) { toast(e.message, 'error'); }
    });
    $('[data-act="clear"]', wrap)?.addEventListener('click', async () => {
      await setFlags(courseId, { qid: question.id, cleared: true });
      toast('Removed from mistakes book');
      draw();
    });
    return wrap;
  }

  async function exit() {
    if (s.phase === 'done') { navigate(page('result')); return; }
    if (await confirmDialog('Leave this session?', 'Your answers are kept — you can resume it from the course page.', 'Leave')) {
      navigate(`#/c/${encodeURIComponent(courseId)}`);
    }
  }

  // ---------- events ----------
  // listen on the run element, not root: root survives re-renders and would collect duplicate handlers
  const runEl = $('.run', root);
  runEl.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act], [data-go]');
    if (!t || !runEl.contains(t)) return;
    if (t.dataset.go != null) {
      if (Number(t.dataset.go) !== curIdx() && blockedByGrading()) return;
      setIdx(Number(t.dataset.go)); save(); draw({ focus: true }); nav.classList.remove('open'); return;
    }
    const act = t.dataset.act;
    if (act === 'exit') exit();
    else if (act === 'nav') nav.classList.toggle('open');
    else if (act === 'reparse') {
      const res = await openReparse(courseId, q().id);
      if (!res) return;
      sessions.replaceQuestion(courseId, res.oldId, res.question.id);
      await loadCourse(courseId, { force: true });
      renderRun(root, courseId, slot);
    }
    else if (act === 'nav-close') nav.classList.remove('open');
    else if (act === 'star') {
      const question = q();
      const p = data.progress.questions[question.id];
      await setFlags(courseId, { qid: question.id, starred: !p?.starred });
      toast(!p?.starred ? 'Starred' : 'Unstarred');
      draw();
    } else if (act === 'main') {
      const what = t.dataset.do;
      if (what === 'submit') submit();
      else if (what === 'next') go(1);
      else if (what === 'finish') finish();
      else if (what === 'handin') handIn();
      else if (what === 'finalize') finalize();
      else if (what === 'results') navigate(page('result'));
    }
  });

  // swipe left/right between questions on touch screens
  let touch = null;
  main.addEventListener('touchstart', (e) => { if (e.touches.length === 1) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }; }, { passive: true });
  main.addEventListener('touchend', (e) => {
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y;
    const fast = Date.now() - touch.t < 600;
    touch = null;
    if (fast && Math.abs(dx) > 70 && Math.abs(dy) < 50 && !e.target.closest('input, textarea, .katex-display, pre, .keypad')) go(dx < 0 ? 1 : -1);
  }, { passive: true });

  keyHandler = (e) => {
    if (document.querySelector('dialog[open]')) return;
    // Ctrl/Cmd+Enter in practice: submit, or show the answer when nothing is entered (text fields handle it themselves)
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && view().mode === 'practice' && !e.target.closest?.('textarea, select, dialog')) {
      e.preventDefault();
      if (entry(s, q().id).submitted) $('[data-act="main"]', root).click(); else submit({ reveal: true });
      return;
    }
    if (e.target.closest?.('input, textarea, select, dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'ArrowRight') { go(1); e.preventDefault(); return; }
    if (k === 'ArrowLeft') { go(-1); e.preventDefault(); return; }
    if (k === 'Enter') { $('[data-act="main"]', root).click(); e.preventDefault(); return; }
    if (k === 's' || k === 'S') { $('[data-act="star"]', main).click(); return; }
    if ((k === 'g' || k === 'G') && !$('.verify', root).hidden) { $('.verify', root).click(); return; }
    if (k === 'm' || k === 'M') { nav.classList.toggle('open'); return; }
    if (k === 'Escape') { nav.classList.remove('open'); return; }
    const up = k.toUpperCase();
    const question = q();
    // option letters / numbers, T/F for true-false, Y/P/N (or 1-3) for self-grading
    let target = $$(`.selfgrade [data-keys~="${up}"]`, main)[0];
    if (!target && (question.type === 'single' || question.type === 'multi')) {
      const idx = /^[1-9]$/.test(k) ? Number(k) - 1 : 'ABCDEFGHIJKL'.indexOf(up);
      target = $$('.options .opt', main)[idx];
    }
    if (!target && question.type === 'judge') target = $(`.judge [data-key="${up === 'Y' || up === '1' ? 'T' : up === 'N' || up === '2' ? 'F' : up}"]`, main);
    if (!target && up === 'P') target = $('[data-act="reparse"]', main); // P = Partly while self-grading, else re-parse
    if (target) { target.click(); e.preventDefault(); }
  };
  document.addEventListener('keydown', keyHandler);

  if (isExam && s.timeLimitSec && s.phase === 'answering') {
    const el = $('.timer', root);
    el.hidden = false;
    const tick = () => {
      const left = s.timeLimitSec - (Date.now() - s.startedAt) / 1000;
      el.textContent = `⏱ ${fmtDuration(left)}`;
      el.classList.toggle('low', left < 300);
      if (left <= 0) { clearInterval(timerHandle); handIn(true); }
    };
    tick();
    timerHandle = setInterval(tick, 1000);
  } else if (s.phase === 'answering') {
    const el = $('.timer', root);
    el.hidden = false;
    el.classList.add('subtle');
    s.activeMs ??= 0; // rounds from before the clock paused start again from zero
    clock.s = s;
    resumeClock();
    const tick = () => { el.textContent = fmtDuration(activeMs(s) / 1000); };
    tick();
    timerHandle = setInterval(tick, 1000);
  }

  save();
  draw({ focus: true });
}

/** Result page for the finished session. */
export async function renderResult(root, courseId, slot) {
  teardownRun();
  const data = await loadCourse(courseId);
  await syncSessions(courseId); // another device may have moved this round on
  const s = sessions.get(courseId, slot);
  if (!s || s.phase !== 'done') { navigate(`#/c/${encodeURIComponent(courseId)}`); return; }
  const sum = s.summary;
  const isExam = s.module === 'exam';
  const ids = s.qids.filter((id) => data.byId.has(id));
  const wrongIds = ids.filter((id) => s.entries[id]?.result && !s.entries[id].result.correct);
  const attempted = ids.filter((id) => s.entries[id]?.result && !s.entries[id].blank).length;
  const acc = pct(sum.correct, attempted || 1);
  const headline = isExam
    ? `<div class="score-big"><b>${sum.score}</b><span>/ ${sum.maxScore}</span></div><p class="muted">${pct(sum.score, sum.maxScore)}% · ${sum.correct}/${sum.total} fully correct · ${fmtDuration(sum.durationSec)}</p>`
    : `<div class="score-big"><b>${acc}%</b></div><p class="muted">${sum.correct} of ${attempted} answered correctly${attempted < ids.length ? ` (${ids.length - attempted} skipped)` : ''} · ${fmtDuration(sum.durationSec)}</p>`;
  const rows = Object.entries(sum.byType).map(([t, v]) => `<tr><td>${esc(TYPE_LABELS[t])}</td><td>${v.correct}/${v.total}</td>${isExam ? `<td>${v.score}/${v.maxScore}</td>` : ''}<td><div class="bar"><span style="width:${pct(v.correct, v.total)}%"></span></div></td></tr>`).join('');
  root.innerHTML = `
    ${topbar(`<a href="#/">Courses</a> › <a href="#/c/${encodeURIComponent(courseId)}">${esc(data.course.name)}</a> › Results`)}
    <div class="page narrow">
      <section class="card result-card">
        <h2>${esc(s.title)} — done</h2>
        ${headline}
        <table class="type-table"><thead><tr><th>Type</th><th>Correct</th>${isExam ? '<th>Points</th>' : ''}<th></th></tr></thead><tbody>${rows}</tbody></table>
      </section>
      <section class="card">
        <h3>Questions</h3>
        <div class="nav-grid result-grid">${ids.map((id, n) => {
          const r = s.entries[id]?.result;
          const cls = !r || s.entries[id].blank ? 'skipped' : r.correct ? 'right' : r.score > 0 ? 'partial' : 'wrong';
          return `<a class="nav-cell ${cls}" href="#/c/${encodeURIComponent(courseId)}/review/${slot}/${n}" title="${esc(TYPE_LABELS[data.byId.get(id).type])}">${n + 1}</a>`;
        }).join('')}</div>
        <p class="hint">Tap a number to review that question with its answer and explanation.</p>
      </section>
      <div class="actions-row">
        <a class="btn ghost" href="#/c/${encodeURIComponent(courseId)}/review/${slot}/0">Review all</a>
        ${wrongIds.length ? `<button class="btn primary" data-act="retry">Practice the ${wrongIds.length} missed</button>` : ''}
        <a class="btn ghost" href="#/c/${encodeURIComponent(courseId)}">Back to course</a>
      </div>
    </div>`;
  $('[data-act="retry"]', root)?.addEventListener('click', () => {
    sessions.save(newSession(courseId, 'practice', wrongIds, { title: 'Missed questions', slot: 'drill' }));
    navigate(`#/c/${encodeURIComponent(courseId)}/run/drill`);
  });
}
