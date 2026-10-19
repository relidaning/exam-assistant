// Router + pages. Flow: course cards → course hub (module panels) → run → result; Settings decide what modules ask.
import { $, $$, esc, api, auth, toast, dialog, confirmDialog, pct, relTime, daysUntil, fmtDuration, settings, applySettings, topbar, themeIcon } from './ui.js';
import { md, mdInline } from './render.js';
import { TYPES, TYPE_LABELS, answerText, isOpen } from './grade.js';
import { loadCourse, peekCourse, invalidate, sessions } from './data.js';
import { MODULES, pickQuestions, inMistakes, accuracy, moduleConfig, examConfigured, examSummary, pointsFor, PAST_PAPER_TAG } from './session.js';
import { renderRun, renderResult, newSession, teardownRun } from './run.js';
import { navigate, startNav } from './nav.js';

const app = $('#app');
const enc = encodeURIComponent;

// The page is not zoomable. iOS Safari ignores user-scalable=no in the viewport meta, so its pinch gestures are blocked here.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-act="account"]')) { navigate('#/account'); return; }
  const b = e.target.closest('[data-setting]');
  if (b) {
    const s = b.dataset.setting;
    if (s === 'theme') settings.theme = { auto: 'light', light: 'dark', dark: 'auto' }[settings.theme];
    applySettings();
    if (s === 'theme') { b.innerHTML = themeIcon(); b.title = `Theme: ${settings.theme}`; }
    return;
  }
  // image zoom (lightbox)
  const img = e.target.closest('img[data-zoom]');
  if (img) {
    const d = document.createElement('dialog');
    d.className = 'lightbox';
    d.innerHTML = `<img src="${esc(img.src)}" alt="${esc(img.alt)}">`;
    d.addEventListener('click', () => d.close());
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    d.showModal();
  }
});

// ---------- router ----------
const routes = [
  [/^\/login$/, loginPage],
  [/^\/account$/, accountPage],
  [/^\/?$/, home],
  [/^\/import$/, importPage],
  [/^\/c\/([^/]+)$/, coursePage],
  [/^\/c\/([^/]+)\/settings(?:#\w+)?$/, settingsPage],
  [/^\/c\/([^/]+)\/setup\/\w+$/, settingsPage], // old links
  [/^\/c\/([^/]+)\/run\/(\w+)$/, (id, slot) => renderRun(app, id, slot)],
  [/^\/c\/([^/]+)\/review\/(\w+)\/(\d+)$/, (id, slot, n) => renderRun(app, id, slot, { reviewIdx: Number(n) })],
  [/^\/c\/([^/]+)\/result\/(\w+)$/, (id, slot) => renderResult(app, id, slot)],
  [/^\/c\/([^/]+)\/(?:run|result)$/, (id) => navigate(`#/c/${enc(id)}`)], // links from before per-module sessions
  [/^\/c\/([^/]+)\/stats$/, statsPage],
  [/^\/c\/([^/]+)\/manage$/, (id) => navigate(`#/c/${enc(id)}/settings#import`)], // old links
  [/^\/c\/([^/]+)\/print$/, printPage],
];

// Bumped on every page change; a page that awaited the server only redraws if it is still the current page.
let routeSeq = 0;

async function route() {
  routeSeq++;
  teardownRun();
  const hash = location.hash.replace(/^#/, '') || '/';
  const [pathPart, query = ''] = hash.split('?');
  if (auth.user === undefined) {
    const seq = routeSeq;
    try { Object.assign(auth, await api('GET', '/api/auth/me')); } catch (e) {
      app.innerHTML = `<div class="page narrow"><div class="card empty"><h2>Can't reach the server</h2><p>${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div></div>`;
      auth.user = undefined;
      return;
    }
    if (seq !== routeSeq) return;
  }
  if (!auth.user && pathPart !== '/login') { navigate(`#/login?next=${enc(hash)}`); return; }
  for (const [re, fn] of routes) {
    const m = re.exec(pathPart);
    if (!m) continue;
    document.body.dataset.route = pathPart.split('/')[3] || pathPart.split('/')[1] || 'home';
    const seq = routeSeq;
    try {
      await fn(...m.slice(1).map(decodeURIComponent), new URLSearchParams(query));
    } catch (e) {
      console.error(e);
      if (seq === routeSeq) app.innerHTML = `${topbar()}<div class="page narrow"><div class="card empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a class="btn" href="#/">Back to courses</a></div></div>`;
    }
    return;
  }
  navigate('#/');
}

// ---------- accounts ----------
// brand marks for the sign-in buttons (each provider's own colours)
const PROVIDER_ICONS = {
  google: '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>',
  github: '<svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
};
const providerHref = (id, { next = '/', link = false } = {}) => `/api/auth/oauth/${id}/start?next=${enc(next)}${link ? '&link=1' : ''}`;

async function loginPage(params) {
  const next = params?.get?.('next') || '/';
  if (auth.user) { navigate(`#${next}`); return; }
  let mode = auth.firstUser ? 'register' : 'login';
  const error = params?.get?.('error') || '';
  const providers = auth.providers || [];
  const draw = () => {
    app.innerHTML = `${topbar()}
      <div class="page login-page">
        <form class="card login-card" autocomplete="on">
          <span class="logo big" aria-hidden="true">✎</span>
          <h1>${mode === 'login' ? 'Sign in' : 'Create your account'}</h1>
          ${auth.firstUser ? `<p class="muted small">You're the first one here. This account becomes the admin and takes over the existing courses and progress.</p>`
            : `<p class="muted small">${mode === 'login' ? 'Your progress is private to your account.' : 'Practise public courses, make your own, and publish them for others.'}</p>`}
          ${providers.length ? `<div class="oauth-buttons">${providers.map((p) => `<a class="btn oauth-btn" href="${providerHref(p.id, { next })}">${PROVIDER_ICONS[p.id] || ''}Continue with ${esc(p.label)}</a>`).join('')}</div>
          <div class="or-line" role="separator"><span>or with a username</span></div>` : ''}
          <label class="field"><span>Username</span><input name="username" required minlength="2" maxlength="32" autocomplete="username" autocapitalize="off" spellcheck="false" ${providers.length ? '' : 'autofocus'}></label>
          <label class="field"><span>Password</span><input name="password" type="password" required minlength="${mode === 'login' ? 1 : 6}" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>
          ${mode === 'register' ? '<p class="hint">At least 6 characters.</p>' : ''}
          <p class="error-text small login-error" role="alert">${esc(error)}</p>
          <button class="btn primary big" type="submit">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
          ${auth.firstUser ? '' : `<p class="muted small login-switch">${mode === 'login' ? 'New here?' : 'Have an account?'} <button type="button" class="link-btn" data-act="switch">${mode === 'login' ? 'Create an account' : 'Sign in'}</button></p>`}
        </form>
      </div>`;
    $('[data-act="switch"]', app)?.addEventListener('click', () => { mode = mode === 'login' ? 'register' : 'login'; draw(); });
    $('form', app).addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try {
        const r = await api('POST', `/api/auth/${mode}`, body);
        auth.user = r.user;
        auth.firstUser = false;
        invalidate();
        coursesCache = null;
        navigate(`#${next === '/login' ? '/' : next}`);
      } catch (err) { $('.login-error', app).textContent = err.message; }
    });
  };
  draw();
}

