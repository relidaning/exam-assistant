// Router + pages. Flow: course cards → course hub (module panels) → run → result; Settings decide what modules ask.
import { $, $$, esc, api, auth, toast, dialog, confirmDialog, pct, relTime, daysUntil, fmtDuration, settings, applySettings, topbar, tabbar, themeIcon, refreshInbox } from './ui.js';
import { md, mdInline } from './render.js';
import { TYPES, TYPE_LABELS, answerText, isOpen } from './grade.js';
import { loadCourse, peekCourse, invalidate, sessions, flushAllSessions, flushSessions, examDetail } from './data.js';
import { MODULES, pickQuestions, inMistakes, accuracy, moduleConfig, examConfigured, examSummary, pointsFor, PAST_PAPER_TAG } from './session.js';
import { renderRun, renderResult, newSession, teardownRun } from './run.js';
import { navigate, startNav } from './nav.js';
import { questionCard } from './answer.js';
import { openReparse } from './reparse.js';
import { KIND_LABELS, STATUS_LABELS } from './report.js';

const app = $('#app');
const enc = encodeURIComponent;

// The page is not zoomable. iOS Safari ignores user-scalable=no in the viewport meta, so its pinch gestures are blocked here.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-act="account"]')) { navigate('#/settings'); return; }
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
// tabs: My courses (/), In progress, Public, Settings; a course's own settings live under the Settings tab
const toCourseSettings = (id) => navigate(`#/settings/c/${enc(id)}${/#(exam|course|import)$/.exec(location.hash)?.[0] || ''}`);
const routes = [
  [/^\/login$/, loginPage],
  [/^\/account$/, (params) => navigate(`#/settings${String(params) ? `?${params}` : ''}`)], // old links (and the OAuth "linked" return)
  [/^\/?$/, myCoursesPage],
  [/^\/progress$/, progressPage],
  [/^\/public$/, publicPage],
  [/^\/courses$/, () => navigate('#/')], // old links
  [/^\/settings$/, settingsTab],
  [/^\/import$/, importPage],
  [/^\/messages$/, messagesPage],
  [/^\/messages\/(\d+)$/, messagePage],
  [/^\/messages\/u\/([^/]+)$/, dmPage],
  [/^\/c\/([^/]+)$/, coursePage],
  [/^\/p\/([^/]+)$/, publicCoursePage],
  [/^\/settings\/c\/([^/#]+)(?:#\w+)?$/, settingsPage],
  [/^\/settings\/c\/([^/#]+)\/history$/, historyPage],
  [/^\/c\/([^/]+)\/settings(?:#\w+)?$/, toCourseSettings], // old links
  [/^\/c\/([^/]+)\/setup\/\w+$/, toCourseSettings],
  [/^\/c\/([^/]+)\/run\/(\w+)$/, (id, slot) => renderRun(app, id, slot)],
  [/^\/c\/([^/]+)\/review\/(\w+)\/(\d+)$/, (id, slot, n) => renderRun(app, id, slot, { reviewIdx: Number(n) })],
  [/^\/c\/([^/]+)\/review-missed\/(\w+)\/(\d+)$/, (id, slot, n) => renderRun(app, id, slot, { reviewIdx: Number(n), missedOnly: true })],
  [/^\/c\/([^/]+)\/result\/(\w+)$/, (id, slot) => renderResult(app, id, slot)],
  [/^\/c\/([^/]+)\/(?:run|result)$/, (id) => navigate(`#/c/${enc(id)}`)], // links from before per-module sessions
  [/^\/c\/([^/]+)\/stats$/, statsPage],
  [/^\/c\/([^/]+)\/manage$/, (id) => navigate(`#/settings/c/${enc(id)}#import`)], // old links
  [/^\/c\/([^/]+)\/print$/, printPage],
];

// Bumped on every page change; a page that awaited the server only redraws if it is still the current page.
let routeSeq = 0;

async function route() {
  routeSeq++;
  teardownRun();
  document.body.classList.remove('in-chat');
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
    document.body.dataset.route = pathPart.startsWith('/c/') ? pathPart.split('/')[3] || 'course' : pathPart.split('/')[1] || 'home';
    const seq = routeSeq;
    try {
      await fn(...m.slice(1).map(decodeURIComponent), new URLSearchParams(query));
      if (seq === routeSeq && pathPart !== '/login') refreshInbox(); // the bell's count, after the page (opening a message reads it)
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
    const reg = mode === 'register';
    // no top bar: a brand header (a side panel on wide screens) and the form
    app.innerHTML = `<div class="login">
        <header class="login-brand">
          <div class="login-brand-top">
            <span class="login-logo" aria-hidden="true">✎</span><span class="login-name">Exam Assistant</span>
            <button class="icon-btn login-theme" data-setting="theme" title="Theme: ${settings.theme}" aria-label="Toggle theme">${themeIcon()}</button>
          </div>
          <p class="login-tagline">Practise past papers, review your mistakes, sit mock exams.</p>
          <ul class="login-points">
            <li>Your progress stays private to your account</li>
            <li>Practise public courses, or fork one to make it yours</li>
            <li>Same round on your phone and your computer</li>
          </ul>
        </header>
        <form class="login-card" autocomplete="on">
          ${auth.firstUser ? '<h1>Create the first account</h1>' : `<div class="login-tabs" role="tablist">
            <button type="button" role="tab" aria-selected="${!reg}" ${reg ? 'data-act="switch"' : ''}>Sign in</button>
            <button type="button" role="tab" aria-selected="${reg}" ${reg ? '' : 'data-act="switch"'}>Create account</button>
          </div>`}
          ${auth.firstUser ? '<p class="login-note">You\'re the first one here. This account becomes the admin and takes over the existing courses and progress.</p>' : ''}
          <label class="login-field"><span>Username</span>
            <input name="username" required minlength="2" maxlength="32" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="next"></label>
          <label class="login-field"><span>Password${reg ? ' <small>at least 6 characters</small>' : ''}</span>
            <span class="pw-wrap"><input name="password" type="password" required minlength="${reg ? 6 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}" enterkeyhint="go">
            <button type="button" class="pw-toggle" data-act="show-pw" aria-label="Show password" aria-pressed="false"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></button></span></label>
          <p class="error-text small login-error" role="alert">${esc(error)}</p>
          <button class="btn primary big" type="submit">${reg ? 'Create account' : 'Sign in'}</button>
          ${providers.length ? `<div class="or-line" role="separator"><span>or continue with</span></div>
          <div class="oauth-buttons">${providers.map((p) => `<a class="btn oauth-btn" href="${providerHref(p.id, { next })}" aria-label="Continue with ${esc(p.label)}">${PROVIDER_ICONS[p.id] || ''}<span>${esc(p.label)}</span></a>`).join('')}</div>` : ''}
        </form>
      </div>`;
    $('[data-act="show-pw"]', app).addEventListener('click', (e) => {
      const b = e.currentTarget, input = b.previousElementSibling, show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.setAttribute('aria-pressed', show);
      b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    $('[data-act="switch"]', app)?.addEventListener('click', () => {
      const typed = $('input[name="username"]', app).value;
      mode = mode === 'login' ? 'register' : 'login';
      draw();
      $('input[name="username"]', app).value = typed; // keep what was typed
    });
    $('form', app).addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try {
        const r = await api('POST', `/api/auth/${mode}`, body);
        auth.user = r.user;
        auth.firstUser = false;
        invalidate();
        coursesCache = null;
        navigate(`#${next === '/login' ? '/' : next}`); // My courses, unless you were on your way somewhere
      } catch (err) { $('.login-error', app).textContent = err.message; }
    });
  };
  draw();
}

/** Settings tab: each course's practice / mock exam settings, your account (sign-in methods), appearance, sign out. */
async function settingsTab(params) {
  const seq = routeSeq;
  const [me, courses] = await Promise.all([api('GET', '/api/auth/me'), api('GET', '/api/courses')]);
  if (seq !== routeSeq) return;
  Object.assign(auth, me);
  coursesCache = courses;
  const mine = courses.filter((c) => c.mine);
  const u = auth.user;
  const linked = Object.fromEntries((auth.identities || []).map((x) => [x.provider, x]));
  const label = { google: 'Google', github: 'GitHub' };
  const shown = [...new Set([...(auth.providers || []).map((p) => p.id), ...Object.keys(linked)])];
  const signIns = (u.hasPassword ? 1 : 0) + Object.keys(linked).length;
  app.innerHTML = `${topbar()}
    <div class="page narrow">
      <h1>Settings</h1>
      <section class="card" id="courses">
        <h3>Practice &amp; mock exams</h3>
        <p class="muted small">Per course: chapters, question types and counts, the mock exam's questions and duration. Also the course's details and imports.</p>
        ${mine.length ? `<ul class="row-list">${mine.map((c) => `<li><a class="row-link" href="#/settings/c/${enc(c.id)}">${monogram(c.name, '', c.id)}
            <span class="grow"><b>${esc(c.name)}</b><small class="muted">${c.stats.total} questions${c.examDate && daysUntil(c.examDate) >= 0 ? ` · exam ${esc(c.examDate)}` : ''}</small></span>${icon('chevron', 'row-chev')}</a></li>`).join('')}</ul>`
          : '<p class="muted">No courses of your own yet. Fork a public course, or create one under <a href="#/">My courses</a>.</p>'}
      </section>
      <section class="card" id="account">
        <h3>Account</h3>
        <div class="account-head"><span class="avatar-big" aria-hidden="true">${esc([...u.username][0].toUpperCase())}</span>
          <span class="grow"><b>${esc(u.username)}</b><small class="muted">${u.isAdmin ? 'Admin: you can also unpublish or delete any public course. ' : ''}Your answers, stars, notes and exam results are visible only to you.</small></span></div>
        <h4>Sign-in methods</h4>
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
      <section class="card">
        <h3>Appearance</h3>
        <div class="segmented theme-pick" role="radiogroup" aria-label="Theme">${[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<label><input type="radio" name="theme" value="${v}" ${settings.theme === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
        <p class="hint">Auto follows your device.</p>
      </section>
      <section class="card"><h3>Sign out</h3><p class="muted">On this device. Your progress stays on the server.</p><button class="btn" data-act="logout">Sign out</button></section>
    </div>`;
  const note = params?.get?.('error') || (params?.get?.('linked') && `${label[params.get('linked')] || 'Account'} linked`);
  if (note) { toast(note, params.get('error') ? 'error' : 'ok', 4000); history.replaceState(history.state, '', '#/settings'); }
  $$('input[name="theme"]', app).forEach((r) => r.addEventListener('change', () => {
    settings.theme = r.value;
    applySettings();
    $$('[data-setting="theme"]').forEach((b) => { b.innerHTML = themeIcon(); b.title = `Theme: ${settings.theme}`; });
  }));
  $('[data-act="logout"]', app).addEventListener('click', async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    location.hash = '#/login';
    location.reload(); // drop every cached course and round of this user
  });
  $$('[data-unlink]', app).forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.unlink;
    if (!(await confirmDialog(`Unlink ${label[id]}?`, `You won't be able to sign in with ${label[id]} any more.`, 'Unlink', true))) return;
    try { await api('DELETE', `/api/auth/identities/${id}`); toast(`${label[id]} unlinked`); settingsTab(); } catch (e) { toast(e.message, 'error'); }
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
    try { await api('POST', '/api/auth/password', form); toast('Password saved', 'ok'); settingsTab(); } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------- course tiles ----------
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

// Course lists and the course page draw from memory first and refresh in the background, so going Back paints the right
// page in the same frame (no flash of the page being left), and redraw only if the server copy differs.
let coursesCache = null;

async function withCourses(draw) {
  const seq = routeSeq;
  if (coursesCache) draw(coursesCache);
  const courses = await api('GET', '/api/courses');
  if (seq !== routeSeq) return;
  if (!coursesCache || JSON.stringify(courses) !== JSON.stringify(coursesCache)) draw(courses);
  coursesCache = courses;
}

const GLOBE = '<svg class="ico-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
const FORK = '<svg class="ico-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5"/></svg>';
const LOCK = '<svg class="ico-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

/** Who a course belongs to and whether others see it, in one short line. */
function courseOwnerLine(c) {
  if (c.mine ?? c.access?.isOwner) return c.visibility === 'public' ? `${GLOBE}Public` : `${LOCK}Private`;
  return c.owner ? `by ${esc(c.owner.username)}` : '';
}

// kept deliberately light: numbers live on the Statistics page, not in the lists
/** A course description: its first line is the summary (cards, page header), the rest the public page's About text. */
const summaryOf = (d) => String(d || '').trim().split('\n')[0].trim();
const aboutOf = (d) => String(d || '').trim().split('\n').slice(1).join('\n').trim();

const courseTile = (c, meta = courseOwnerLine(c), badge = countdownPill(c.examDate), href = `#/c/${enc(c.id)}`) => `<a class="course-tile" href="${href}" style="${courseColor(c.id)}">
    <span class="ct-mono" aria-hidden="true">${esc([...String(c.name).trim()][0] || '·')}</span>
    <span class="ct-name">${esc(c.name)}</span>
    ${summaryOf(c.description) ? `<span class="ct-desc">${esc(summaryOf(c.description))}</span>` : ''}
    <span class="ct-meta">${meta}</span>
    ${badge}
  </a>`;

// ---------- Public tab: everyone's published courses, with a search ----------
let publicQuery = '';

function publicPage() {
  return withCourses(drawPublic);
}

function drawPublic(courses) {
  const pub = courses.filter((c) => c.visibility === 'public');
  const forked = new Set(courses.filter((c) => c.mine && c.forkedFrom).map((c) => c.forkedFrom.id));
  const hadFocus = document.activeElement?.classList.contains('course-search');
  const meta = (c) => `${c.mine ? 'Yours' : c.owner ? `by ${esc(c.owner.username)}` : ''} · ${c.stats.total} q${c.forks ? ` · ${c.forks} fork${c.forks === 1 ? '' : 's'}` : ''}`;
  app.innerHTML = `${topbar()}
    <div class="page">
      <div class="search-bar"><input type="search" class="course-search" placeholder="Search public courses" aria-label="Search public courses" enterkeyhint="search" value="${esc(publicQuery)}">
        <button type="button" class="search-clear" data-act="clear-search" aria-label="Clear search" title="Clear" hidden><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg></button></div>
      <div class="page-head"><h1>Public courses</h1></div>
      <p class="muted small lead">Shared by everyone. Open one to see what's inside; fork it to practise with your own copy. Your own courses are practised under My courses.</p>
      ${pub.length ? `<div class="course-tiles public-tiles">${pub.map((c) => courseTile(c, meta(c), forked.has(c.id) ? '<span class="pill">Forked</span>' : countdownPill(c.examDate), `#/p/${enc(c.id)}`)).join('')}</div>
        <p class="muted no-match" hidden>No public course matches “<span></span>”.</p>`
        : '<div class="card empty"><h2>No public courses yet</h2><p>When someone publishes a course, it shows up here. Publish one of yours from its page under My courses.</p></div>'}
    </div>`;
  const search = $('.course-search', app);
  const filter = () => {
    publicQuery = search.value;
    const q = publicQuery.trim().toLowerCase();
    let shownCount = 0;
    $$('.public-tiles .course-tile', app).forEach((t, i) => {
      t.hidden = !!q && !`${pub[i].name} ${pub[i].description || ''} ${pub[i].owner?.username || ''}`.toLowerCase().includes(q);
      if (!t.hidden) shownCount++;
    });
    $('[data-act="clear-search"]', app).hidden = !publicQuery;
    const none = $('.no-match', app);
    if (none) { none.hidden = shownCount > 0; $('span', none).textContent = publicQuery.trim(); }
  };
  search.addEventListener('input', filter);
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; filter(); } });
  $('[data-act="clear-search"]', app).addEventListener('click', () => { search.value = ''; filter(); search.focus(); });
  filter();
  if (hadFocus) search.focus(); // a background refresh doesn't take the keyboard away
}

// ---------- In progress tab: every unfinished round, across courses ----------
async function progressPage() {
  const seq = routeSeq;
  await flushAllSessions(); // rounds answered on this device reach the server before it is asked for the list
  const rows = (await api('GET', '/api/sessions')).filter((r) => r.session.phase !== 'done');
  if (seq !== routeSeq) return;
  const answered = (s) => Object.values(s.entries || {}).filter((e) => e.submitted || e.response != null).length;
  const status = (s) => {
    const n = answered(s), total = s.qids.length;
    if (s.phase === 'grading') return 'Handed in · short answers to grade';
    return `${n} of ${total} answered${s.timeLimitSec ? ` · ${Math.round(s.timeLimitSec / 60)} min exam` : ''}`;
  };
  app.innerHTML = `${topbar()}
    <div class="page narrow">
      <div class="page-head"><h1>In progress</h1></div>
      <p class="muted small lead">Unfinished practice rounds and mock exams, on every device you use. Tap one to carry on.</p>
      ${rows.length ? `<ul class="rounds">${rows.map((r) => {
        const s = r.session, pctDone = s.phase === 'grading' ? 100 : pct(answered(s), s.qids.length);
        return `<li class="round" data-course="${esc(r.courseId)}" data-slot="${esc(r.slot)}" style="--c:${MODULE_COLORS[s.module] || MODULE_COLORS.practice}">
          <a class="round-main" href="#/c/${enc(r.courseId)}/run/${enc(r.slot)}">
            ${icon(ICONS[s.module] ? s.module : 'practice', 'round-ico')}
            <span class="grow">
              <b>${esc(s.title || MODULES[s.module]?.label || 'Practice')}</b>
              <small class="muted">${esc(r.courseName)}${s.module === 'exam' ? ' · Mock exam' : ''}</small>
              <span class="meter"><span style="width:${pctDone}%"></span></span>
              <small class="muted">${status(s)} · ${s.startedAt ? `started ${relTime(new Date(s.startedAt).toISOString())}` : `saved ${relTime(r.updatedAt)}`}</small>
            </span>
            <span class="btn small primary round-go">Resume</span>
          </a>
          <button class="icon-btn round-del" data-act="delete-round" aria-label="Delete this round" title="Delete">${icon('trash')}</button>
        </li>`;
      }).join('')}</ul>` : `<div class="card empty"><h2>Nothing in progress</h2><p>Start a practice round or a mock exam from one of your courses; until you finish it, it waits here.</p><a class="btn primary" href="#/">My courses</a></div>`}
    </div>`;
  $$('[data-act="delete-round"]', app).forEach((b) => b.addEventListener('click', async () => {
    const li = b.closest('.round');
    const name = $('b', li).textContent;
    if (!(await confirmDialog(`Delete “${name}”?`, 'The unfinished round is removed. Answers already submitted stay in your history and statistics.', 'Delete', true))) return;
    sessions.clear(li.dataset.course, li.dataset.slot);
    await flushAllSessions();
    toast('Round deleted');
    if (seq === routeSeq) progressPage();
  }));
}

// ---------- Messages: reports of mistakes in questions, on your courses and the ones you sent ----------
const statusPill = (st) => `<span class="pill status-${esc(st)}">${esc(STATUS_LABELS[st] || st)}</span>`;
const plainStem = (s) => String(s || '').replace(/!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]*\]\]/g, '🖼').replace(/\{\{([^}]*)\}\}/g, '___').replace(/\s+/g, ' ').trim();

async function messagesPage() {
  const seq = routeSeq;
  const [{ received, sent }, convs] = await Promise.all([api('GET', '/api/reports'), api('GET', '/api/messages')]);
  if (seq !== routeSeq) return;
  const row = (r, who) => `<li><a class="row-link msg-row report-row ${r.unread ? 'unread' : ''}" href="#/messages/${r.id}">
      <span class="msg-dot" aria-hidden="true"></span>
      <span class="grow"><b>${esc(plainStem(r.stem) || '(no text)')}</b>
        <small class="muted">${r.unread ? '<span class="sr-only">New. </span>' : ''}<span class="badge">${esc(KIND_LABELS[r.kind] || r.kind)}</span> ${who} · ${esc(r.course.name)} · ${relTime(r.repliedAt && who.startsWith('to') ? r.repliedAt : r.createdAt)}</small></span>
      ${statusPill(r.status)}</a></li>`;
  const open = received.filter((r) => r.status === 'open').length;
  app.innerHTML = `${topbar('Messages')}
    <div class="page narrow">
      <div class="page-head"><h1>Messages</h1></div>
      <p class="muted small lead">Messages from other people, reports of mistakes in your questions, and the answers to your own reports.</p>
      <section class="card">
        <h3>Conversations</h3>
        ${convs.length ? `<ul class="row-list">${convs.map((c) => `<li><a class="row-link msg-row ${c.unread ? 'unread' : ''}" href="#/messages/u/${enc(c.with)}">
            <span class="msg-dot" aria-hidden="true"></span>
            <span class="avatar-sm" aria-hidden="true">${esc([...c.with][0].toUpperCase())}</span>
            <span class="grow"><b>${esc(c.with)}</b><small class="muted">${c.unread ? `<span class="sr-only">${c.unread} new. </span>` : ''}${c.last.mine ? 'You: ' : ''}${esc(c.last.body.replace(/\s+/g, ' '))}</small></span>
            <small class="muted msg-time">${relTime(c.last.at)}</small></a></li>`).join('')}</ul>`
          : '<p class="muted">No messages yet. To write to a course\'s owner, open the course under Public and tap Message.</p>'}
      </section>
      <section class="card">
        <h3>Reports on your courses${open ? ` <span class="count-chip">${open} open</span>` : ''}</h3>
        ${received.length ? `<ul class="row-list">${received.map((r) => row(r, `from ${esc(r.reporter || 'someone')}`)).join('')}</ul>` : '<p class="muted">No reports yet. Learners can report a question from its Report button while they practise.</p>'}
      </section>
      <section class="card">
        <h3>Your reports</h3>
        ${sent.length ? `<ul class="row-list">${sent.map((r) => row(r, `to ${esc(r.owner || 'the owner')}`)).join('')}</ul>` : '<p class="muted">Found a mistake in a question you practise? Tap Report under it; the course owner gets it.</p>'}
      </section>
    </div>`;
}

async function messagePage(rid) {
  const seq = routeSeq;
  const r = await api('GET', `/api/reports/${rid}`);
  if (seq !== routeSeq) return;
  const isOwner = r.role === 'owner';
  const owner = r.owner || 'the owner';
  const card = (q) => {
    const el = questionCard(q, {}, { mode: 'review', showFeedback: true, locked: true, autoSubmit: false, onChange() {}, onSubmit() {}, onSelfGrade: null, footer: null });
    el.classList.add('msg-qcard');
    return el;
  };
  app.innerHTML = `${topbar(`<a href="#/messages">Messages</a> › Report`)}
    <div class="page narrow">
      <section class="card msg-head">
        <p class="msg-meta"><span class="badge type">${esc(KIND_LABELS[r.kind] || r.kind)}</span>${statusPill(r.status)}</p>
        <h3>${isOwner ? `${esc(r.reporter || 'Someone')} reported a problem` : `Your report to ${esc(owner)}`}</h3>
        <p class="muted small">${esc(r.course.name)} · ${new Date(r.createdAt).toLocaleString()}</p>
        <blockquote class="msg-text">${esc(r.message)}</blockquote>
      </section>
      <section class="msg-question">
        <h3 class="msg-sub">${r.question ? (r.changed ? 'The question now' : 'The question') : 'The question'}</h3>
        <div class="msg-current"></div>
        ${r.question && r.changed ? '<details class="msg-was"><summary>As it was when reported</summary><div class="msg-reported"></div></details>' : ''}
        ${isOwner && r.question ? `<div class="actions-row"><button class="btn" data-act="edit">${icon('practice')} Edit question</button></div>` : ''}
      </section>
      ${isOwner ? `<form class="card msg-reply">
          <h3>Your answer to ${esc(r.reporter || 'them')}</h3>
          <div class="segmented status-pick" role="radiogroup" aria-label="Status">${[['fixed', 'Fixed'], ['declined', 'No change needed'], ['open', 'Still open']].map(([v, l]) => `<label><input type="radio" name="status" value="${v}" ${(r.status === 'open' ? (r.changed ? 'fixed' : '') : r.status) === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
          <label class="field"><span>Reply</span><textarea name="reply" rows="3" maxlength="4000" placeholder="${r.changed ? 'e.g. Thanks, the answer is corrected.' : 'e.g. The answer is right: see chapter 3, “…”'}">${esc(r.reply || '')}</textarea></label>
          ${r.repliedAt ? `<p class="hint">Last answered ${relTime(r.repliedAt)}.</p>` : ''}
          <div class="actions-row"><button class="btn primary" type="submit">${r.repliedAt ? 'Update answer' : 'Send answer'}</button></div>
        </form>`
      : `<section class="card msg-answer">
          <h3>${esc(owner)}'s answer</h3>
          ${r.repliedAt ? `${r.reply ? `<blockquote class="msg-text">${esc(r.reply)}</blockquote>` : ''}<p class="muted small">${r.status === 'fixed' ? 'Marked as fixed' : r.status === 'declined' ? 'No change needed' : 'Still open'} · ${relTime(r.repliedAt)}</p>`
            : `<p class="muted">No answer yet. You'll see it here, and the bell at the top shows when it arrives.</p>`}
          ${r.canApply ? `<div class="msg-apply"><p class="small">The question in “${esc(r.course.name)}” differs from the one in your copy, “${esc(r.fromCourse.name)}”.</p><button class="btn primary" data-act="apply">Use the new version in my copy</button><p class="hint">Your answers and stars on it are kept.</p></div>` : ''}
          ${r.status === 'open' ? '<div class="actions-row"><button class="btn ghost danger-text" data-act="withdraw">Withdraw report</button></div>' : ''}
        </section>`}
    </div>`;
  $('.msg-current', app).replaceChildren(r.question ? card(r.question) : Object.assign(document.createElement('p'), { className: 'muted', textContent: 'This question has been removed from the course. As it was when reported:' }));
  if (!r.question && r.reported) $('.msg-current', app).append(card(r.reported));
  if (r.question && r.changed) $('.msg-reported', app).replaceChildren(card(r.reported));

  $('[data-act="edit"]', app)?.addEventListener('click', async () => {
    const res = await openReparse(r.course.id, r.qid);
    if (!res) return;
    await sessions.reload(r.course.id);
    invalidate(r.course.id);
    if (seq !== routeSeq) return;
    await messagePage(rid);
    toast('Question updated. Mark it fixed and send your answer', 'ok', 3500);
  });
  $('.msg-reply', app)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.target));
    if (!form.status) { toast('Choose Fixed, No change needed, or Still open', 'warn'); return; }
    try {
      await api('PATCH', `/api/reports/${rid}`, { status: form.status, reply: form.reply });
      toast(`Answer sent to ${r.reporter || 'the reporter'}`, 'ok');
      navigate('#/messages');
    } catch (err) { toast(err.message, 'error'); }
  });
  $('[data-act="apply"]', app)?.addEventListener('click', async () => {
    try {
      const res = await api('POST', `/api/reports/${rid}/apply`);
      await sessions.reload(res.courseId);
      invalidate(res.courseId);
      toast(`Updated in “${r.fromCourse.name}”`, 'ok');
      if (seq === routeSeq) messagePage(rid);
    } catch (err) { toast(err.message, 'error'); }
  });
  $('[data-act="withdraw"]', app)?.addEventListener('click', async () => {
    if (!(await confirmDialog('Withdraw this report?', `${owner} won't see it any more.`, 'Withdraw', true))) return;
    try { await api('DELETE', `/api/reports/${rid}`); toast('Report withdrawn'); navigate('#/messages'); } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- a conversation, laid out like a messaging app ----------
// Phones: the chat fills the screen (its own header with Back, no tab bar) and the message box stays above the keyboard.
// Wide screens: the conversation list on the left, the chat on the right. New messages come in by themselves.
const SEND_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.99.99 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z"/></svg>';
const BACK_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
const avatarOf = (name, cls = 'avatar-sm') => `<span class="${cls}" style="${courseColor(name)};background:var(--c);color:var(--on)" aria-hidden="true">${esc([...String(name)][0].toUpperCase())}</span>`;
const timeOf = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function chatDay(iso) {
  const d = new Date(iso), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, days < 7 ? { weekday: 'long' } : { year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' });
}

/** Bubbles: a date pill when the day changes; messages from the same person a few minutes apart form one group. */
function chatBubbles(msgs, other) {
  let html = '';
  msgs.forEach((m, i) => {
    const prev = msgs[i - 1], next = msgs[i + 1];
    const day = chatDay(m.at);
    if (!prev || chatDay(prev.at) !== day) html += `<li class="chat-day"><span>${esc(day)}</span></li>`;
    const joins = (a, b) => a && b && a.mine === b.mine && chatDay(a.at) === chatDay(b.at) && Math.abs(new Date(b.at) - new Date(a.at)) < 5 * 60000;
    const first = !joins(prev, m), last = !joins(m, next);
    const ticks = m.mine ? `<span class="tick ${m.read ? 'read' : ''}" title="${m.failed ? 'Not sent' : m.pending ? 'Sending' : m.read ? 'Read' : 'Sent'}">${m.failed ? '!' : m.pending ? '◷' : m.read ? '✓✓' : '✓'}</span>` : '';
    html += `<li class="msg ${m.mine ? 'mine' : 'theirs'} ${first ? 'first' : ''} ${last ? 'last' : ''} ${m.failed ? 'failed' : ''}">
      ${!m.mine ? (last ? avatarOf(other, 'avatar-xs') : '<span class="avatar-gap"></span>') : ''}
      <div class="bubble">${m.course ? `<a class="bubble-course" href="#/p/${enc(m.course.id)}">About “${esc(m.course.name || m.course.id)}”</a>` : ''}<span class="bubble-text">${esc(m.body)}</span><span class="bubble-meta"><time datetime="${esc(m.at)}">${timeOf(m.at)}</time>${ticks}</span></div>
    </li>`;
  });
  return html;
}

const convRow = (c, current) => `<li><a class="conv ${c.with === current ? 'current' : ''} ${c.unread ? 'unread' : ''}" href="#/messages/u/${enc(c.with)}">
    ${avatarOf(c.with, 'avatar-md')}
    <span class="grow"><span class="conv-top"><b>${esc(c.with)}</b><small>${esc(relTime(c.last.at))}</small></span>
      <span class="conv-bottom"><small>${c.last.mine ? 'You: ' : ''}${esc(c.last.body.replace(/\s+/g, ' '))}</small>${c.unread ? `<span class="conv-badge">${c.unread}</span>` : ''}</span></span></a></li>`;

async function dmPage(name, params) {
  const seq = routeSeq;
  const courseId = params?.get?.('course') || null;
  const [t, convs, profile, course] = await Promise.all([
    api('GET', `/api/messages/${enc(name)}`),
    api('GET', '/api/messages'),
    api('GET', `/api/users/${enc(name)}`).catch(() => null),
    courseId ? api('GET', `/api/courses/${enc(courseId)}`).then((d) => d.course).catch(() => null) : null,
  ]);
  if (seq !== routeSeq) return;
  const other = t.with.username;
  const msgs = t.messages;
  const status = profile ? (profile.courses?.length ? `${profile.courses.length} public course${profile.courses.length === 1 ? '' : 's'}` : `Member since ${new Date(profile.memberSince).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}`) : '';
  document.body.classList.add('in-chat');
  app.innerHTML = `${tabbar()}
    <div class="chat-app">
      <aside class="chat-side" aria-label="Conversations">
        <header class="chat-side-head"><a class="btn small ghost" href="#/messages">${BACK_ICON}<span>Messages</span></a></header>
        <ul class="conv-list">${convs.some((c) => c.with === other) ? '' : convRow({ with: other, last: { body: 'New conversation', at: new Date().toISOString() }, unread: 0 }, other)}${convs.map((c) => convRow(c, other)).join('')}</ul>
      </aside>
      <section class="chat" aria-label="Conversation with ${esc(other)}">
        <header class="chat-bar">
          <a class="icon-btn chat-back" href="#/messages" aria-label="Back to Messages">${BACK_ICON}</a>
          ${avatarOf(other, 'avatar-md')}
          <span class="grow"><b>${esc(other)}</b><small class="muted">${esc(status)}</small></span>
        </header>
        <div class="chat-scroll"><ul class="chat-list" aria-live="polite"></ul></div>
        ${t.canMessage ? `<form class="chat-compose">
            ${course ? `<div class="chat-about"><span>About <b>${esc(course.name)}</b></span><button type="button" class="icon-btn" data-act="no-course" aria-label="Don't attach the course">✕</button></div>` : ''}
            <div class="chat-row"><textarea name="body" rows="1" maxlength="4000" placeholder="Message" aria-label="Message to ${esc(other)}" enterkeyhint="send"></textarea>
            <button class="send-btn" type="submit" aria-label="Send" disabled>${SEND_ICON}</button></div>
          </form>` : `<p class="chat-closed muted small">You can write to ${esc(other)} once they have a course you can see.</p>`}
      </section>
    </div>`;
  const chatApp = $('.chat-app', app);
  const scroller = $('.chat-scroll', app);
  const list = $('.chat-list', app);
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const draw = (stick = true) => {
    const was = nearBottom();
    list.innerHTML = msgs.length ? chatBubbles(msgs, other) : `<li class="chat-empty">${avatarOf(other, 'avatar-big')}<b>${esc(other)}</b><span class="muted">No messages yet. Say hello${course ? `, or ask about “${esc(course.name)}”` : ''}.</span></li>`;
    if (stick || was) scroller.scrollTop = scroller.scrollHeight;
  };
  draw();

  // phones: keep the whole chat inside the part of the screen the keyboard leaves free
  const vv = window.visualViewport;
  const fit = () => {
    if (!chatApp.isConnected) return;
    chatApp.style.setProperty('--vvh', `${vv.height}px`);
    chatApp.style.setProperty('--vvt', `${vv.offsetTop}px`);
    if (document.activeElement?.closest?.('.chat-compose')) scroller.scrollTop = scroller.scrollHeight;
  };
  vv?.addEventListener('resize', fit);
  vv?.addEventListener('scroll', fit);
  fit();

  // new messages and read marks come in while the chat is open
  const timer = setInterval(async () => {
    if (seq !== routeSeq || !chatApp.isConnected) { clearInterval(timer); vv?.removeEventListener('resize', fit); vv?.removeEventListener('scroll', fit); document.body.classList.remove('in-chat'); return; }
    if (document.visibilityState !== 'visible') return;
    try {
      const fresh = await api('GET', `/api/messages/${enc(other)}`);
      if (seq !== routeSeq) return;
      const pending = msgs.filter((m) => m.pending || m.failed);
      const sig = (a) => a.map((m) => `${m.id}:${m.read}`).join();
      if (sig(fresh.messages) !== sig(msgs.filter((m) => !m.pending && !m.failed))) {
        const gotNew = fresh.messages.length > msgs.length - pending.length;
        msgs.splice(0, msgs.length, ...fresh.messages, ...pending);
        draw(false);
        if (gotNew) refreshInbox();
      }
      const side = await api('GET', '/api/messages');
      if (seq === routeSeq && $('.conv-list', app)) $('.conv-list', app).innerHTML = side.map((c) => convRow(c, other)).join('') || convRow({ with: other, last: { body: 'New conversation', at: new Date().toISOString() }, unread: 0 }, other);
    } catch { /* offline for a moment: try again on the next tick */ }
  }, 4000);

  let about = course?.id || null;
  $('[data-act="no-course"]', app)?.addEventListener('click', (e) => { about = null; e.target.closest('.chat-about').remove(); });
  const form = $('.chat-compose', app);
  if (!form) return;
  const ta = $('textarea', form), send = $('.send-btn', form);
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`; send.disabled = !ta.value.trim(); };
  ta.addEventListener('input', grow);
  if (matchMedia('(pointer: fine)').matches) ta.focus();
  // Enter sends on a keyboard (Shift+Enter: new line); on a phone Enter is a new line and the button sends
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); form.requestSubmit(); } });
  const deliver = async (m) => {
    try {
      const saved = await api('POST', `/api/messages/${enc(other)}`, { body: m.body, courseId: m.courseId });
      Object.assign(m, saved, { pending: false, failed: false });
    } catch (err) {
      Object.assign(m, { pending: false, failed: true });
      toast(`Not sent: ${err.message}. Tap the message to try again`, 'error', 4000);
    }
    if (seq === routeSeq) draw(false);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = ta.value.trim();
    if (!body) return;
    // shown at once, ticked when the server has it
    const m = { id: `tmp-${Date.now()}`, mine: true, body, at: new Date().toISOString(), read: false, pending: true, courseId: about,
      ...(about && course ? { course: { id: course.id, name: course.name } } : {}) };
    msgs.push(m);
    ta.value = '';
    grow();
    about = null; // only the first message carries the course
    $('.chat-about', app)?.remove();
    draw();
    ta.focus();
    deliver(m);
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('.msg.failed');
    if (!li) return;
    const m = msgs.filter((x) => x.mine)[[...list.querySelectorAll('.msg.mine')].indexOf(li)];
    if (m?.failed) { m.failed = false; m.pending = true; draw(false); deliver(m); }
  });
}

// ---------- My courses tab: the ones you own (your own and your forks) ----------
function myCoursesPage() {
  return withCourses(drawMine);
}

const PIN = '<svg class="ico-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 15v6"/></svg>';

function drawMine(courses) {
  // pinned courses in a row of their own (the latest pin first), the rest below in the server's order
  const mine = courses.filter((c) => c.mine);
  mine.sort((x, y) => (y.pinnedAt || '').localeCompare(x.pinnedAt || ''));
  const pinBtn = (c) => `<button type="button" class="ct-pin ${c.pinnedAt ? 'on' : ''}" data-pin="${esc(c.id)}" aria-pressed="${!!c.pinnedAt}"
    title="${c.pinnedAt ? 'Unpin' : 'Pin to the top'}" aria-label="${c.pinnedAt ? 'Unpin' : 'Pin'} ${esc(c.name)}">${PIN}</button>`;
  app.innerHTML = `${topbar()}
    <div class="page">
      <div class="page-head">
        <h1>My courses</h1>
        <div class="actions-row"><a class="btn ghost" href="#/import">Import questions</a><button class="btn primary" data-act="new">+ New course</button></div>
      </div>
      ${mine.length ? [mine.filter((c) => c.pinnedAt), mine.filter((c) => !c.pinnedAt)].filter((g) => g.length)
    .map((g) => `<div class="course-tiles">${g.map((c) => `<div class="ct-wrap">${courseTile(c)}${pinBtn(c)}</div>`).join('')}</div>`).join('') : `
      <div class="card empty">
        <h2>No courses yet</h2>
        <p>Fork one from <a href="#/public">Public</a> to practise it, or make your own: paste a paper, upload Markdown/JSON, or ask Claude in the terminal:</p>
        <ul class="tips">
          <li>“Find past exam papers for <i>Linear Algebra</i> and load them”</li>
          <li>“Load the questions from my vault notes in <i>Courses/Physics</i>”</li>
          <li>“Here are my test questions: …”</li>
        </ul>
        <button class="btn primary" data-act="new">+ New course</button>
      </div>`}
    </div>`;
  $$('[data-act="new"]', app).forEach((b) => b.addEventListener('click', newCourseDialog));
  $$('[data-pin]', app).forEach((b) => b.addEventListener('click', async () => {
    const c = courses.find((x) => x.id === b.dataset.pin);
    try {
      const { pinnedAt } = await api('PUT', `/api/courses/${enc(c.id)}/pin`, { pinned: !c.pinnedAt });
      coursesCache = courses.map((x) => (x.id === c.id ? { ...x, pinnedAt } : x));
      drawMine(coursesCache);
      toast(pinnedAt ? `Pinned “${c.name}”` : `Unpinned “${c.name}”`, 'ok');
    } catch (err) { toast(err.message, 'error'); }
  }));
}

async function newCourseDialog() {
  const { value, form } = await dialog({
    title: 'New course',
    body: `<label class="field"><span>Name</span><input name="name" required placeholder="e.g. Linear Algebra" autofocus></label>
      <label class="field"><span>Description</span><input name="description" placeholder="optional"></label>
      <label class="field"><span>Exam date</span><input name="examDate" type="date"></label>
      <p class="hint">New courses are private.${auth.user?.isAdmin ? ' Publish one from its Settings when you want others to see it.' : ' Only an admin can publish courses.'}</p>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Create', value: 'ok', primary: true }],
    withForm: true,
  });
  if (value !== 'ok' || !form.name?.trim()) return;
  try {
    const c = await api('POST', '/api/courses', { name: form.name.trim(), description: form.description.trim() });
    if (form.examDate) await api('PATCH', `/api/courses/${enc(c.id)}`, { examDate: form.examDate });
    toast(`Created “${c.name}”`, 'ok');
    navigate(`#/settings/c/${enc(c.id)}#import`);
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
  trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 12.5h10L18 7M9 7V4.5h6V7"/>',
};
// each module keeps its own colour everywhere (ink flips to dark on the yellow tile)
const MODULE_COLORS = { practice: '#2a78d6', mistakes: '#e34948', exam: '#6250d6', starred: '#eda100' };
const icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

// a course you own: practice modules and statistics; anyone else's opens its public page
async function coursePage(id) {
  const seq = routeSeq;
  const cached = peekCourse(id);
  if (cached && !cached.course.access.isOwner) { navigate(`#/p/${enc(id)}`); return; }
  if (cached) drawCourse(id, cached);
  const fresh = await loadCourse(id, { force: true });
  if (seq !== routeSeq) return;
  if (!fresh.course.access.isOwner) { navigate(`#/p/${enc(id)}`); return; }
  // only what this page shows; server-side stats are left out so they don't force a redraw
  const shown = (d) => JSON.stringify([d.course.name, d.course.description, d.course.examDate, d.course.visibility, d.course.access, d.course.forkedFrom, d.course.questions.length, d.progress, d.masteryStreak]);
  if (!cached || shown(cached) !== shown(fresh)) drawCourse(id, fresh);
}

/** The public page of a course (from the Public tab): what is in it, never the practice modules. */
async function publicCoursePage(id) {
  const seq = routeSeq;
  const cached = peekCourse(id);
  if (cached) drawCourseInfo(id, cached);
  const [fresh] = await Promise.all([loadCourse(id, { force: true }), coursesCache || api('GET', '/api/courses').then((l) => { coursesCache = l; })]);
  if (seq === routeSeq) drawCourseInfo(id, fresh); // lists your forks of it, so drawn again once the list is in
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

  const tiles = [
    { key: 'practice', title: 'Practice', info: `${practiceCount} questions`, n: practiceCount },
    examReady
      ? { key: 'exam', title: 'Mock exam', info: `${exam.questions} q · ${exam.timeMin ? `${exam.timeMin} min` : 'no limit'}`, n: exam.questions }
      : { key: 'exam', title: 'Mock exam', info: 'Tap to set up', href: `#/settings/c/${enc(id)}#exam`, unset: true },
    { key: 'mistakes', title: 'Mistakes', info: mistakes ? `${mistakes} to review` : 'All clear', n: mistakes },
    { key: 'starred', title: 'Starred', info: starred ? `${starred} saved` : 'None yet', n: starred, on: '#2b1a00' },
    { key: 'stats', title: 'Statistics', info: 'Progress & accuracy', href: `${base}/stats`, color: '#1baf7a' },
  ];
  const tile = (t) => {
    // a module with an unfinished session says so; tapping it offers Resume / Start new
    const run = inProgress[t.key];
    const info = run && (run.answered || run.phase !== 'answering') ? `In progress · ${run.answered}/${run.qids.length}` : t.info;
    const attrs = `class="mtile ${t.unset ? 'unset' : ''} ${run ? 'resumable' : ''}" data-mod="${t.key}" style="--c:${t.color || MODULE_COLORS[t.key]};--on:${t.on || '#fff'}"`;
    const inner = `${icon(t.key, 'mtile-ico')}<span class="mtile-title">${t.title}</span><span class="mtile-info">${info}</span>`;
    return t.href
      ? `<a href="${t.href}" ${attrs}>${inner}</a>`
      : `<button type="button" ${attrs} data-start="${t.key}" ${t.n ? '' : 'aria-disabled="true"'}>${inner}</button>`;
  };

  app.innerHTML = `${topbar(esc(course.name))}
    <div class="page">
      <section class="hero">
        <div class="hero-main">
          ${monogram(course.name, 'big', course.id)}
          <div class="hero-text">
            <h1>${esc(course.name)}</h1>
            ${summaryOf(course.description) ? `<p class="muted">${esc(summaryOf(course.description))}</p>` : ''}
            <p class="course-meta">${stats.total} questions</p>
            ${countdownPill(course.examDate)}
          </div>
        </div>
        <div class="hero-actions">${courseStatus(course)}</div>
      </section>
      ${drill ? `<div class="resume">
        <span class="resume-dot" aria-hidden="true"></span>
        <div class="grow"><b>${esc(drill.title)}</b> in progress<span class="muted"> · ${drill.answered} of ${drill.qids.length} answered · started ${relTime(new Date(drill.startedAt).toISOString())}</span></div>
        <div class="actions-row"><button class="btn ghost small" data-act="discard">Discard</button><a class="btn primary small" href="${base}/run/drill">Resume</a></div>
      </div>` : ''}
      ${!stats.total ? `<div class="card empty"><h2>No questions yet</h2><p>Import a paper, notes, or a JSON bank to get started.</p><a class="btn primary" href="#/settings/c/${enc(id)}#import">Import questions</a></div>` : ''}
      <div class="mtiles">${tiles.map(tile).join('')}</div>
    </div>`;
  $('[data-act="discard"]', app)?.addEventListener('click', async () => {
    if (await confirmDialog('Discard unfinished session?', 'Answers already submitted stay in your history.', 'Discard', true)) { sessions.clear(id, 'drill'); coursePage(id); }
  });
  $$('[data-start]', app).forEach((b) => b.addEventListener('click', () => {
    if (b.getAttribute('aria-disabled') === 'true') {
      toast({ mistakes: 'No mistakes to review — nice!', starred: 'Tap ☆ on a question to save it here', practice: 'No questions match your Settings' }[b.dataset.start] || 'Nothing here yet', 'info');
      return;
    }
    startSession(id, b.dataset.start);
  }));
}

/**
 * A course's public page: what it is and what is in it. Practising happens elsewhere: on a fork of your own, or, for
 * your own course, from My courses.
 */
function drawCourseInfo(id, data) {
  const { course, progress, stats } = data;
  const own = course.access.isOwner;
  const about = aboutOf(course.description);
  const forks = (coursesCache || []).filter((c) => c.mine && c.forkedFrom?.id === id);
  const chapters = chapterStats(course, progress.questions);
  const papers = pastPapers(course);
  const exam = examSummary(progress.settings, stats.byType);
  const samples = course.questions.slice(0, 3);
  const forkBtn = (cls = '') => `<button class="btn primary ${cls}" data-act="fork">${forks.length ? 'Fork again' : 'Fork to practise'}</button>`;
  app.innerHTML = `${topbar(esc(course.name))}
    <div class="page narrow">
      <section class="hero">
        <div class="hero-main">
          ${monogram(course.name, 'big', course.id)}
          <div class="hero-text">
            <h1>${esc(course.name)}</h1>
            ${summaryOf(course.description) ? `<p class="muted">${esc(summaryOf(course.description))}</p>` : ''}
            <p class="course-meta">${own ? `${courseOwnerLine(course)} · yours` : courseOwnerLine(course)} · ${stats.total} questions${course.updatedAt ? ` · updated ${relTime(course.updatedAt)}` : ''}${course.forkedFrom ? ` · forked from <a href="#/p/${enc(course.forkedFrom.id)}">${esc(course.forkedFrom.name)}</a>` : ''}</p>
            ${countdownPill(course.examDate)}
          </div>
        </div>
        ${own ? `<div class="hero-actions">${visibilityButton(course)}<a class="btn small ghost" href="#/settings/c/${enc(id)}#course">Edit details</a></div>`
          : course.access.canManage ? `<div class="hero-actions">${visibilityButton(course)}<button class="btn small ghost danger-text" data-act="delete">Delete</button></div>` : ''}
      </section>
      ${own ? `<div class="resume">
        <span class="resume-dot" aria-hidden="true"></span>
        <div class="grow"><b>This is your course</b><span class="muted"> · this is how others see it; practise it under My courses</span></div>
        <div class="actions-row"><a class="btn primary small" href="#/c/${enc(id)}" data-open-fork>Open in My courses</a></div>
      </div>` : forks.length ? `<div class="resume">
        <span class="resume-dot" aria-hidden="true"></span>
        <div class="grow"><b>You have a copy</b><span class="muted"> · practise it under My courses</span></div>
        <div class="actions-row">${forks.map((f) => `<a class="btn primary small" href="#/c/${enc(f.id)}" data-open-fork>Open ${forks.length > 1 ? `“${esc(f.name)}”` : 'my copy'}</a>`).join('')}</div>
      </div>` : `<section class="card fork-cta">
        <div class="grow"><h3>Fork to practise</h3>
          <p class="muted small">Practice, a mistakes book, starred questions and mock exams run on your own copy: private to you, and yours to edit or add to.${stats.attempts ? ` Your ${stats.attempts} earlier answers on this course come along.` : ''}</p></div>
        ${forkBtn('big')}
      </section>`}
      ${about ? `<section class="card about"><h3>About this course</h3><div class="prose">${md(about)}</div></section>`
        : own ? `<section class="card about"><h3>About this course</h3><p class="muted small">No description yet. <a href="#/settings/c/${enc(id)}#course">Add one</a>: its first line is the summary on the course card, the lines after it show here.</p></section>` : ''}
      ${course.owner ? `<section class="card owner-card" data-owner="${esc(course.owner.username)}"><h3>Made by</h3>${ownerCard({ username: course.owner.username })}</section>` : ''}
      <section class="card">
        <h3>What's inside</h3>
        ${stats.total ? `<div class="info-mix">${typeMix(stats.byType, stats.total)}</div>` : '<p class="muted">No questions yet.</p>'}
        ${chapters.length > 1 ? `<h4>Chapters</h4><ul class="info-list">${chapters.map((c) => `<li><span class="grow">${esc(c.name || 'No chapter')}</span><span class="muted">${c.total} q</span></li>`).join('')}</ul>` : ''}
        ${papers.length ? `<h4>Past papers</h4><ul class="info-list">${papers.map((p) => `<li><span class="grow">${esc(p.name)}</span><span class="muted">${p.questions.length} q</span></li>`).join('')}</ul>` : ''}
        ${examConfigured(progress.settings) ? `<h4>Mock exam</h4><p class="muted small">${exam.questions} questions · ${exam.maxScore} points · ${exam.timeMin ? `${exam.timeMin} min` : 'no time limit'}${progress.settings.exam.tag ? ' · from past papers' : ''}</p>` : ''}
      </section>
      ${samples.length ? `<section class="card">
        <h3>Sample questions</h3>
        <ol class="preview-list">${samples.map((q) => `<li><span class="badge type">${esc(TYPE_LABELS[q.type])}</span> ${mdInline(q.stem.split('\n')[0].slice(0, 160))}</li>`).join('')}</ol>
      </section>` : ''}
    </div>`;
  $$('[data-act="fork"]', app).forEach((b) => b.addEventListener('click', () => forkDialog(data)));
  $$('[data-open-fork]', app).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openUnderMyCourses(a.getAttribute('href').slice(1)); }));
  $('[data-act="visibility"]', app)?.addEventListener('click', () => toggleVisibility(data));
  $('[data-act="delete"]', app)?.addEventListener('click', () => deleteCourse(data));
  if (course.owner) {
    const seq = routeSeq;
    api('GET', `/api/users/${enc(course.owner.username)}`).then((p) => {
      const card = $('.owner-card', app);
      if (card && seq === routeSeq) card.innerHTML = `<h3>Made by</h3>${ownerCard(p, id)}`;
    }).catch(() => {});
  }
}

