#!/usr/bin/env node
// README screenshots, taken from sample data (never your own): node scripts/screenshots.mjs [outDir]
// Starts its own server on a temp data dir with the demo course and a second user's course, then photographs the
// main pages at phone and desktop sizes into docs/screenshots/ (uses /usr/bin/google-chrome when installed).
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'docs/screenshots'));
fs.mkdirSync(out, { recursive: true });
process.env.EXAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-shots-data-'));
const importer = path.join(root, 'scripts/import.mjs');
execFileSync('node', [importer, '--course', 'Calculus & Physics', path.join(root, 'examples/demo-course.md')], { env: process.env, stdio: 'ignore' });

const store = await import('../lib/store.mjs');
const { createServer } = await import('../server.mjs');
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// you: the admin, owner of the demo course; mei: someone else, with a course of her own
const me = store.createUser({ username: 'alex', password: 'secret1' });
const mei = store.createUser({ username: 'mei', password: 'secret1' });
const demo = store.listCourses(me.id)[0].id;
store.updateCourse(demo, {
  visibility: 'public', examDate: new Date(Date.now() + 23 * 86400000).toISOString().slice(0, 10),
  description: 'Limits, derivatives and mechanics — every question type\n\nSixteen questions in two chapters: single and multiple choice, true/false, fill in the blank, calculations with units, and short answers. Math is written in LaTeX; one question has a figure.',
});
execFileSync('node', [importer, '--course', '线性代数 Linear Algebra', '--owner', 'mei', path.join(root, 'tests/fixtures-sample.md')], { env: process.env, stdio: 'ignore' });
const linalg = store.listCourses(mei.id).find((c) => c.owner?.username === 'mei').id;
store.updateCourse(linalg, {
  visibility: 'public',
  description: '矩阵、向量空间与积分 — bilingual sample paper\n\nA short paper in Chinese and English: one question of each kind, sorted into chapters by its headings (一、单项选择题 …).',
});

const token = store.createLogin(me.id);
const visitorToken = store.createLogin(store.createUser({ username: 'sam', password: 'secret1' }).id); // an ordinary user's view
const call = (method, url, body) => fetch(base + url, { method, headers: { cookie: `ea_sid=${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());

// some history, so Statistics has something to show
const { course } = await call('GET', `/api/courses/${encodeURIComponent(demo)}`);
for (const [i, q] of course.questions.entries()) {
  for (let k = 0; k < 1 + (i % 3); k++) await call('POST', `/api/courses/${encodeURIComponent(demo)}/attempt`, { qid: q.id, correct: (i + k) % 4 !== 0, type: q.type });
}
for (const [i, score] of [52, 61, 70, 78].entries()) {
  await call('POST', `/api/courses/${encodeURIComponent(demo)}/exam`, { title: 'Mock exam', total: 6, correct: 3 + i, score, maxScore: 100, durationSec: 1500 - i * 60 });
}
const exam = { perType: { single: 3, judge: 2, calc: 1 }, points: { single: 15, judge: 10, calc: 25 }, timeMin: 30 };
await call('PUT', `/api/courses/${encodeURIComponent(demo)}/settings`, { practice: { types: ['single'] }, exam });

const browser = await chromium.launch(fs.existsSync('/usr/bin/google-chrome') && !process.env.PW_BUNDLED ? { executablePath: '/usr/bin/google-chrome' } : {});
async function open(viewport, { as = token, ...opts } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, ...opts });
  await ctx.addCookies([{ name: 'ea_sid', value: as, url: base }]);
  return ctx.newPage();
}
const settle = (page) => page.waitForTimeout(500); // fonts, KaTeX and the background refresh
const shot = async (page, name, sel) => {
  if (sel) await page.waitForSelector(sel);
  await settle(page);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log(`  ${name}.png`);
};
const go = async (page, hash, sel) => { await page.goto(`${base}/#${hash}`); await page.waitForSelector(sel); };

try {
  const phone = await open({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  const desk = await open({ width: 1280, height: 800 });

  // desktop: Public, a public course page, Statistics
  await go(desk, '/public', '.public-tiles .course-tile');
  await shot(desk, 'desktop-public');
  const visitor = await open({ width: 1280, height: 800 }, { as: visitorToken });
  await go(visitor, `/p/${encodeURIComponent(linalg)}`, '.fork-cta');
  await shot(visitor, 'desktop-public-course');
  await go(desk, '/', '.course-tile'); // so Statistics sits under My courses
  await go(desk, `/c/${encodeURIComponent(demo)}/stats`, '.overview');
  await shot(desk, 'desktop-statistics');

  // phone: My courses → course → a practice question with feedback, a calculation
  await go(phone, '/', '.course-tile');
  await phone.tap('.course-tile');
  await shot(phone, 'phone-course', '.mtile');
  await phone.tap('[data-start="practice"]');
  await phone.waitForSelector('.qcard .opt');
  await phone.tap('.qcard .opt');
  await shot(phone, 'phone-practice', '.verdict:not(.pending)');
  await call('PUT', `/api/courses/${encodeURIComponent(demo)}/settings`, { practice: { types: ['calc'] }, exam }); // settings are saved whole
  await call('DELETE', `/api/courses/${encodeURIComponent(demo)}/sessions/practice`);
  await go(phone, `/c/${encodeURIComponent(demo)}`, '[data-start="practice"]');
  await phone.tap('[data-start="practice"]');
  await phone.waitForSelector('.calc-row input');
  await phone.fill('.calc-row input', '2*sqrt(2)');
  await shot(phone, 'phone-calculation', '.calc-preview');

  // a mock exam under way (desktop), then the In progress list and Settings on the phone
  await go(desk, `/c/${encodeURIComponent(demo)}`, '[data-start="exam"]');
  await desk.click('[data-start="exam"]');
  await desk.waitForSelector('.qcard');
  await desk.click('.qcard .opt, .qcard .judge-btn');
  await shot(desk, 'desktop-mock-exam');
  await go(phone, '/progress', '.round');
  await shot(phone, 'phone-in-progress');
  await go(phone, '/settings', '.signin-list');
  await shot(phone, 'phone-settings');

  // dark mode
  const dark = await open({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await go(dark, '/public', '.public-tiles .course-tile');
  await shot(dark, 'phone-public-dark');
} finally {
  await browser.close();
  server.close();
  fs.rmSync(process.env.EXAM_DATA_DIR, { recursive: true, force: true });
}
console.log(`screenshots: ${out}`);