/** Your account: who you are, how you sign in (password, linked Google/GitHub), sign out. */
async function accountPage(params) {
  const seq = routeSeq;
  Object.assign(auth, await api('GET', '/api/auth/me'));
  if (seq !== routeSeq) return;
  const u = auth.user;
  const linked = Object.fromEntries((auth.identities || []).map((x) => [x.provider, x]));
  const label = { google: 'Google', github: 'GitHub' };
  const shown = [...new Set([...(auth.providers || []).map((p) => p.id), ...Object.keys(linked)])];
  const signIns = (u.hasPassword ? 1 : 0) + Object.keys(linked).length;
  app.innerHTML = `${topbar(`<a href="#/">Courses</a> › Account`)}
    <div class="page narrow">
      <h1>${esc(u.username)}</h1>
      <p class="muted">${u.isAdmin ? 'Admin: you can also unpublish or delete any public course. ' : ''}Your answers, stars, notes and exam results are visible only to you.</p>
      <section class="card">
        <h3>Sign-in methods</h3>
        <ul class="signin-list">
          <li><span class="signin-ico" aria-hidden="true">🔑</span><span class="grow"><b>Password</b><small class="muted">${u.hasPassword ? `Sign in as “${esc(u.username)}”` : 'Not set'}</small></span>
            <button class="btn small ghost" data-act="password">${u.hasPassword ? 'Change' : 'Set password'}</button></li>
          ${shown.map((id) => `<li><span class="signin-ico" aria-hidden="true">${PROVIDER_ICONS[id] || ''}</span>
            <span class="grow"><b>${label[id] || esc(id)}</b><small class="muted">${linked[id] ? `Linked${linked[id].login || linked[id].email ? `: ${esc(linked[id].login || linked[id].email)}` : ''}` : 'Not linked'}</small></span>
            ${linked[id]
              ? `<button class="btn small ghost" data-unlink="${id}" ${signIns < 2 ? 'disabled title="It is your only way to sign in"' : ''}>Unlink</button>`
              : (auth.providers || []).some((p) => p.id === id) ? `<a class="btn small primary" href="${providerHref(id, { link: true })}">Link</a>` : ''}</li>`).join('')}
        </ul>
        ${shown.length ? '<p class="hint">Linking lets you sign in with that account too. Progress stays on this account.</p>' : '<p class="hint">Google and GitHub sign-in are not set up on this server.</p>'}
      </section>
      <section class="card"><h3>Sign out</h3><p class="muted">On this device. Your progress stays on the server.</p><button class="btn" data-act="logout">Sign out</button></section>
    </div>`;
  const note = params?.get?.('error') || (params?.get?.('linked') && `${label[params.get('linked')] || 'Account'} linked`);
  if (note) { toast(note, params.get('error') ? 'error' : 'ok', 4000); history.replaceState(history.state, '', '#/account'); }
  $('[data-act="logout"]', app).addEventListener('click', async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    location.hash = '#/login';
    location.reload(); // drop every cached course and round of this user
  });
  $$('[data-unlink]', app).forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.unlink;
    if (!(await confirmDialog(`Unlink ${label[id]}?`, `You won't be able to sign in with ${label[id]} any more.`, 'Unlink', true))) return;
    try { await api('DELETE', `/api/auth/identities/${id}`); toast(`${label[id]} unlinked`); accountPage(); } catch (e) { toast(e.message, 'error'); }
  }));
  $('[data-act="password"]', app).addEventListener('click', async () => {
    const { value, form } = await dialog({
      title: u.hasPassword ? 'Change password' : 'Set a password',
      body: `${u.hasPassword ? '<label class="field"><span>Current password</span><input name="current" type="password" required autocomplete="current-password"></label>' : `<p class="muted small">Then you can also sign in as “${esc(u.username)}” with it.</p>`}
        <label class="field"><span>New password</span><input name="password" type="password" required minlength="6" autocomplete="new-password"></label>`,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }],
      withForm: true,
    });
    if (value !== 'ok') return;
    try { await api('POST', '/api/auth/password', form); toast('Password saved', 'ok'); accountPage(); } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------- home: course cards ----------
// Question-type colours: categorical slots 1–6 in fixed order (validated light + dark), always shown with labels.
const TYPE_COLORS = { single: 'var(--t-single)', multi: 'var(--t-multi)', judge: 'var(--t-judge)', fill: 'var(--t-fill)', calc: 'var(--t-calc)', short: 'var(--t-short)', essay: 'var(--t-essay)', term: 'var(--t-term)' };

// Course colours: categorical slots (validated light + dark); ink flips to dark on the light hues.
const COURSE_COLORS = [
  ['#2a78d6', '#fff'], ['#eb6834', '#fff'], ['#1baf7a', '#fff'], ['#6250d6', '#fff'],
  ['#e87ba4', '#2b0d19'], ['#008300', '#fff'], ['#e34948', '#fff'], ['#eda100', '#2b1a00'],
];
function courseColor(id) {
  let h = 0x811c9dc5;
  for (const ch of String(id)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  const [c, on] = COURSE_COLORS[h % COURSE_COLORS.length];
  return `--c:${c};--on:${on}`;
}

function monogram(name, cls = '', id = name) {
  return `<span class="mono ${cls}" style="${courseColor(id)}" aria-hidden="true">${esc([...String(name).trim()][0] || '·')}</span>`;
}

/** Progress ring: share of questions practiced at least once. */
function ring(value, label, size = 76) {
  const r = (size - 8) / 2, c = 2 * Math.PI * r;
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${value}% ${label}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-track"/>
    ${value > 0 ? `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-fill" stroke-dasharray="${(c * value) / 100} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/>` : ''}
    <text x="50%" y="47%" class="ring-value">${value}%</text><text x="50%" y="66%" class="ring-label">${label}</text>
  </svg>`;
}

/** Segmented bar of the question-type mix, with a labelled legend (identity never by colour alone). */
function typeMix(byType, total) {
  const types = TYPES.filter((t) => byType[t]);
  if (!total) return '';
  return `<div class="mix" role="img" aria-label="${types.map((t) => `${TYPE_LABELS[t]} ${byType[t]}`).join(', ')}">
      ${types.map((t) => `<span style="flex:${byType[t]};background:${TYPE_COLORS[t]}" title="${esc(TYPE_LABELS[t])}: ${byType[t]} (${pct(byType[t], total)}%)"></span>`).join('')}
    </div>
    <ul class="mix-legend">${types.map((t) => `<li><i style="background:${TYPE_COLORS[t]}"></i>${esc(TYPE_LABELS[t])} <b>${byType[t]}</b></li>`).join('')}</ul>`;
}

function countdownPill(examDate) {
  const days = daysUntil(examDate);
  if (days == null || days < 0) return '';
  return `<span class="pill ${days <= 3 ? 'urgent' : ''}" title="Exam on ${esc(examDate)}">${days === 0 ? 'Exam today' : days === 1 ? 'Exam tomorrow' : `Exam in ${days} days`}</span>`;
}

// Course list and course page draw from memory first and refresh in the background, so going Back paints the right
// page in the same frame (no flash of the page being left), and redraw only if the server copy differs.
let coursesCache = null;

async function home() {
  const seq = routeSeq;
  if (coursesCache) drawHome(coursesCache);
  const courses = await api('GET', '/api/courses');
  if (seq !== routeSeq) return;
  if (!coursesCache || JSON.stringify(courses) !== JSON.stringify(coursesCache)) drawHome(courses);
  coursesCache = courses;
}

const GLOBE = '<svg class="ico-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
const LOCK = '<svg class="ico-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

/** Who a course belongs to and whether others see it, in one short line. */
function courseOwnerLine(c) {
  if (c.mine ?? c.access?.isOwner) return c.visibility === 'public' ? `${GLOBE}Public` : `${LOCK}Private`;
  return c.owner ? `by ${esc(c.owner.username)}` : '';
}

function drawHome(courses) {
  // kept deliberately light: numbers live on the Statistics page, not in the list
  const tile = (c, showCount) => `<a class="course-tile" href="#/c/${enc(c.id)}" style="${courseColor(c.id)}">
      <span class="ct-mono" aria-hidden="true">${esc([...String(c.name).trim()][0] || '·')}</span>
      <span class="ct-name">${esc(c.name)}</span>
      ${c.description ? `<span class="ct-desc">${esc(c.description)}</span>` : ''}
      <span class="ct-meta">${courseOwnerLine(c)}${showCount ? ` · ${c.stats.total} q` : ''}</span>
      ${countdownPill(c.examDate)}
    </a>`;
  // yours: the ones you own, plus public ones you have started; the rest of the public ones below
  const started = (c) => c.stats.attempts || c.stats.exams || c.stats.starred;
  const mine = courses.filter((c) => c.mine || started(c));
  const others = courses.filter((c) => !mine.includes(c));
  app.innerHTML = `${topbar()}
    <div class="page">
      <div class="page-head">
        <h1>Your courses</h1>
        <div class="actions-row"><a class="btn ghost" href="#/import">Import questions</a><button class="btn primary" data-act="new">+ New course</button></div>
      </div>
      ${mine.length ? `<div class="course-tiles">${mine.map((c) => tile(c, false)).join('')}</div>` : `
      <div class="card empty">
        <h2>No courses yet</h2>
        <p>${others.length ? 'Pick a public course below and start practising, or make your own' : 'Create a course and import questions'}: paste a paper, upload Markdown/JSON, or ask Claude in the terminal:</p>
        <ul class="tips">
          <li>“Find past exam papers for <i>Linear Algebra</i> and load them”</li>
          <li>“Load the questions from my vault notes in <i>Courses/Physics</i>”</li>
          <li>“Here are my test questions: …”</li>
        </ul>
        <button class="btn primary" data-act="new">+ New course</button>
      </div>`}
      ${others.length ? `
      <div class="page-head public-head">
        <h2>Public courses</h2>
        ${others.length > 6 ? '<input type="search" class="course-search" placeholder="Search public courses" aria-label="Search public courses">' : ''}
      </div>
      <p class="muted small">Shared by others. Practise them with your own private progress, or fork one to edit your own copy.</p>
      <div class="course-tiles public-tiles">${others.map((c) => tile(c, true)).join('')}</div>` : ''}
    </div>`;
  $$('[data-act="new"]', app).forEach((b) => b.addEventListener('click', newCourseDialog));
  const search = $('.course-search', app);
  search?.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    $$('.public-tiles .course-tile', app).forEach((t, i) => { t.hidden = !!q && !`${others[i].name} ${others[i].description} ${others[i].owner?.username || ''}`.toLowerCase().includes(q); });
  });
}

async function newCourseDialog() {
  const { value, form } = await dialog({
    title: 'New course',
    body: `<label class="field"><span>Name</span><input name="name" required placeholder="e.g. Linear Algebra" autofocus></label>
      <label class="field"><span>Description</span><input name="description" placeholder="optional"></label>
      <label class="field"><span>Exam date</span><input name="examDate" type="date"></label>
      <p class="hint">New courses are private. Publish one from its page when you want others to see it.</p>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Create', value: 'ok', primary: true }],
    withForm: true,
  });
  if (value !== 'ok' || !form.name?.trim()) return;
  try {
    const c = await api('POST', '/api/courses', { name: form.name.trim(), description: form.description.trim() });
    if (form.examDate) await api('PATCH', `/api/courses/${enc(c.id)}`, { examDate: form.examDate });
    toast(`Created “${c.name}”`, 'ok');
    navigate(`#/c/${enc(c.id)}/settings#import`);
  } catch (err) { toast(err.message, 'error'); }
}