/** A course owner in brief: who, since when, their other public courses, and a way to message them. */
function ownerCard(p, courseId) {
  const others = (p.courses || []).filter((c) => c.id !== courseId);
  return `<div class="account-head owner-head"><span class="avatar-big" aria-hidden="true">${esc([...p.username][0].toUpperCase())}</span>
      <span class="grow"><b>${esc(p.username)}${p.isYou ? ' <span class="muted">(you)</span>' : ''}</b>
        <small class="muted">${p.memberSince ? `Member since ${esc(new Date(p.memberSince).toLocaleDateString(undefined, { year: 'numeric', month: 'long' }))}` : ''}${p.courses ? ` · ${p.courses.length} public course${p.courses.length === 1 ? '' : 's'}` : ''}</small></span>
      ${p.canMessage ? `<a class="btn primary small" href="#/messages/u/${enc(p.username)}${courseId ? `?course=${enc(courseId)}` : ''}">Message</a>` : ''}</div>
    ${others.length ? `<h4>Also by ${esc(p.username)}</h4><ul class="info-list">${others.map((c) => `<li><a class="grow" href="#/p/${enc(c.id)}">${esc(c.name)}</a><span class="muted">${c.questions} q</span></li>`).join('')}</ul>` : ''}`;
}

/** Open one of your courses with My courses behind it (Back goes there, not to where you came from). */
async function openUnderMyCourses(path) {
  await navigate('#/');
  navigate(path);
}