// ---------- course hub: module panels ----------
// Line icons (24px grid, stroke = currentColor) so every module reads as one family.
const ICONS = {
  practice: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  mistakes: '<path d="M3.5 12a8.5 8.5 0 1 0 2.8-6.3"/><path d="M3 3.5v5h5"/><path d="M10 10l4 4m0-4l-4 4"/>',
  exam: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 10v3.5l2.5 2M9.5 2.5h5M12 2.5V6"/>',
  starred: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z"/>',
  stats: '<path d="M5 20v-8m6 8V5m6 15v-5M3 20h18"/>',
  settings: '<path d="M4 7h9m4 0h3M4 12h3m4 0h9M4 17h11m4 0h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
};
const icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

async function coursePage(id) {
  const seq = routeSeq;
  const cached = peekCourse(id);
  if (cached) drawCourse(id, cached);
  const fresh = await loadCourse(id, { force: true });
  if (seq !== routeSeq) return;
  // only what this page shows; server-side stats are left out so they don't force a redraw
  const shown = (d) => JSON.stringify([d.course.name, d.course.description, d.course.examDate, d.course.visibility, d.course.access, d.course.forkedFrom, d.course.questions.length, d.progress, d.masteryStreak]);
  if (!cached || shown(cached) !== shown(fresh)) drawCourse(id, fresh);
}

function drawCourse(id, data) {
  const { course, progress, stats } = data;
  const st = progress.settings;
  const inProgress = Object.fromEntries(sessions.unfinished(id).map((x) => [x.slot, x]));
  const drill = inProgress.drill;
  const pool = (m, extra = {}) => pickQuestions(course, progress, { ...moduleConfig(m, { ...st, ...extra }), mastery: data.masteryStreak });
  const practiceCount = pool('practice', { practice: { ...st.practice, count: 0 } }).length;
  const mistakes = pool('mistakes').length;
  const starred = pool('starred').length;
  const exam = examSummary(st, stats.byType);
  const examReady = examConfigured(st);
  const base = `#/c/${enc(id)}`;

  // each module keeps its own colour everywhere (ink flips to dark on the yellow tile)
  const tiles = [
    { key: 'practice', title: 'Practice', info: `${practiceCount} questions`, n: practiceCount, color: '#2a78d6' },
    { key: 'mistakes', title: 'Mistakes', info: mistakes ? `${mistakes} to review` : 'All clear', n: mistakes, color: '#e34948' },
    examReady
      ? { key: 'exam', title: 'Mock exam', info: `${exam.questions} q · ${exam.timeMin ? `${exam.timeMin} min` : 'no limit'}`, n: exam.questions, color: '#6250d6' }
      : { key: 'exam', title: 'Mock exam', info: 'Tap to set up', href: `${base}/settings#exam`, color: '#6250d6', unset: true },
    { key: 'starred', title: 'Starred', info: starred ? `${starred} saved` : 'None yet', n: starred, color: '#eda100', on: '#2b1a00' },
    { key: 'stats', title: 'Statistics', info: 'Progress & history', href: `${base}/stats`, color: '#1baf7a' },
    { key: 'settings', title: 'Settings', info: 'Types, exam, import', href: `${base}/settings`, color: '#64748b' },
  ];
  const tile = (t) => {
    // a module with an unfinished session says so; tapping it offers Resume / Start new
    const run = inProgress[t.key];
    const info = run && (run.answered || run.phase !== 'answering') ? `In progress · ${run.answered}/${run.qids.length}` : t.info;
    const attrs = `class="mtile ${t.unset ? 'unset' : ''} ${run ? 'resumable' : ''}" data-mod="${t.key}" style="--c:${t.color};--on:${t.on || '#fff'}"`;
    const inner = `${icon(t.key, 'mtile-ico')}<span class="mtile-title">${t.title}</span><span class="mtile-info">${info}</span>`;
    return t.href
      ? `<a href="${t.href}" ${attrs}>${inner}</a>`
      : `<button type="button" ${attrs} data-start="${t.key}" ${t.n ? '' : 'aria-disabled="true"'}>${inner}</button>`;
  };

  app.innerHTML = `${topbar(`<a href="#/">Courses</a> › ${esc(course.name)}`)}
    <div class="page">
      <section class="hero">
        <div class="hero-main">
          ${monogram(course.name, 'big', course.id)}
          <div class="hero-text">
            <h1>${esc(course.name)}</h1>
            ${course.description ? `<p class="muted">${esc(course.description)}</p>` : ''}
            <p class="course-meta">${courseOwnerLine(course)}${course.forkedFrom ? ` · forked from <a href="#/c/${enc(course.forkedFrom.id)}">${esc(course.forkedFrom.name)}</a>` : ''}</p>
            ${countdownPill(course.examDate)}
          </div>
        </div>
        <div class="hero-actions">
          ${course.access.isOwner ? `<button class="btn small ${course.visibility === 'public' ? 'ghost' : 'primary'}" data-act="visibility">${course.visibility === 'public' ? `${LOCK}Make private` : `${GLOBE}Publish`}</button>`
            : course.access.canManage ? `<button class="btn small ghost" data-act="visibility">${LOCK}Unpublish</button>` : ''}
          <button class="btn small ghost" data-act="fork" title="Copy this course into your own private course to edit it">Fork</button>
        </div>
      </section>
      ${drill ? `<div class="resume">
        <span class="resume-dot" aria-hidden="true"></span>
        <div class="grow"><b>${esc(drill.title)}</b> in progress<span class="muted"> · ${drill.answered} of ${drill.qids.length} answered · started ${relTime(new Date(drill.startedAt).toISOString())}</span></div>
        <div class="actions-row"><button class="btn ghost small" data-act="discard">Discard</button><a class="btn primary small" href="${base}/run/drill">Resume</a></div>
      </div>` : ''}
      ${!stats.total ? `<div class="card empty"><h2>No questions yet</h2><p>Import a paper, notes, or a JSON bank to get started.</p><a class="btn primary" href="${base}/settings#import">Import questions</a></div>` : ''}
      <div class="mtiles">${tiles.slice(0, 4).map(tile).join('')}</div>
      <div class="mtiles tools-row">${tiles.slice(4).map(tile).join('')}</div>
    </div>`;
  $('[data-act="discard"]', app)?.addEventListener('click', async () => {
    if (await confirmDialog('Discard unfinished session?', 'Answers already submitted stay in your history.', 'Discard', true)) { sessions.clear(id, 'drill'); coursePage(id); }
  });
  $('[data-act="visibility"]', app)?.addEventListener('click', () => toggleVisibility(data));
  $('[data-act="fork"]', app)?.addEventListener('click', () => forkDialog(data));
  $$('[data-start]', app).forEach((b) => b.addEventListener('click', () => {
    if (b.getAttribute('aria-disabled') === 'true') {
      toast({ mistakes: 'No mistakes to review — nice!', starred: 'Tap ☆ on a question to save it here', practice: 'No questions match your Settings' }[b.dataset.start] || 'Nothing here yet', 'info');
      return;
    }
    startSession(id, b.dataset.start);
  }));
}

/** Publish (everyone signed in sees it) or take a course private again. */
async function toggleVisibility(data) {
  const { course } = data;
  const going = course.visibility === 'public' ? 'private' : 'public';
  const others = data.learners ? ` ${data.learners} other ${data.learners === 1 ? 'person has' : 'people have'} practised it; they lose access until it is published again (their progress is kept).` : '';
  const ok = going === 'public'
    ? await confirmDialog(`Publish “${course.name}”?`, 'Everyone with an account will see this course and its questions, and can practise it or fork it. Your own progress stays private, and only you can edit the course.', 'Publish')
    : await confirmDialog(`Make “${course.name}” private?`, `Only ${course.access.isOwner ? 'you' : 'its owner'} will see it.${others}`, course.access.isOwner ? 'Make private' : 'Unpublish', true);
  if (!ok) return;
  try {
    await api('PATCH', `/api/courses/${enc(course.id)}`, { visibility: going });
    invalidate(course.id);
    coursesCache = null;
    toast(going === 'public' ? 'Published: everyone can find it under Public courses' : 'Course is private now', 'ok');
    if (course.access.isOwner) coursePage(course.id); else navigate('#/');
  } catch (e) { toast(e.message, 'error'); }
}

/** Copy a course into a private one of your own, optionally with your progress (question ids stay the same). */
async function forkDialog(data) {
  const { course, stats } = data;
  const hasProgress = stats.attempts || data.progress.exams.length || stats.starred;
  const { value, form } = await dialog({
    title: 'Fork this course',
    body: `<p class="muted small">Makes a private copy that you own: fix questions, import more, change the details, then publish it if you like. ${course.access.isOwner ? '' : `The original by ${esc(course.owner?.username || 'its owner')} stays as it is.`}</p>
      <label class="field"><span>Name</span><input name="name" value="${esc(course.name)}" required></label>
      <label class="switch"><input type="checkbox" name="withProgress" ${hasProgress ? 'checked' : ''}><span>Copy my progress too (answers, stars, notes, mock exams, settings)</span></label>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Fork', value: 'ok', primary: true }],
    withForm: true,
  });
  if (value !== 'ok') return;
  try {
    const c = await api('POST', `/api/courses/${enc(course.id)}/fork`, { name: form.name, withProgress: form.withProgress === 'on' });
    coursesCache = null;
    toast(`Forked into “${c.name}”`, 'ok');
    navigate(`#/c/${enc(c.id)}`);
  } catch (e) { toast(e.message, 'error'); }
}

function typesText(types) {
  return types?.length ? types.map((t) => TYPE_LABELS[t]).join(', ') : 'all types';
}

function lastExamText(e) {
  return `${e.maxScore ? pct(e.score, e.maxScore) : 0}% · ${relTime(e.at)}`;
}

function chapterStats(course, prog) {
  const map = new Map();
  for (const q of course.questions) {
    const name = q.chapter || '';
    const c = map.get(name) || { name, total: 0, answered: 0, correct: 0, attempts: 0, wrong: 0 };
    c.total++;
    const p = prog[q.id];
    if (p?.attempts) { c.answered++; c.correct += p.correct; c.attempts += p.attempts; c.wrong += p.wrong; }
    map.set(name, c);
  }
  return [...map.values()];
}

/** Start a module with the course settings: questions are always shuffled. */
async function startSession(id, module) {
  const data = await loadCourse(id, { force: true });
  const st = data.progress.settings;
  if (module === 'exam' && !examConfigured(st)) { navigate(`#/c/${enc(id)}/settings#exam`); return; }
  const qs = pickQuestions(data.course, data.progress, { ...moduleConfig(module, st), mastery: data.masteryStreak });
  if (!qs.length) { toast('No questions match the settings for this module', 'warn'); return; }
  // each module keeps its own unfinished session: offer to resume it rather than replace it
  const existing = sessions.unfinished(id).find((x) => x.slot === module);
  if (existing && (existing.answered || existing.phase !== 'answering')) {
    const choice = await dialog({
      title: `${MODULES[module].label} in progress`,
      body: `<p>You've answered <b>${existing.answered}</b> of ${existing.qids.length} questions${existing.phase === 'grading' ? ' and handed in — the short answers still need grading' : ''}.</p>`,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Start new', value: 'new' }, { label: 'Resume', value: 'resume', primary: true }],
    });
    if (!choice) return;
    if (choice === 'resume') { navigate(`#/c/${enc(id)}/run/${module}`); return; }
  }
  let ids = qs.map((q) => q.id);
  let title = module === 'exam' ? `Mock exam ${new Date().toLocaleDateString()}` : MODULES[module].label;
  if (module === 'exam') {
    // with past papers imported, sit one real paper as it was set; without, a draw by the exam settings
    const pick = await choosePaper(data);
    if (!pick) return;
    if (pick.paper) { ids = pick.paper.questions.map((q) => q.id); title = pick.paper.name; }
  }
  const opts = module === 'exam'
    ? { title, timeLimitSec: (st.exam.timeMin || 0) * 60, points: examSummary(st).points }
    : { title };
  sessions.save(newSession(id, module, ids, opts));
  navigate(`#/c/${enc(id)}/run/${module}`);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Sitting date in a paper name as year * 100 + month (month 0 when only the year is given), or -1 if none. */
function paperDate(name) {
  let m = name.match(/((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月/) || name.match(/\b((?:19|20)\d{2})[-./](\d{1,2})\b/);
  if (m) return m[1] * 100 + Number(m[2]);
  m = name.match(/\b([a-z]{3})[a-z]*\.?\s+((?:19|20)\d{2})\b/i) || name.match(/\b((?:19|20)\d{2})\s+([a-z]{3})[a-z]*\b/i);
  if (m) {
    const [mon, year] = /\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    const i = MONTHS.indexOf(mon.toLowerCase());
    if (i >= 0) return year * 100 + i + 1;
  }
  m = name.match(/(?:^|[^\d])((?:19|20)\d{2})(?!\d)/);
  return m ? m[1] * 100 : -1;
}

/** Past papers of a course, newest sitting first (undated ones last, in import order): [{ name, questions }]. */
function pastPapers(course) {
  const papers = new Map();
  for (const q of course.questions) {
    if (!(q.tags || []).includes(PAST_PAPER_TAG)) continue;
    const name = q.source || 'Past paper';
    if (!papers.has(name)) papers.set(name, { name, questions: [] });
    papers.get(name).questions.push(q);
  }
  return [...papers.values()].sort((a, b) => paperDate(b.name) - paperDate(a.name)); // stable: ties keep import order
}

/** Resolves { paper } for the chosen real paper, { mix: true } when the course has none, or null when cancelled. */
async function choosePaper(data) {
  const papers = pastPapers(data.course);
  if (!papers.length) return { mix: true };
  const pts = examSummary(data.progress.settings).points;
  const sittings = (name) => data.progress.exams.filter((x) => x.title === name);
  const done = (taken) => {
    if (!taken.length) return '<small class="paper-done todo">Not taken yet</small>';
    const last = taken.at(-1), lastPct = pct(last.score, last.maxScore);
    const best = Math.max(...taken.map((e) => pct(e.score, e.maxScore)));
    return `<small class="paper-done">✓ Done${taken.length > 1 ? ` ×${taken.length}` : ''} · ${lastPct}%${best > lastPct ? ` (best ${best}%)` : ''}
      · ${last.correct}/${last.total} right · ${fmtDuration(last.durationSec || 0)} · ${relTime(last.at)}</small>`;
  };
  const short = (name) => name.replace(/^\d+\s*/, ''); // "15040 2025年4月真题" → "2025年4月真题"
  const first = Math.max(0, papers.findIndex((p) => !sittings(p.name).length)); // newest paper not sat yet
  const { value, form } = await dialog({
    title: 'Which paper?',
    body: `<p class="muted small">Sit one real paper exactly as it was set. Newest first.</p>
      <div class="paper-list">
        ${papers.map((p, i) => `<label class="paper-opt"><input type="radio" name="paper" value="${i}" ${i === first ? 'checked' : ''}>
          <span><b>${esc(short(p.name))}</b><small>${p.questions.length} questions · ${p.questions.reduce((a, q) => a + pointsFor(q, pts), 0)} pts</small>${done(sittings(p.name))}</span></label>`).join('')}
      </div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Start', value: 'start', primary: true }],
    withForm: true,
  });
  if (value !== 'start') return null;
  return { paper: papers[Number(form.paper)] };
}

// ---------- settings: what each module draws from ----------
async function settingsPage(id) {
  const seq = routeSeq;
  const data = await loadCourse(id, { force: true });
  if (seq !== routeSeq) return; // left while loading
  const { course, progress } = data;
  const st = structuredClone(progress.settings);
  const chapters = chapterStats(course, progress.questions);
  const typeCountsFor = (chs) => {
    const out = {};
    for (const q of course.questions) if (!chs.length || chs.includes(q.chapter || '')) out[q.type] = (out[q.type] || 0) + 1;
    return out;
  };
  const allTypes = TYPES.filter((t) => course.questions.some((q) => q.type === t));
  const typeChips = (name, selected, counts) => allTypes.map((t) => `<label class="chip"><input type="checkbox" name="${name}" value="${t}" ${selected.includes(t) ? 'checked' : ''}><span>${esc(TYPE_LABELS[t])} <b data-count="${t}">${counts[t] || 0}</b></span></label>`).join('');
  const countOpts = [[0, 'All'], [20, '20'], [50, '50'], [100, '100']];
  const isPreset = countOpts.some(([v]) => v === st.practice.count);
  const ex = examSummary(st);
  const pastPaperCount = course.questions.filter((q) => (q.tags || []).includes(PAST_PAPER_TAG)).length;
  // questions the exam can draw from, per type: past papers only (any chapter) or the chosen chapters
  const examCounts = (cur) => {
    const out = {};
    for (const q of course.questions) {
      const ok = cur.exam.tag ? (q.tags || []).includes(cur.exam.tag) : (!cur.chapters.length || cur.chapters.includes(q.chapter || ''));
      if (ok) out[q.type] = (out[q.type] || 0) + 1;
    }
    return out;
  };

  app.innerHTML = `${topbar(`<a href="#/">Courses</a> › <a href="#/c/${enc(id)}">${esc(course.name)}</a> › Settings`)}
    <div class="page narrow">
      <h1>⚙️ Settings</h1>
      <p class="muted">Choose what each module asks. Questions are always shuffled.
        ${course.access.isOwner ? (course.visibility === 'public' ? 'Your settings are also where everyone else who practises this course starts.' : '')
          : `These are your own: you start from ${esc(course.owner?.username || 'the owner')}'s settings, and changing them affects only you.`}</p>
      <form class="settings" autocomplete="off">
        <section class="card">
          <h3>Chapters <span class="muted small">— used by every module</span></h3>
          ${chapters.length > 1 ? `
          <div class="actions-row small-gap"><button type="button" class="btn small ghost" data-chapters="all">All chapters</button><button type="button" class="btn small ghost" data-chapters="none">Clear</button></div>
          <div class="chapter-list">${chapters.map((c) => `
            <label class="chapter-row"><input type="checkbox" name="chapters" value="${esc(c.name)}" ${st.chapters.includes(c.name) ? 'checked' : ''}>
              <span class="grow">${esc(c.name || 'No chapter')}</span>
              <span class="muted">${c.total} q</span>
              <span class="acc">${c.attempts ? pct(c.correct, c.attempts) + '%' : '—'}</span>
              <span class="meter small"><span style="width:${pct(c.answered, c.total)}%"></span></span>
            </label>`).join('')}</div>
          <p class="hint">None ticked = all chapters.</p>` : '<p class="muted">This course has a single chapter.</p>'}
        </section>
        <section class="card">
          <h3>📝 Practice <span class="match muted small" data-match="practice"></span></h3>
          <fieldset><legend>Question types</legend><div class="chips toggle">${typeChips('practice-types', st.practice.types, {})}</div><p class="hint">None ticked = all types.</p></fieldset>
          <fieldset><legend>Questions per session</legend>
            <div class="segmented">${countOpts.map(([v, l]) => `<label><input type="radio" name="practice-count" value="${v}" ${st.practice.count === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
            <label><input type="radio" name="practice-count" value="custom" ${isPreset ? '' : 'checked'}><span>Custom</span></label></div>
            <input type="number" name="practice-custom" min="1" class="custom-count" value="${isPreset ? 30 : st.practice.count}" ${isPreset ? 'hidden' : ''}>
          </fieldset>
        </section>
        <section class="card">
          <h3>❌ Mistakes <span class="match muted small" data-match="mistakes"></span></h3>
          <fieldset><legend>Question types</legend><div class="chips toggle">${typeChips('mistakes-types', st.mistakes.types, {})}</div></fieldset>
          <label class="switch"><input type="checkbox" name="mistakes-frequent" ${st.mistakes.frequentOnly ? 'checked' : ''}><span>Only frequent mistakes (wrong 2× or more)</span></label>
        </section>
        <section class="card" id="exam">
          <h3>⏱️ Mock exam</h3>
          <p class="muted small">Set how many questions of each type the exam has. Leave all at 0 to keep the exam module off.</p>
          ${pastPaperCount ? `<fieldset><legend>Draw questions from</legend><div class="segmented">
            <label><input type="radio" name="exam-tag" value="" ${st.exam.tag ? '' : 'checked'}><span>Whole course</span></label>
            <label><input type="radio" name="exam-tag" value="${PAST_PAPER_TAG}" ${st.exam.tag === PAST_PAPER_TAG ? 'checked' : ''}><span>Past papers only (${pastPaperCount})</span></label>
          </div></fieldset>` : ''}
          <div class="per-type"><table class="type-table"><thead><tr><th>Type</th><th>Questions</th><th>Points each</th></tr></thead><tbody>
            ${allTypes.map((t) => `<tr><td>${esc(TYPE_LABELS[t])}</td>
              <td><input type="number" min="0" name="exam-n-${t}" value="${st.exam.perType[t] || 0}"> <span class="muted">/ <span data-avail="${t}"></span></span></td>
              <td><input type="number" min="0" step="0.5" name="exam-p-${t}" value="${ex.points[t]}"></td></tr>`).join('')}
          </tbody></table></div>
          <label class="field inline"><span>Duration (minutes, 0 = no limit)</span><input type="number" min="0" max="600" name="exam-time" value="${st.exam.timeMin || 90}"></label>
          <p class="exam-total"></p>
        </section>
        <div class="settings-foot"><a class="btn ghost" href="#/c/${enc(id)}">Cancel</a><button class="btn primary big" type="submit">Save settings</button></div>
      </form>

      <h2 class="section-title">Course</h2>
      ${course.access.canEdit ? `<form class="card course-form" id="course">
        <label class="field"><span>Name</span><input name="name" value="${esc(course.name)}" required></label>
        <label class="field"><span>Description</span><input name="description" value="${esc(course.description || '')}"></label>
        <label class="field"><span>Exam date</span><input name="examDate" type="date" value="${esc(course.examDate || '')}"></label>
        <div class="actions-row"><button class="btn primary" type="submit">Save course</button></div>
      </form>
      <section class="card" id="import"></section>` : `<section class="card" id="course">
        <h3>${courseOwnerLine(course)}</h3>
        <p class="muted">Only its owner can change the questions or details. Fork it to get your own copy that you can edit (and publish).</p>
        <div class="actions-row"><button class="btn primary" data-act="fork">Fork this course</button></div>
      </section>`}
      <section class="card">
        <h3>Export &amp; print</h3>
        <div class="actions-row">
          <a class="btn ghost" href="/api/courses/${enc(id)}/export" download="${esc(id)}.json">⬇ Export JSON</a>
          <a class="btn ghost" href="#/c/${enc(id)}/print">🖨 Printable paper</a>
        </div>
        ${course.sources?.length ? `<details><summary>Import history (${course.sources.length})</summary><ul class="sources">${course.sources.slice().reverse().map((x) => `<li>${esc(relTime(x.at))} — ${esc(x.kind)}: ${esc(x.name || '')} (${x.count})</li>`).join('')}</ul></details>` : ''}
      </section>
      ${course.access.canManage ? `<section class="card danger-zone"><h3>Delete course</h3><p class="muted">Deletes the question bank and everyone's progress on it${data.learners ? ` (${data.learners} other ${data.learners === 1 ? 'person has' : 'people have'} practised it)` : ''}.</p><button class="btn danger" data-act="delete">Delete course</button></section>` : ''}
    </div>`;

  $('[data-act="fork"]', app)?.addEventListener('click', () => forkDialog(data));
  $('form.course-form', app)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', `/api/courses/${enc(id)}`, Object.fromEntries(new FormData(e.target)));
      invalidate(id);
      coursesCache = null;
      toast('Course saved', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  });
  $('[data-act="delete"]', app)?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Delete “${course.name}”?`, `The question bank and all progress will be removed${data.learners ? `, including that of ${data.learners} other ${data.learners === 1 ? 'person' : 'people'}` : ''}.`, 'Delete', true))) return;
    await api('DELETE', `/api/courses/${enc(id)}`);
    sessions.clear(id);
    invalidate(id);
    coursesCache = null;
    toast('Course deleted');
    navigate('#/');
  });
  if (course.access.canEdit) importPanel($('#import', app), id, () => { if (seq === routeSeq) settingsPage(id); }); // only redraw if still on this page

  const form = $('form.settings', app);
  const read = () => {
    const fd = new FormData(form);
    const out = {
      chapters: fd.getAll('chapters'),
      practice: { types: fd.getAll('practice-types'), count: fd.get('practice-count') === 'custom' ? Number(fd.get('practice-custom')) || 0 : Number(fd.get('practice-count')) || 0 },
      mistakes: { types: fd.getAll('mistakes-types'), frequentOnly: fd.get('mistakes-frequent') === 'on' },
      exam: { perType: {}, points: {}, timeMin: Number(fd.get('exam-time')) || 0, tag: fd.get('exam-tag') || '' },
    };
    for (const t of allTypes) {
      out.exam.perType[t] = Number(fd.get(`exam-n-${t}`)) || 0;
      out.exam.points[t] = Number(fd.get(`exam-p-${t}`)) || 0;
    }
    return out;
  };
  const refresh = () => {
    const cur = read();
    $('.custom-count', form).hidden = new FormData(form).get('practice-count') !== 'custom';
    const counts = typeCountsFor(cur.chapters);
    $$('[data-count]', form).forEach((b) => { b.textContent = counts[b.dataset.count] || 0; });
    const avail = examCounts(cur);
    $$('[data-avail]', form).forEach((b) => { b.textContent = avail[b.dataset.avail] || 0; });
    for (const m of ['practice', 'mistakes']) {
      const n = pickQuestions(course, progress, { ...moduleConfig(m, cur), mastery: data.masteryStreak }).length;
      $(`[data-match="${m}"]`, form).textContent = `— ${n} question${n === 1 ? '' : 's'}`;
    }
    const sum = examSummary(cur, avail);
    $('.exam-total', form).innerHTML = sum.questions
      ? `<b>${sum.questions}</b> questions · <b>${sum.maxScore}</b> points · ${cur.exam.timeMin ? `<b>${cur.exam.timeMin}</b> min` : 'no time limit'}`
      : '<span class="muted">Exam not set up.</span>';
  };
  $$('[data-chapters]', form).forEach((b) => b.addEventListener('click', () => {
    $$('input[name="chapters"]', form).forEach((c) => { c.checked = b.dataset.chapters === 'all'; });
    refresh();
  }));
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  refresh();
  const anchor = /#(exam|course|import)$/.exec(location.hash);
  if (anchor) ($(`#${anchor[1]}`, app) || $('#course', app)).scrollIntoView({ block: 'start' });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', `/api/courses/${enc(id)}/settings`, read());
      invalidate(id);
      toast('Settings saved', 'ok');
      navigate(`#/c/${enc(id)}`);
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- statistics ----------
async function statsPage(id) {
  const [data, activity] = await Promise.all([
    loadCourse(id, { force: true }),
    api('GET', `/api/courses/${enc(id)}/activity?days=30&tz=${-new Date().getTimezoneOffset()}`),
  ]);
  const { course, progress, stats } = data;
  const prog = progress.questions;
  const byType = {};
  for (const q of course.questions) {
    const t = (byType[q.type] ||= { total: 0, answered: 0, correct: 0, attempts: 0, wrongBook: 0 });
    t.total++;
    const p = prog[q.id];
    if (p?.attempts) { t.answered++; t.correct += p.correct; t.attempts += p.attempts; }
    if (inMistakes(p, data.masteryStreak)) t.wrongBook++;
  }
  const worst = course.questions.filter((q) => prog[q.id]?.wrong)
    .sort((a, b) => prog[b.id].wrong - prog[a.id].wrong || accuracy(prog[a.id]) - accuracy(prog[b.id])).slice(0, 10);
  const chapters = chapterStats(course, prog);
  const exams = progress.exams.slice().reverse();
  const accRow = (name, v) => `<tr><td>${esc(name)}</td><td>${v.answered}/${v.total}</td><td>${v.attempts ? pct(v.correct, v.attempts) + '%' : '—'}</td><td><div class="bar ${v.attempts && v.correct / v.attempts < 0.6 ? 'low' : ''}"><span style="width:${v.attempts ? pct(v.correct, v.attempts) : 0}%"></span></div></td></tr>`;
  app.innerHTML = `${topbar(`<a href="#/">Courses</a> › <a href="#/c/${enc(id)}">${esc(course.name)}</a> › Statistics`)}
    <div class="page narrow">
      <h1>📊 Statistics</h1>
      <section class="card overview">
        <div class="overview-top">
          ${ring(pct(stats.answered, stats.total), 'practiced', 92)}
          <dl class="figs">
            <div class="fig"><dt>Questions</dt><dd>${stats.total}</dd></div>
            <div class="fig"><dt>Answers given</dt><dd>${stats.attempts}</dd></div>
            <div class="fig"><dt>Accuracy</dt><dd>${stats.attempts ? pct(stats.correct, stats.attempts) + '%' : '—'}</dd></div>
            <div class="fig"><dt>To review</dt><dd class="${stats.wrongBook ? 'warn-text' : ''}">${stats.wrongBook}</dd></div>
            <div class="fig"><dt>Best mock exam</dt><dd>${progress.exams.length ? Math.max(...progress.exams.map((e) => pct(e.score, e.maxScore))) + '%' : '—'}</dd></div>
          </dl>
        </div>
        ${typeMix(stats.byType, stats.total)}
      </section>
      ${activityCard(activity)}
      <section class="card"><h3>By question type</h3>
        <table class="type-table"><thead><tr><th>Type</th><th>Practiced</th><th>Accuracy</th><th></th></tr></thead>
        <tbody>${TYPES.filter((t) => byType[t]).map((t) => accRow(TYPE_LABELS[t], byType[t])).join('')}</tbody></table>
      </section>
      ${chapters.length > 1 ? `<section class="card"><h3>By chapter</h3>
        <table class="type-table"><thead><tr><th>Chapter</th><th>Practiced</th><th>Accuracy</th><th></th></tr></thead>
        <tbody>${chapters.map((c) => accRow(c.name || 'No chapter', c)).join('')}</tbody></table></section>` : ''}
      <section class="card"><h3>Mock exam history</h3>
        ${exams.length ? `${examSpark(progress.exams)}<table class="type-table"><thead><tr><th>When</th><th>Score</th><th>Correct</th><th>Time</th></tr></thead><tbody>
        ${exams.map((e) => `<tr><td>${esc(new Date(e.at).toLocaleString())}</td><td><b>${e.score}</b>/${e.maxScore} <span class="muted">(${pct(e.score, e.maxScore)}%)</span></td><td>${e.correct}/${e.total}</td><td>${fmtDuration(e.durationSec)}</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted">No mock exams yet.</p>'}
      </section>
      <section class="card"><h3>Most missed</h3>
        ${worst.length ? `<ol class="worst">${worst.map((q) => `<li><span class="badge type">${esc(TYPE_LABELS[q.type])}</span> ${mdInline(q.stem.split('\n')[0].slice(0, 120))} <span class="warn-text">✗${prog[q.id].wrong}</span> <span class="muted">✓${prog[q.id].correct}</span></li>`).join('')}</ol>
        <button class="btn primary" data-act="drill">Practice these ${worst.length}</button>` : '<p class="muted">Nothing missed yet.</p>'}
      </section>
      <section class="card danger-zone"><h3>Reset</h3><p class="muted">Clears your attempts, stars, notes and exam history for this course. Questions are kept.</p><button class="btn danger" data-act="reset">Reset progress</button></section>
    </div>`;
  $('[data-act="drill"]', app)?.addEventListener('click', () => {
    sessions.save(newSession(id, 'practice', worst.map((q) => q.id), { title: 'Most missed', slot: 'drill' }));
    navigate(`#/c/${enc(id)}/run/drill`);
  });
  $('[data-act="reset"]', app).addEventListener('click', async () => {
    if (!(await confirmDialog('Reset all progress?', 'This cannot be undone.', 'Reset', true))) return;
    await api('POST', `/api/courses/${enc(id)}/reset-progress`);
    sessions.clear(id);
    invalidate(id);
    toast('Progress reset');
    statsPage(id);
  });
}

/** Answers per day, last 30 days: one series, so no legend; each bar has its own tooltip. */
function activityCard(days) {
  const total = days.reduce((a, d) => a + d.answers, 0);
  const correct = days.reduce((a, d) => a + d.correct, 0);
  const active = days.filter((d) => d.answers).length;
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].answers) streak++;
    else if (i === days.length - 1) continue; // today not done yet doesn't break the streak
    else break;
  }
  const max = Math.max(1, ...days.map((d) => d.answers));
  const fmt = (day) => new Date(day + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const bars = days.map((d) => {
    const tip = `${fmt(d.day)} · ${d.answers} answer${d.answers === 1 ? '' : 's'}${d.answers ? ` · ${pct(d.correct, d.answers)}% right` : ''}`;
    return `<span class="act-col" title="${tip}" aria-label="${tip}"><span class="act-bar ${d.answers ? '' : 'zero'}" style="height:${d.answers ? Math.max(6, (d.answers / max) * 100) : 0}%"></span></span>`;
  }).join('');
  return `<section class="card activity">
    <h3>Last 30 days</h3>
    <p class="act-summary"><b>${total}</b> answers${total ? ` · <b>${pct(correct, total)}%</b> right` : ''} · <b>${active}</b> active day${active === 1 ? '' : 's'}${streak > 1 ? ` · <b>${streak}</b>-day streak` : ''}</p>
    ${total ? '' : '<p class="muted small">Every answer you give is logged; your daily activity shows up here.</p>'}
    <div class="act-chart ${total ? '' : 'empty'}" role="img" aria-label="Answers per day over the last 30 days, ${total} in total">
      ${total ? `<span class="act-max" aria-hidden="true">${max}</span>` : ''}${bars}
    </div>
    <div class="act-axis" aria-hidden="true"><span>${fmt(days[0].day)}</span><span>${fmt(days[Math.floor(days.length / 2)].day)}</span><span>Today</span></div>
  </section>`;
}

function examSpark(exams) {
  if (exams.length < 2) return '';
  const w = 600, h = 120, pad = 16;
  const pts = exams.slice(-20).map((e, i, a) => {
    const x = pad + (i * (w - 2 * pad)) / (a.length - 1);
    const y = h - pad - ((e.maxScore ? e.score / e.maxScore : 0) * (h - 2 * pad));
    return [x, y, e];
  });
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Exam score trend">
    <line x1="${pad}" x2="${w - pad}" y1="${h - pad - 0.6 * (h - 2 * pad)}" y2="${h - pad - 0.6 * (h - 2 * pad)}" class="spark-pass"/>
    <polyline points="${pts.map(([x, y]) => `${x},${y}`).join(' ')}" class="spark-line"/>
    ${pts.map(([x, y, e]) => `<circle cx="${x}" cy="${y}" r="4" class="spark-dot"><title>${pct(e.score, e.maxScore)}% · ${new Date(e.at).toLocaleDateString()}</title></circle>`).join('')}
  </svg>`;
}

// ---------- import ----------
const FORMAT_HELP = `
<details class="format-help"><summary>Accepted formats</summary>
<div class="prose">
<p><b>Markdown</b> (Obsidian notes, pasted papers). Questions start with a numbered line (<code>1.</code>, <code>2、</code>) or a <code>##</code> heading. <code># Heading</code> sets the chapter; a heading like <code>一、单项选择题</code> / <code>Multiple choice</code> sets the type for the questions under it.</p>
<pre>1. Which matrix is invertible? [single]
A. ...   B. ...   C. ...   D. ...
Answer: B
Explanation: det ≠ 0

2. Pick all prime numbers.
- [x] 2
- [ ] 4
- [x] 5

3. The identity matrix is symmetric.
答案：√

4. The trace of I₂ is ____ and its determinant is ____.
Answer: 2; 1

5. Paris is the capital of {{France}}.

6. Find ∫₀¹ x² dx.
Answer: 1/3 ± 0.01

7. Describe Gaussian elimination.
Answer: Form the augmented matrix, reduce to row echelon form, back-substitute.
Keywords: augmented, echelon, back-substitute</pre>
<p>Fields: <code>Answer/答案</code>, <code>Explanation/解析</code>, <code>Type/题型</code>, <code>Tags/标签</code>, <code>Difficulty/难度</code> (1–5), <code>Source/来源</code>, <code>Unit/单位</code>, <code>Tolerance/误差</code>, <code>Keywords/得分点</code>. Math with <code>$…$</code>, images with <code>![](url)</code> or <code>![[file.png]]</code>.</p>
<p><b>JSON</b>: an array of questions or <code>{"questions": [...]}</code>, each with <code>type, stem, options, answer, explanation, chapter, tags</code>.</p>
</div></details>`;

function importPanel(el, courseId, onDone) {
  el.innerHTML = `
    <h3>Import questions</h3>
    <div class="import-source segmented"><label><input type="radio" name="src" value="paste" checked><span>Paste text</span></label><label><input type="radio" name="src" value="file"><span>Upload files</span></label></div>
    <div class="src-paste"><textarea class="import-text" rows="10" placeholder="Paste questions (Markdown or JSON)…"></textarea></div>
    <div class="src-file" hidden><label class="dropzone"><input type="file" multiple accept=".md,.markdown,.txt,.json"><span>Drop .md / .txt / .json files here or tap to choose</span></label><ul class="file-list"></ul></div>
    <div class="import-opts">
      <label class="field inline"><span>Default chapter</span><input name="chapter" placeholder="optional"></label>
      <label class="field inline"><span>Tags</span><input name="tags" placeholder="e.g. 2024, final"></label>
      <label class="field inline"><span>Source</span><input name="source" placeholder="e.g. 2023 final paper"></label>
      <label class="field inline"><span>Mode</span><select name="mode"><option value="merge">Merge (add / update)</option><option value="replace">Replace whole bank</option></select></label>
    </div>
    <div class="actions-row"><button class="btn ghost" data-act="preview">Preview</button><button class="btn primary" data-act="import">Import</button></div>
    <div class="import-result"></div>
    ${FORMAT_HELP}`;
  let files = [];
  const srcRadios = $$('input[name="src"]', el);
  srcRadios.forEach((r) => r.addEventListener('change', () => {
    const v = $('input[name="src"]:checked', el).value;
    $('.src-paste', el).hidden = v !== 'paste';
    $('.src-file', el).hidden = v !== 'file';
  }));
  const fileInput = $('input[type="file"]', el);
  const setFiles = async (list) => {
    files = await Promise.all([...list].map(async (f) => ({ name: f.name, content: await f.text() })));
    $('.file-list', el).innerHTML = files.map((f) => `<li>${esc(f.name)} <span class="muted">${(f.content.length / 1024).toFixed(1)} KB</span></li>`).join('');
  };
  fileInput.addEventListener('change', () => setFiles(fileInput.files));
  const dz = $('.dropzone', el);
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); setFiles(e.dataTransfer.files); });

  const payloads = () => {
    const opts = { chapter: $('[name="chapter"]', el).value.trim(), tags: $('[name="tags"]', el).value.trim(), source: $('[name="source"]', el).value.trim(), mode: $('[name="mode"]', el).value };
    const v = $('input[name="src"]:checked', el).value;
    if (v === 'paste') return [{ ...opts, content: $('.import-text', el).value, filename: '', sourceKind: 'paste' }];
    return files.map((f) => ({ ...opts, content: f.content, filename: f.name, sourceKind: 'upload' }));
  };
  const out = $('.import-result', el);

  $('[data-act="preview"]', el).addEventListener('click', async () => {
    const ps = payloads().filter((p) => p.content.trim());
    if (!ps.length) { toast('Nothing to preview', 'warn'); return; }
    try {
      const results = await Promise.all(ps.map((p) => api('POST', '/api/import/preview', p)));
      out.innerHTML = results.map((r, i) => previewHtml(r, ps[i].filename)).join('');
    } catch (e) { out.innerHTML = `<p class="error-text">${esc(e.message)}</p>`; }
  });
  $('[data-act="import"]', el).addEventListener('click', async () => {
    let target = courseId;
    if (!target) {
      const sel = $('#import-course')?.value;
      const newName = $('#import-new-course')?.value.trim();
      if (sel === '__new') {
        if (!newName) { toast('Enter a course name', 'warn'); return; }
        try { target = (await api('POST', '/api/courses', { name: newName })).id; } catch (e) { toast(e.message, 'error'); return; }
      } else target = sel;
    }
    const ps = payloads().filter((p) => p.content.trim());
    if (!ps.length) { toast('Nothing to import', 'warn'); return; }
    if (ps[0].mode === 'replace' && !(await confirmDialog('Replace the whole bank?', 'Questions not in this import will be removed.', 'Replace', true))) return;
    try {
      const lines = [];
      for (const p of ps) {
        const r = await api('POST', `/api/courses/${enc(target)}/import`, p);
        lines.push(`<li>${esc(p.filename || 'Pasted text')}: <b>+${r.added}</b> new, ${r.updated} updated, ${r.unchanged} unchanged${r.removed ? `, ${r.removed} removed` : ''}${r.errors.length ? `, <span class="error-text">${r.errors.length} skipped</span>` : ''}</li>`
          + r.errors.map((e) => `<li class="error-text small">#${e.index + 1}: ${esc(e.error)} — “${esc(e.stem)}”</li>`).join('')
          + (r.warnings || []).map((w) => `<li class="warn-text small">${esc(w)}</li>`).join(''));
      }
      out.innerHTML = `<ul class="import-report">${lines.join('')}</ul><a class="btn primary" href="#/c/${enc(target)}">Go to course</a>`;
      invalidate(target);
      toast('Imported', 'ok');
      if (onDone && courseId) setTimeout(onDone, 1500);
    } catch (e) { out.innerHTML = `<p class="error-text">${esc(e.message)}</p>`; }
  });
}