/** Delete a course (owner, or an admin for a public one): the bank and everyone's progress on it. */
async function deleteCourse(data) {
  const { course } = data;
  if (!(await confirmDialog(`Delete “${course.name}”?`, `The question bank and all progress will be removed${data.learners ? `, including that of ${data.learners} other ${data.learners === 1 ? 'person' : 'people'}` : ''}.`, 'Delete', true))) return;
  try {
    await api('DELETE', `/api/courses/${enc(course.id)}`);
  } catch (e) { toast(e.message, 'error'); return; }
  sessions.clear(course.id);
  invalidate(course.id);
  coursesCache = null;
  toast('Course deleted');
  navigate(course.access.isOwner ? '#/' : '#/public');
}

/** Where one of your courses stands: forked from a public course, published in Public, or private to you. */
function courseStatus(course) {
  if (course.forkedFrom) return `<a class="status-chip forked" href="#/p/${enc(course.forkedFrom.id)}" title="Open the original's public page">${FORK}<span>Forked from <b>${esc(course.forkedFrom.name)}</b></span></a>`;
  if (course.visibility === 'public') return `<a class="status-chip public" href="#/p/${enc(course.id)}" title="Open its public page">${GLOBE}<span>In Public</span></a>`;
  return `<span class="status-chip">${LOCK}<span>Private</span></span>`;
}

/** Publish / Make private, for the admin only (on their own courses; any public course can be taken down). */
function visibilityButton(course) {
  if (!auth.user?.isAdmin || !course.access.canManage) return '';
  return `<button class="btn small ${course.visibility === 'public' ? 'ghost' : 'primary'}" data-act="visibility">${course.visibility === 'public' ? `${LOCK}${course.access.isOwner ? 'Make private' : 'Unpublish'}` : `${GLOBE}Publish`}</button>`;
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
    if (course.access.isOwner) route(); else navigate('#/public'); // redraw the page it was changed from
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
    toast(`Forked into “${c.name}”: it's under My courses`, 'ok');
    openUnderMyCourses(`#/c/${enc(c.id)}`);
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
  if (module === 'exam' && !examConfigured(st)) { navigate(`#/settings/c/${enc(id)}#exam`); return; }
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
    if (pick.review) { openExamReview(id, pick.review); return; }
    if (pick.paper) { ids = pick.paper.questions.map((q) => q.id); title = pick.paper.name; }
  }
  const opts = module === 'exam'
    ? { title, timeLimitSec: (st.exam.timeMin || 0) * 60, points: examSummary(st).points }
    : { title };
  sessions.save(newSession(id, module, ids, opts));
  navigate(`#/c/${enc(id)}/run/${module}`);
}