function previewHtml(r, filename) {
  const byType = {};
  for (const q of r.questions) byType[q.type] = (byType[q.type] || 0) + 1;
  return `<div class="preview">
    <p><b>${esc(filename || 'Preview')}</b>: ${r.questions.length} questions (${esc(r.format)}) — ${Object.entries(byType).map(([t, n]) => `${esc(TYPE_LABELS[t])} ${n}`).join(', ')}</p>
    ${r.errors.length ? `<ul class="error-text small">${r.errors.map((e) => `<li>#${e.index + 1}: ${esc(e.error)} — “${esc(e.stem)}”</li>`).join('')}</ul>` : ''}
    ${r.warnings.length ? `<ul class="warn-text small">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <ol class="preview-list">${r.questions.slice(0, 50).map((q) => `<li><span class="badge type">${esc(TYPE_LABELS[q.type])}</span> ${mdInline(q.stem.split('\n')[0].slice(0, 160))} <span class="muted">→ ${mdInline(String(answerText(q)).split('\n')[0].slice(0, 80))}</span></li>`).join('')}</ol>
    ${r.questions.length > 50 ? `<p class="muted">…and ${r.questions.length - 50} more</p>` : ''}
  </div>`;
}

async function importPage(params) {
  const courses = (await api('GET', '/api/courses')).filter((c) => c.mine); // only your own courses take imports
  const pre = params?.get?.('course');
  app.innerHTML = `${topbar(`<a href="#/">Courses</a> › Import`)}
    <div class="page narrow">
      <h1>Import questions</h1>
      <section class="card">
        <label class="field"><span>Into course</span>
          <select id="import-course">${courses.map((c) => `<option value="${esc(c.id)}" ${pre === c.id ? 'selected' : ''}>${esc(c.name)} (${c.stats.total})</option>`).join('')}<option value="__new" ${courses.length ? '' : 'selected'}>+ New course…</option></select>
        </label>
        <label class="field new-course" ${courses.length ? 'hidden' : ''}><span>New course name</span><input id="import-new-course" placeholder="e.g. Signals and Systems"></label>
      </section>
      <section class="card" id="import-panel"></section>
      <section class="card tips-card"><h3>Let Claude collect questions for you</h3>
        <p class="muted">In the terminal (Claude Code, in this project):</p>
        <ul class="tips">
          <li>“Search the web for past papers of <i>course name</i> and load them into the exam assistant.”</li>
          <li>“Import the questions in my vault folder <i>Courses/…</i>.”</li>
          <li>“Here are some questions, add them to <i>course</i>: …”</li>
        </ul>
      </section>
    </div>`;
  const sel = $('#import-course', app);
  sel.addEventListener('change', () => { $('.new-course', app).hidden = sel.value !== '__new'; });
  importPanel($('#import-panel', app), null);
}

// ---------- printable paper ----------
async function printPage(id) {
  const data = await loadCourse(id);
  const { course } = data;
  const groups = TYPES.map((t) => [t, course.questions.filter((q) => q.type === t)]).filter(([, qs]) => qs.length);
  let n = 0;
  const numbered = [];
  const body = groups.map(([t, qs]) => `<section class="paper-section"><h2>${esc(TYPE_LABELS[t])}</h2>${qs.map((q) => {
    n++;
    numbered.push([n, q]);
    return `<div class="paper-q"><div class="prose"><b>${n}.</b> ${md(q.stem)}</div>
      ${q.options ? `<ol class="opt-list" type="A">${q.options.map((o) => `<li>${mdInline(o)}</li>`).join('')}</ol>` : ''}
      ${q.type === 'judge' ? '<p>(&nbsp;&nbsp;&nbsp;&nbsp;)</p>' : ''}
      ${q.type === 'calc' || isOpen(q.type) ? '<div class="answer-space"></div>' : ''}</div>`;
  }).join('')}</section>`).join('');
  app.innerHTML = `<div class="paper">
    <div class="no-print actions-row"><a class="btn ghost" href="#/c/${enc(id)}/settings">‹ Back</a><button class="btn primary" onclick="window.print()">🖨 Print</button></div>
    <h1>${esc(course.name)}</h1>
    ${body}
    <section class="paper-key"><h2>Answer key</h2><ol>${numbered.map(([i, q]) => `<li value="${i}">${isOpen(q.type) ? md(q.answer) : mdInline(answerText(q))}</li>`).join('')}</ol></section>
  </div>`;
}

startNav(route);