/** Open a past mock exam sitting on its results page (it is loaded into the 'review' slot). */
async function openExamReview(id, examId) {
  try {
    const d = await examDetail(id, examId);
    sessions.save({ v: 1, ...d, courseId: id, module: 'exam', slot: 'review', phase: 'done', idx: 0, instant: false });
    await flushSessions(id); // the results page reloads the rounds from the server
    navigate(`#/c/${enc(id)}/result/review`);
  } catch (e) { toast(e.message, 'error'); }
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
          <span><b>${esc(short(p.name))}</b><small>${p.questions.length} questions · ${p.questions.reduce((a, q) => a + pointsFor(q, pts), 0)} pts</small>${done(sittings(p.name))}</span>
          ${(() => { const last = sittings(p.name).filter((e) => e.reviewable).at(-1); return last ? `<button class="btn ghost small paper-review" value="review:${last.id}" formnovalidate title="Your last sitting of this paper, with answers">Review</button>` : ''; })()}</label>`).join('')}
      </div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Start', value: 'start', primary: true }],
    withForm: true,
  });
  if (typeof value === 'string' && value.startsWith('review:')) return { review: Number(value.slice(7)) };
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

  app.innerHTML = `${topbar(`<a href="#/settings">Settings</a> › ${esc(course.name)}`)}
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
        <div class="settings-foot"><a class="btn ghost" href="#/settings">Cancel</a><button class="btn primary big" type="submit">Save settings</button></div>
      </form>

      <h2 class="section-title">Course</h2>
      ${course.access.canEdit ? `<form class="card course-form" id="course">
        <label class="field"><span>Name</span><input name="name" value="${esc(course.name)}" required></label>
        <label class="field"><span>Description</span><textarea name="description" rows="6" placeholder="One-line summary&#10;&#10;More about the course: what it covers, where the questions come from, the paper's format…">${esc(course.description || '')}</textarea></label>
        <p class="hint">The first line is the summary on course cards. The lines after it are the “About this course” text on its public page (Markdown works).</p>
        <label class="field"><span>Exam date</span><input name="examDate" type="date" value="${esc(course.examDate || '')}"></label>
        <div class="actions-row"><button class="btn primary" type="submit">Save course</button>${visibilityButton(course)}</div>
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
      </section>
      ${course.access.canManage ? `<section class="card" id="history"><h3>History</h3><div class="history-peek"><p class="muted small">Loading…</p></div>
        <a class="btn ghost" href="#/settings/c/${enc(id)}/history">See all changes ›</a></section>` : ''}
      ${course.access.canManage ? `<section class="card danger-zone"><h3>Delete course</h3><p class="muted">Deletes the question bank and everyone's progress on it${data.learners ? ` (${data.learners} other ${data.learners === 1 ? 'person has' : 'people have'} practised it)` : ''}.</p><button class="btn danger" data-act="delete">Delete course</button></section>` : ''}
    </div>`;

  $('[data-act="fork"]', app)?.addEventListener('click', () => forkDialog(data));
  $('[data-act="visibility"]', app)?.addEventListener('click', () => toggleVisibility(data));
  $('form.course-form', app)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', `/api/courses/${enc(id)}`, Object.fromEntries(new FormData(e.target)));
      invalidate(id);
      coursesCache = null;
      toast('Course saved', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  });
  $('[data-act="delete"]', app)?.addEventListener('click', () => deleteCourse(data));
  if (course.access.canManage) {
    api('GET', `/api/courses/${enc(id)}/history?limit=3`).then((h) => {
      const el = $('.history-peek', app);
      if (!el || seq !== routeSeq) return;
      el.innerHTML = h.entries.length ? `<ul class="history-list compact">${h.entries.map((e) => historyRow(e, false)).join('')}</ul><p class="hint">${h.total} change${h.total === 1 ? '' : 's'} in all.</p>` : '<p class="muted">No changes recorded yet.</p>';
    }).catch(() => {});
  }
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
  const anchor = /#(exam|course|import|history)$/.exec(location.hash);
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

// ---------- course history: every change, newest first ----------
const HISTORY_ICONS = {
  created: '<path d="M12 5v14M5 12h14"/>', forked: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5"/>',
  import: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/>', question: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  'question-deleted': '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 12.5h10L18 7M9 7V4.5h6V7"/>', details: '<path d="M5 6h14M5 12h14M5 18h9"/>',
  published: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17M12 3.5a13 13 0 0 0 0 17"/>',
  unpublished: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  settings: '<path d="M4 7h9m4 0h3M4 12h3m4 0h9M4 17h11m4 0h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  report: '<path d="M5 21V4"/><path d="M5 4.5h11l-2 4 2 4H5"/>',
};
const QUESTION_FIELDS = [['type', 'Type'], ['stem', 'Question'], ['options', 'Options'], ['answer', 'Answer'], ['explanation', 'Explanation'], ['keywords', 'Key points'],
  ['chapter', 'Chapter'], ['tags', 'Tags'], ['source', 'Source'], ['difficulty', 'Difficulty'], ['media', 'Media']];

function questionValue(q, key) {
  if (q?.[key] == null || (Array.isArray(q[key]) && !q[key].length)) return '';
  if (key === 'type') return TYPE_LABELS[q.type] || q.type;
  if (key === 'answer') return isOpen(q.type) ? String(q.answer) : String(answerText(q));
  if (key === 'options') return q.options.map((o, i) => `${'ABCDEFGHIJKL'[i]}. ${o}`).join('\n');
  if (key === 'media') return q.media.map((m) => m.src || m.url || JSON.stringify(m)).join('\n');
  return Array.isArray(q[key]) ? q[key].join(', ') : String(q[key]);
}

/** Before → after, for the fields that changed. */
function diffRows(rows) {
  return rows.length ? `<dl class="diff">${rows.map(([label, before, after]) => `<dt>${esc(label)}</dt>
    <dd>${before ? `<del>${esc(before)}</del>` : ''}${after ? `<ins>${esc(after)}</ins>` : '<ins class="none">(removed)</ins>'}</dd>`).join('')}</dl>` : '';
}

/** Study settings before → after, one row per setting that changed. */
function settingsRows(before = {}, after = {}) {
  const types = (a) => (a?.length ? a.map((t) => TYPE_LABELS[t] || t).join(', ') : 'all types');
  const rows = [
    ['Chapters', (x) => (x.chapters?.length ? x.chapters.join(', ') : 'all chapters')],
    ['Practice: question types', (x) => types(x.practice?.types)],
    ['Practice: questions per round', (x) => (x.practice?.count ? String(x.practice.count) : 'all')],
    ['Mistakes: question types', (x) => types(x.mistakes?.types)],
    ['Mistakes: frequent only', (x) => (x.mistakes?.frequentOnly ? 'yes' : 'no')],
    ['Mock exam: draws from', (x) => (x.exam?.tag ? 'past papers only' : 'whole course')],
    ['Mock exam: duration', (x) => (x.exam?.timeMin ? `${x.exam.timeMin} min` : 'no limit')],
  ];
  for (const t of TYPES) {
    rows.push([`Mock exam: ${TYPE_LABELS[t]} questions`, (x) => String(x.exam?.perType?.[t] || 0)]);
    rows.push([`Mock exam: ${TYPE_LABELS[t]} points each`, (x) => (x.exam?.points?.[t] != null ? String(x.exam.points[t]) : 'default')]);
  }
  return rows.map(([label, f]) => [label, f(before || {}), f(after || {})]).filter(([, b, a]) => b !== a);
}

function historyDetail(e) {
  const d = e.detail;
  if (!d) return '';
  if (e.action === 'settings') return diffRows(settingsRows(d.before, d.after));
  if (e.action === 'question') {
    const rows = QUESTION_FIELDS.map(([k, label]) => [label, questionValue(d.before, k), questionValue(d.after, k)]).filter(([, b, a]) => b !== a);
    const rg = d.regraded;
    return `${d.why ? `<p class="small muted">${esc(d.why)}</p>` : ''}${diffRows(rows)}${rg ? `<p class="small muted">Graded again: ${[rg.attempts && `${rg.attempts} answer${rg.attempts === 1 ? '' : 's'}`, rg.exams && `${rg.exams} mock exam sitting${rg.exams === 1 ? '' : 's'}`, rg.sessions && `${rg.sessions} saved round${rg.sessions === 1 ? '' : 's'}`].filter(Boolean).join(', ')}.</p>` : ''}`;
  }
  if (e.action === 'question-deleted') return diffRows(QUESTION_FIELDS.map(([k, label]) => [label, questionValue(d.before, k), '']).filter(([, b]) => b)).replaceAll('<ins class="none">(removed)</ins>', '');
  if (e.action === 'details') {
    const label = { name: 'Name', description: 'Description', examDate: 'Exam date' };
    return diffRows(Object.entries(d.fields || {}).map(([k, v]) => [label[k] || k, v.before || '', v.after || '']));
  }
  if (e.action === 'report') {
    return `<p class="small"><b>Report:</b> ${esc(d.message || '')}</p>${d.reply ? `<p class="small"><b>Answer:</b> ${esc(d.reply)}</p>` : ''}<a class="small" href="#/messages/${d.report}">Open the report</a>`;
  }
  if (e.action === 'import' && d.added != null) return `<p class="small muted">${d.added} added · ${d.updated} updated · ${d.unchanged} unchanged${d.removed ? ` · ${d.removed} removed` : ''} · ${d.total} in the course after it</p>`;
  return '';
}

/** The entry's line; a question's stem is rendered (formulas, bold) rather than shown as source. */
function historySummary(e) {
  const q = e.action === 'question' ? e.detail?.after : e.action === 'question-deleted' ? e.detail?.before : null;
  if (!q?.stem) return esc(e.summary);
  return `${e.action === 'question' ? 'Edited a question' : 'Deleted a question'}: <span class="history-stem">${mdInline(String(q.stem).split('\n')[0])}</span>`;
}

function historyRow(e, expandable = true) {
  const detail = expandable ? historyDetail(e) : '';
  const head = `<svg class="ico history-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${HISTORY_ICONS[e.action] || HISTORY_ICONS.details}</svg>
    <span class="grow"><span class="history-sum">${historySummary(e)}</span><small class="muted">${esc(e.by || 'import script')} · <time datetime="${esc(e.at)}" title="${esc(new Date(e.at).toLocaleString())}">${esc(relTime(e.at))}</time></small></span>`;
  return `<li class="history-item action-${esc(e.action)}">${detail ? `<details><summary>${head}</summary><div class="history-detail">${detail}</div></details>` : `<div class="history-head">${head}</div>`}</li>`;
}

async function historyPage(id) {
  const seq = routeSeq;
  const data = await loadCourse(id);
  const h = await api('GET', `/api/courses/${enc(id)}/history?limit=100`);
  if (seq !== routeSeq) return;
  const entries = [...h.entries];
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  const draw = () => {
    const groups = [];
    for (const e of entries) {
      const d = day(e.at);
      if (groups.at(-1)?.day !== d) groups.push({ day: d, items: [] });
      groups.at(-1).items.push(e);
    }
    $('.history-groups', app).innerHTML = groups.map((g) => `<h3 class="history-day">${esc(g.day)}</h3><ul class="history-list">${g.items.map((e) => historyRow(e)).join('')}</ul>`).join('')
      || '<div class="card empty"><h2>No changes yet</h2><p>Imports, question edits, course details, publishing and settings changes will be listed here.</p></div>';
    const more = $('[data-act="more"]', app);
    more.hidden = entries.length >= h.total;
  };
  app.innerHTML = `${topbar(`<a href="#/settings">Settings</a> › <a href="#/settings/c/${enc(id)}">${esc(data.course.name)}</a> › History`)}
    <div class="page narrow">
      <div class="page-head"><h1>History</h1></div>
      <p class="muted small lead">Every change to “${esc(data.course.name)}”: imports, question edits (tap one to see what changed), course details, publishing and study settings. ${h.total} in all.</p>
      <div class="history-groups"></div>
      <div class="actions-row"><button class="btn ghost" data-act="more" hidden>Show older changes</button></div>
    </div>`;
  draw();
  $('[data-act="more"]', app).addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    try {
      const next = await api('GET', `/api/courses/${enc(id)}/history?limit=100&offset=${entries.length}`);
      if (seq !== routeSeq) return;
      entries.push(...next.entries);
      draw();
    } catch (err) { toast(err.message, 'error'); }
    ev.target.disabled = false;
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
  app.innerHTML = `${topbar(`<a href="#/c/${enc(id)}">${esc(course.name)}</a> › Statistics`)}
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
        ${exams.length ? `${examSpark(progress.exams)}<table class="type-table"><thead><tr><th>When</th><th>Score</th><th>Correct</th><th>Time</th><th></th></tr></thead><tbody>
        ${exams.map((e) => `<tr><td>${esc(new Date(e.at).toLocaleString())}</td><td><b>${e.score}</b>/${e.maxScore} <span class="muted">(${pct(e.score, e.maxScore)}%)</span></td><td>${e.correct}/${e.total}</td><td>${fmtDuration(e.durationSec)}</td><td>${e.reviewable ? `<button type="button" class="link-btn" data-review="${e.id}">Review</button>` : ''}</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted">No mock exams yet.</p>'}
      </section>
      <section class="card"><h3>Most missed</h3>
        ${worst.length ? `<ol class="worst">${worst.map((q) => `<li><span class="badge type">${esc(TYPE_LABELS[q.type])}</span> ${mdInline(q.stem.split('\n')[0].slice(0, 120))} <span class="warn-text">✗${prog[q.id].wrong}</span> <span class="muted">✓${prog[q.id].correct}</span></li>`).join('')}</ol>
        <button class="btn primary" data-act="drill">Practice these ${worst.length}</button>` : '<p class="muted">Nothing missed yet.</p>'}
      </section>
      <section class="card danger-zone"><h3>Reset</h3><p class="muted">Clears your attempts, stars, notes and exam history for this course. Questions are kept.</p><button class="btn danger" data-act="reset">Reset progress</button></section>
    </div>`;
  $$('[data-review]', app).forEach((b) => b.addEventListener('click', () => openExamReview(id, Number(b.dataset.review))));
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
  app.innerHTML = `${topbar(`<a href="#/">My courses</a> › Import`)}
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
    <div class="no-print actions-row"><a class="btn ghost" href="#/settings/c/${enc(id)}">‹ Back</a><button class="btn primary" onclick="window.print()">🖨 Print</button></div>
    <h1>${esc(course.name)}</h1>
    ${body}
    <section class="paper-key"><h2>Answer key</h2><ol>${numbered.map(([i, q]) => `<li value="${i}">${isOpen(q.type) ? md(q.answer) : mdInline(answerText(q))}</li>`).join('')}</ol></section>
  </div>`;
}

startNav(route);
