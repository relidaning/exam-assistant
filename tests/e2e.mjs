// End-to-end smoke test in a real browser. Starts its own server on a temp data dir.
//   node tests/e2e.mjs [screenshotDir]
// Practice is shuffled, so the test reads the current question from the session and answers it from the bank.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'exam-shots-'));
fs.mkdirSync(shots, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-data-'));
process.env.EXAM_DATA_DIR = dataDir;
Object.assign(process.env, { GOOGLE_CLIENT_ID: 'e2e', GOOGLE_CLIENT_SECRET: 'e2e', GITHUB_CLIENT_ID: 'e2e', GITHUB_CLIENT_SECRET: 'e2e' }); // shows the buttons
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
execFileSync('node', [path.join(root, 'scripts/import.mjs'), '--course', 'Demo', path.join(root, 'examples/demo-course.md')], { env: process.env, stdio: 'ignore' });
const { createServer } = await import('../server.mjs');
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const otherBase = base.replace('127.0.0.1', 'localhost');
// the first account takes over the imported demo course; the browser pages get its sign-in cookie
const reg = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: 'secret1' }) });
const token = reg.headers.get('set-cookie').match(/ea_sid=([^;]+)/)[1];
const authed = (url, opts = {}) => fetch(url, { ...opts, headers: { ...opts.headers, cookie: `ea_sid=${token}` } });
await authed(`${base}/api/courses/demo`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visibility: 'public' }) });
const bank = Object.fromEntries((await (await authed(`${base}/api/courses/demo`)).json()).course.questions.map((q) => [q.id, q]));
const putSettings = (s) => authed(`${base}/api/courses/demo/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) });

// prefer an installed Chrome so no browser download is needed
const browser = await chromium.launch(fs.existsSync('/usr/bin/google-chrome') && !process.env.PW_BUNDLED ? { executablePath: '/usr/bin/google-chrome' } : {});
const errors = [];
let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.log(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`); };
const LET = 'ABCDEFGHIJKL';

async function newPage(viewport, { signedOut, ...opts } = {}) {
  const ctx = await browser.newContext({ viewport, ...opts });
  if (!signedOut) await ctx.addCookies([base, otherBase].map((url) => ({ name: 'ea_sid', value: token, url })));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message} @ ${(e.stack || '').split('\n').slice(1, 4).join(' | ')}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
  return page;
}

/** Discard a round from inside the page (cancels its pending saves too) and wait until the server has dropped it. */
async function clearRound(page, slot) {
  await page.evaluate(async (sl) => { const d = await import('/js/data.js'); d.sessions.clear('demo', sl); await d.flushSessions('demo'); }, slot);
}

async function currentQuestion(page) {
  const qid = await page.evaluate(async () => {
    const slot = location.hash.split('/')[4]; // #/c/demo/run/<slot>
    const s = (await import('/js/data.js')).sessions.get('demo', slot); // the page's live copy of the round
    return s.qids[s.idx];
  });
  if (!bank[qid]) { // re-parsed questions get new ids: refresh the local copy of the bank
    for (const q of (await (await authed(`${base}/api/courses/demo`)).json()).course.questions) bank[q.id] = q;
  }
  return bank[qid];
}

/** Answer the visible question; right=false gives a wrong answer. Leaves the page with feedback shown (practice). */
async function answer(page, q, right = true) {
  if (q.type === 'single') await page.click(`.opt[data-key="${LET[right ? q.answer : (q.answer + 1) % q.options.length]}"]`);
  else if (q.type === 'multi') {
    for (const i of right ? q.answer : [q.answer[0]]) await page.click(`.opt[data-key="${LET[i]}"]`);
    await page.click('[data-act="main"]');
  } else if (q.type === 'judge') await page.click(`.judge-btn[data-key="${(right ? q.answer : !q.answer) ? 'T' : 'F'}"]`);
  else if (q.type === 'fill') {
    const inputs = await page.$$('.blank-input');
    for (const [i, el] of inputs.entries()) await el.fill(right ? q.answer[i][0] : 'zzz');
    await page.click('[data-act="main"]');
  } else if (q.type === 'calc') {
    const inputs = await page.$$('.calc-row input');
    for (const [i, el] of inputs.entries()) await el.fill(String(right || i > 0 ? q.answer[i].value : q.answer[i].value * 3));
    await page.click('[data-act="main"]');
  } else if (q.type === 'short') {
    await page.fill('.short-input', (q.keywords || ['answer']).join(' '));
    await page.click('[data-act="main"]');
    await page.waitForSelector('.selfgrade');
    const count = await page.textContent('.run-count');
    const last = /^(\d+) \/ \1$/.test(count.trim());
    await page.click(`.selfgrade [data-keys~="${right ? 'Y' : 'N'}"]`);
    if (!last) { // grading moves on to the next question by itself
      await page.waitForFunction((c) => document.querySelector('.run-count').textContent !== c, count);
      return 'advanced';
    }
  }
  await page.waitForSelector('.verdict:not(.pending)');
}

try {
  // ---------- desktop ----------
  console.log('desktop');
  const page = await newPage({ width: 1280, height: 860 });
  await page.goto(base);
  await page.waitForSelector('.course-tile');
  check((await page.textContent('.ct-name')).includes('Demo'), 'the Public tab lists the published course');
  check(await page.$('.search-bar .course-search') && (await page.getAttribute('.tabbar [aria-current="page"]', 'href')) === '#/', 'a search bar on top, the Public tab is current');
  const side = await page.evaluate(() => { const t = document.querySelector('.tabbar').getBoundingClientRect(), p = document.querySelector('.page').getBoundingClientRect(); return [t.left, t.top, t.height, t.right, p.left, getComputedStyle(document.querySelector('.tabbar')).flexDirection, innerHeight]; });
  check(side[0] === 0 && side[1] === 0 && side[2] === side[6] && side[5] === 'column' && side[4] >= side[3], `on a laptop the tabs are a sidebar on the left, beside the page (${side})`);
  await page.fill('.course-search', 'no such course');
  check(await page.isHidden('.public-tiles .course-tile') && await page.isVisible('.no-match'), 'search filters the public courses');
  check(await page.isVisible('[data-act="clear-search"]'), 'a clear button shows while there is text');
  await page.click('[data-act="clear-search"]');
  check((await page.inputValue('.course-search')) === '' && await page.isVisible('.public-tiles .course-tile') && await page.isHidden('[data-act="clear-search"]'), 'clearing empties the search and brings every course back');
  await page.fill('.course-search', 'demo');
  check(await page.isVisible('.public-tiles .course-tile'), 'and finds them by name');
  await page.screenshot({ path: `${shots}/01-home.png` });
  await page.click('.public-tiles .course-tile');
  await page.waitForSelector('.course-meta');
  check(new URL(page.url()).hash === '#/p/demo' && !(await page.$('[data-start], .mtile')), 'from Public, even your own course opens its public page: no practice, exams or statistics');
  check((await page.textContent('.resume')).includes('This is your course') && (await page.textContent('.about')).includes('No description yet'), 'it points to My courses and invites a description');
  await authed(`${base}/api/courses/demo`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'Sample bank\n\nCovers **limits** and mechanics.' }) });
  await page.reload();
  await page.waitForSelector('.about .prose strong');
  check((await page.textContent('.hero-text p.muted')).trim() === 'Sample bank' && (await page.textContent('.about')).includes('Covers limits and mechanics'), 'first line of the description is the summary, the rest the About text');
  await page.screenshot({ path: `${shots}/01b-own-public-page.png`, fullPage: true });
  await page.goBack();
  await page.waitForSelector('.public-tiles');
  await page.click('.tabbar a[href="#/courses"]');
  await page.waitForSelector('.course-tile');
  check((await page.textContent('h1')).includes('My courses') && (await page.textContent('.ct-name')).includes('Demo'), 'My courses lists your own course');
  await page.click('a.course-tile');
  await page.waitForSelector('.mtile');
  check(!(await page.$('text=Memorize')), 'no memorize module');
  check(!(await page.$('text=By chapter')), 'chapters are not on the hub');
  check(!(await page.$('[data-act="visibility"]')), 'no Publish / Make private on the My courses page, even for the admin');
  check(!(await page.$('[data-act="fork"]')) && (await page.textContent('.status-chip')).includes('In Public'), 'your own course shows its status (In Public), not a Fork button');
  check(!(await page.$('.mtile[data-mod="questions"]')) && !(await page.$('.mtile[data-mod="settings"]')) && (await page.$$('.tools-row .mtile')).length === 1, 'the hub has the four modules and Statistics (settings moved to the Settings tab)');
  check(await page.$('.mtile.unset[data-mod="exam"]'), 'exam panel marked "not set up"');
  await page.screenshot({ path: `${shots}/02-course.png`, fullPage: true });

  // settings: exam composition + chapter filter preview
  await page.click('.mtile[data-mod="exam"]'); // goes to settings#exam
  await page.waitForSelector('form.settings');
  await page.fill('input[name="exam-n-single"]', '2');
  await page.fill('input[name="exam-n-judge"]', '2');
  await page.fill('input[name="exam-n-calc"]', '1');
  await page.fill('input[name="exam-time"]', '30');
  check((await page.textContent('.exam-total')).includes('5 questions'), 'settings preview: exam total');
  await page.click('.chapter-row:first-child input');
  check((await page.textContent('[data-match="practice"]')).includes('10'), 'chapter filter narrows practice to 10');
  await page.click('[data-chapters="none"]');
  await page.screenshot({ path: `${shots}/03-settings.png`, fullPage: true });
  await page.click('form.settings button[type="submit"]');
  await page.waitForSelector('.mtile[data-mod="exam"]:not(.unset)');
  const examText = await page.textContent('.mtile[data-mod="exam"]');
  check(examText.includes('5 q') && examText.includes('30 min'), 'exam tile shows question count and duration');
  await page.screenshot({ path: `${shots}/04-course-exam-set.png` });

  // practice: every question, a few answered wrongly on purpose
  await page.click('[data-start="practice"]');
  await page.waitForSelector('.qcard');
  check((await page.textContent('.run-count')).endsWith('/ 16'), 'practice has all 16 questions');
  const wrongTypes = new Set(['single', 'fill', 'calc', 'judge']);
  let sawMath = false, sawImage = false;
  let autoNext = false;
  for (let n = 0; n < 16; n++) {
    const q = await currentQuestion(page);
    const right = !wrongTypes.delete(q.type);
    if (n === 0) {
      const g = await page.getAttribute('.run-actions .verify', 'href');
      const query = new URL(g).searchParams.get('q');
      check(g.startsWith('https://www.google.com/search?q=') && query.length > 5 && !query.includes('$') && !query.includes('{{'), `Verify searches the question on Google ("${query.slice(0, 40)}…")`);
      check((await page.getAttribute('.run-actions .verify', 'target')) === '_blank', 'Verify opens in a new tab');
      check((await page.textContent('.run-actions .verify')).trim() === 'Verify', 'button is labelled Verify');
    }
    sawMath ||= (await page.$$('.katex')).length > 0;
    if (await page.$('.stem img[src^="/media/"]')) {
      sawImage = await page.waitForFunction(() => { const img = document.querySelector('.stem img'); return img.complete && img.naturalWidth > 0; }, null, { timeout: 5000 }).then(() => true, () => false);
    }
    if (q.type === 'calc') {
      await page.fill('.calc-row input', '4/2');
      if (!(await page.textContent('.calc-preview')).includes('= 2')) check(false, 'calc preview evaluates expression');
    }
    if (await answer(page, q, right) === 'advanced') { autoNext = true; continue; }
    const verdict = await page.getAttribute('.verdict', 'class');
    const expected = right ? 'right' : (q.type === 'calc' && q.answer.length > 1 ? 'partial' : 'wrong');
    if (!verdict.includes(expected)) check(false, `${q.type} answered ${right ? 'right' : 'wrong'} → ${verdict}`);
    if (q.type === 'single' && !right) check(await page.$(`.opt.correct[data-key="${LET[q.answer]}"]`), 'wrong single highlights the correct option');
    if (q.type === 'fill' && !right) check(await page.$('.blank-key'), 'wrong blank shows accepted answer');
    if (q.type === 'short' && q.keywords) check((await page.$$('.keywords .chip.hit')).length === q.keywords.length, 'short answer highlights keyword hits');
    if (n === 4) await page.screenshot({ path: `${shots}/05-practice.png` });
    await page.click('[data-act="main"]'); // next / finish
  }
  check(autoNext, 'self-grading a short answer moves on to the next question');
  check(sawMath, 'math rendered with KaTeX');
  check(sawImage, 'embedded Obsidian image loads from /media');
  await page.waitForSelector('.result-card');
  check((await page.textContent('.score-big')).includes('%'), 'practice result page');
  await page.screenshot({ path: `${shots}/06-result.png`, fullPage: true });

  // re-parse: edit the current question's source text and save it
  console.log('re-parse');
  await page.goto(`${base}/#/c/demo`);
  await page.waitForSelector('[data-start="practice"]');
  const savedSettings = (await (await authed(`${base}/api/courses/demo`)).json()).progress.settings;
  await putSettings({ ...savedSettings, practice: { types: ['single'] } });
  await page.reload();
  await page.click('[data-start="practice"]');
  await page.waitForSelector('dialog.dialog, .qcard');
  if (await page.$('dialog.dialog')) await page.click('dialog.dialog .btn.primary');
  await page.waitForSelector('.qcard');
  const before = await currentQuestion(page);
  check(await page.isVisible('.q-tools [data-act="reparse"]') && await page.isVisible('.q-tools [data-act="star"]'), 'star and re-parse sit under the question');
  await page.keyboard.press('s');
  await page.waitForSelector('.q-tools [data-act="star"].on');
  check((await page.$('.nav-cell.current.starred i')) !== null, 'S stars the question and the list shows a star badge');
  await page.keyboard.press('s');
  await page.waitForSelector('.q-tools [data-act="star"]:not(.on)');
  await page.keyboard.press('p');
  await page.waitForSelector('dialog.reparse .reparse-result');
  const rawText = await page.inputValue('.reparse-text');
  check(rawText.length > 10 && /Answer|答案/.test(rawText), 'dialog shows the question\'s source text');
  await page.fill('.reparse-text', rawText.replace(/^(\d+\.\s*)?/, '$1(edited) '));
  await page.waitForFunction(() => document.querySelector('.reparse-result')?.textContent.includes('(edited)'));
  check(true, 'preview follows the edit');
  await page.click('dialog.reparse [data-act="save"]');
  await page.waitForSelector('dialog.reparse', { state: 'detached' });
  await page.waitForFunction(() => document.querySelector('.qcard .stem')?.textContent.includes('(edited)'));
  const after = await currentQuestion(page);
  check(after === undefined || after.id !== before.id, 'question saved with a new id (the bank fixture is not refreshed)');
  const live = (await (await authed(`${base}/api/courses/demo`)).json()).course.questions;
  check(live.length === 16 && live.some((q) => q.stem.includes('(edited)')) && !live.some((q) => q.id === before.id), 're-parsed question replaced in place');
  await putSettings(savedSettings);

  // mistakes
  await page.goto(`${base}/#/c/demo`);
  await page.waitForSelector('.mtile');
  check(parseInt(await page.textContent('[data-mod="mistakes"] .mtile-info'), 10) >= 4, 'mistakes book filled');
  await page.click('[data-start="mistakes"]');
  await page.waitForSelector('.qcard');
  check((await page.textContent('.run-module')).includes('Mistakes'), 'mistakes session starts');

  // sessions are saved per module: an unfinished Mistakes session survives starting a mock exam
  console.log('separate sessions');
  const mq = await currentQuestion(page);
  await answer(page, mq, true);
  await page.goBack();
  await page.waitForSelector('.mtile');
  check((await page.textContent('[data-mod="mistakes"] .mtile-info')).startsWith('In progress · 1/'), 'Mistakes tile shows its unfinished session');
  await page.click('[data-start="exam"]');
  await page.waitForSelector('dialog.dialog, .qcard');
  check(!(await page.$('dialog.dialog')), 'starting a mock exam does not ask to replace the Mistakes session');
  await page.waitForSelector('.qcard');
  await page.goBack();
  await page.waitForSelector('.mtile');
  check((await page.textContent('[data-mod="mistakes"] .mtile-info')).startsWith('In progress'), 'Mistakes session still there after the exam started');
  await page.click('[data-start="mistakes"]');
  await page.waitForSelector('dialog.dialog');
  check((await page.textContent('dialog.dialog h3')).includes('Mistakes in progress'), 'tapping it offers to resume');
  await page.click('dialog.dialog .btn.primary'); // Resume
  await page.waitForSelector('.qcard .feedback');
  check((await currentQuestion(page)).id === mq.id, 'resumes on the same question, answer kept');
  await clearRound(page, 'exam'); // the exam below starts fresh

  // Back always goes to the parent page, not to the previous one
  console.log('navigation');
  await page.click('[data-act="exit"]');
  await page.click('dialog.dialog .btn.primary');
  await page.waitForSelector('.mtile');
  await page.click('.tabbar a[href="#/courses"]');
  await page.waitForSelector('.course-tile');
  await page.click('a.course-tile');
  await page.waitForSelector('.mtile');
  await page.goBack();
  await page.waitForSelector('.course-tile');
  check(true, 'back from a course goes to the course list');
  await page.click('a.course-tile');
  await page.waitForSelector('.mtile');
  await page.click('[data-start="practice"]');
  await page.waitForSelector('dialog.dialog, .qcard');
  if (await page.$('dialog.dialog')) await page.click('dialog.dialog .btn.primary');
  await page.waitForSelector('.qcard');
  // record every painted frame while going back, with a slow server, to catch a flash of the old page
  await page.route('**/api/courses/**', async (r) => { await new Promise((ok) => setTimeout(ok, 400)); await r.continue().catch(() => {}); }); // a save still delayed at unroute is let through
  await page.evaluate(() => {
    window.__frames = [];
    const tick = () => { window.__frames.push([location.hash, !!document.querySelector('.qcard'), !!document.querySelector('.mtile')]); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.goBack();
  await page.waitForSelector('.mtile');
  await page.waitForTimeout(700); // let the background refresh land
  const frames = await page.evaluate(() => window.__frames);
  await page.unroute('**/api/courses/**');
  const afterBack = frames.filter(([h]) => h === '#/c/demo');
  check(afterBack.length > 0 && afterBack.every(([, run, hub]) => !run && hub), `no flash when going back (${afterBack.length} frames, all show the course page)`);
  check(new URL(page.url()).hash === '#/c/demo', 'back from practice goes to the course page');
  await page.goBack();
  await page.waitForSelector('.course-tile');
  check(new URL(page.url()).hash === '#/courses', 'then back again goes to the course list it was opened from');
  const deep = await newPage({ width: 1000, height: 700 });
  await deep.goto(`${base}/#/c/demo/stats`);
  await deep.waitForSelector('.overview');
  await deep.goBack();
  await deep.waitForSelector('.mtile');
  check(new URL(deep.url()).hash === '#/c/demo', 'a deep link still has its parent behind it');

  // mock exam
  console.log('mock exam');
  await page.goto(`${base}/#/c/demo`);
  await page.waitForSelector('.mtile');
  await page.click('[data-start="exam"]');
  await page.waitForSelector('dialog.dialog, .qcard');
  if (await page.$('dialog.dialog')) await page.click('dialog.dialog .btn.primary');
  await page.waitForSelector('.qcard');
  check((await page.textContent('.run-count')).endsWith('/ 5'), 'exam uses the configured composition');
  check(await page.isVisible('.timer:not(.subtle)'), 'exam shows countdown timer');
  await page.screenshot({ path: `${shots}/07-exam.png` });
  await page.click('.judge-btn[data-key="T"]');
  check(!(await page.$('.feedback')), 'no feedback during exam');
  check(!(await page.isVisible('.run-actions .verify')), 'no Verify button while answering a mock exam');
  check(!(await page.isVisible('[data-act="reparse"]')), 'no re-parse button while answering a mock exam');
  const cells = await page.$$('.nav-grid .nav-cell');
  await cells[cells.length - 1].click();
  await page.click('[data-act="main"]');
  await page.click('dialog.dialog .btn.primary');
  await page.waitForSelector('.result-card');
  check((await page.textContent('.score-big')).includes('/'), 'exam result shows score / max');

  // stats & import (in Settings)
  await page.goto(`${base}/#/c/demo/stats`);
  await page.waitForSelector('.type-table');
  await page.screenshot({ path: `${shots}/08-stats.png`, fullPage: true });
  await page.goto(`${base}/#/c/demo/settings#import`);
  await page.waitForSelector('#import .import-text');
  await page.fill('.import-text', '1. 2+2=?\nA. 3\nB. 4\n答案：B\n\n2. 水的化学式是 ____。\n答案：H2O');
  await page.click('[data-act="preview"]');
  await page.waitForSelector('.preview');
  check((await page.textContent('.preview')).includes('2 questions'), 'import preview parses pasted text');
  await page.click('[data-act="import"]');
  await page.waitForSelector('.import-report');
  check((await page.textContent('.import-report')).includes('+2'), 'pasted questions imported');

  // past papers: newest first, sat exactly as set, with what was done on each
  console.log('past papers');
  const paper = (src, n) => Array.from({ length: n }, (_, i) => ({ stem: `${src} question ${i + 1}?`, options: ['yes', 'no'], answer: 'A', tags: ['past-paper'], source: src }));
  const [oldP, newP] = ['15040 2024年4月真题', '15040 2025年4月真题']; // imported oldest first
  await authed(`${base}/api/courses/demo/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: JSON.stringify([...paper(oldP, 3), ...paper(newP, 2)]) }) });
  const st0 = (await (await authed(`${base}/api/courses/demo`)).json()).progress.settings;
  await putSettings({ ...st0, exam: { perType: { single: 2 }, points: { single: 2 }, timeMin: 30, tag: 'past-paper' } });
  await page.goto(`${base}/#/c/demo`);
  await page.waitForSelector('.mtile');
  await page.click('[data-start="exam"]');
  await page.waitForSelector('dialog.dialog .paper-list');
  const options = await page.$$eval('.paper-opt b', (bs) => bs.map((b) => b.textContent));
  check(JSON.stringify(options) === JSON.stringify(['2025年4月真题', '2024年4月真题']), `paper picker lists the papers newest first, no random mix (${options.join(', ')})`);
  check((await page.$$eval('.paper-done.todo', (xs) => xs.length)) === 2, 'papers not sat yet say so');
  await page.click('.paper-opt:nth-child(2)');
  await page.click('dialog.dialog .btn.primary');
  await page.waitForSelector('.qcard');
  check((await page.textContent('.run-count')).endsWith('/ 3') && (await page.textContent('.run-module')).includes(oldP), 'chosen paper is sat as set (3 questions, named after the paper)');
  check((await page.textContent('.stem')).includes(`${oldP} question 1`), 'questions keep the paper\'s order');
  await clearRound(page, 'exam');
  await authed(`${base}/api/courses/demo/exam`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: newP, total: 2, score: 2, maxScore: 4, correct: 1, durationSec: 95, byType: {} }) });
  await page.goto(`${base}/#/c/demo`);
  await page.waitForSelector('.mtile');
  await page.click('[data-start="exam"]');
  await page.waitForSelector('dialog.dialog .paper-list');
  const doneText = await page.textContent('.paper-opt:nth-child(1) .paper-done');
  check(doneText.includes('Done') && doneText.includes('50%') && doneText.includes('1/2 right') && doneText.includes('1:35'), `a paper already sat shows its result (${doneText.replace(/\s+/g, ' ').trim()})`);
  check(await page.isChecked('.paper-opt:nth-child(2) input'), 'the newest paper not sat yet is preselected');
  await page.click('dialog.dialog .btn:not(.primary)');

  // practice: Ctrl+Enter with nothing entered shows the answer (counted as wrong)
  console.log('reveal');
  await putSettings({ practice: { types: ['fill'] } });
  await clearRound(page, 'practice');
  await page.goto(`${base}/#/c/demo`);
  await page.waitForSelector('.mtile');
  await page.click('[data-start="practice"]');
  await page.waitForSelector('.qcard .blank-input');
  await page.focus('.blank-input');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.blank-key');
  check((await page.textContent('[data-act="main"]')).includes('Next') && (await page.$('.nav-cell.current.wrong')) !== null, 'Ctrl+Enter on a blank fill-in shows the answer and marks it wrong');
  await page.keyboard.press('Control+Enter');
  check((await page.textContent('.run-count')).startsWith('2'), 'Ctrl+Enter again moves to the next question');
  await clearRound(page, 'practice');

  // practice: a revealed short answer must be self-graded before moving on
  await putSettings({ practice: { types: ['short'] } });
  await clearRound(page, 'practice');
  await page.goto(`${base}/#/c/demo`);
  await page.waitForSelector('.mtile');
  await page.click('[data-start="practice"]');
  await page.waitForSelector('.qcard .short-input');
  await page.focus('.short-input');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.selfgrade');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check((await page.textContent('.run-count')).startsWith('1') && (await page.$('[data-act="main"][data-blocked]')) !== null, 'Next is held until the revealed answer is graded');
  await page.keyboard.press('n');
  await page.waitForFunction(() => document.querySelector('.run-count').textContent.startsWith('2'));
  check(true, 'grading moves on to the next question');
  await clearRound(page, 'practice');

  // practice clock: time away from the round doesn't count
  console.log('clock pauses');
  await putSettings({ practice: { types: ['single'] } });
  await clearRound(page, 'practice');
  await page.goto(`${base}/#/c/demo`);
  await page.waitForSelector('.mtile');
  await page.click('[data-start="practice"]');
  await page.waitForSelector('.qcard .options');
  await page.waitForTimeout(2200);
  await page.keyboard.press('a'); // answering saves the time so far
  await page.waitForSelector('[data-act="main"]:text("Next")');
  await page.click('[data-act="exit"]');
  await page.click('dialog.dialog .btn.primary');
  await page.waitForSelector('.mtile');
  await page.waitForTimeout(3000);
  await page.goto(`${base}/#/c/demo/run/practice`);
  await page.waitForSelector('.qcard');
  const secs = (await page.textContent('.timer')).split(':').reduce((a, b) => a * 60 + Number(b), 0);
  check(secs >= 2 && secs < 4, `the practice clock stops while the round is left (${secs}s after 2s in, 3s away)`);
  await clearRound(page, 'practice');

  // the round in progress is on the server: another address (another origin, own localStorage) opens the same round
  console.log('shared rounds');
  await putSettings({ practice: { types: ['single'] } });
  await clearRound(page, 'practice');
  await page.goto(`${base}/#/c/demo`);
  await page.waitForSelector('.mtile');
  await page.click('[data-start="practice"]');
  await page.waitForSelector('.qcard .options');
  await page.keyboard.press('a');
  await page.waitForSelector('[data-act="main"]:text("Next")');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.run-count').textContent.startsWith('2'));
  const firstHere = await currentQuestion(page);
  await page.evaluate(async () => (await import('/js/data.js')).flushSessions('demo'));
  const other = await newPage({ width: 1000, height: 700 });
  await other.goto(`${otherBase}/#/c/demo`);
  await other.waitForSelector('.mtile.resumable[data-mod="practice"], [data-mod="practice"].resumable');
  check(true, 'the other address shows the practice round as unfinished');
  await other.goto(`${otherBase}/#/c/demo/run/practice`);
  await other.waitForSelector('.qcard');
  check((await other.textContent('.run-count')).startsWith('2') && (await currentQuestion(other)).id === firstHere.id, 'the other address resumes on the same question');
  check((await other.$$eval('.nav-cell.right, .nav-cell.wrong', (x) => x.length)) === 1, 'and sees the answer given at the first address');
  await other.keyboard.press('a');
  await other.waitForSelector('[data-act="main"]:text("Next")');
  await other.keyboard.press('Enter');
  await other.waitForFunction(() => document.querySelector('.run-count').textContent.startsWith('3'));
  await other.evaluate(async () => (await import('/js/data.js')).flushSessions('demo'));
  await page.reload();
  await page.waitForSelector('.qcard');
  check((await page.textContent('.run-count')).startsWith('3'), 'and the first address picks up where the other left off');
  await other.close();

  // the In progress tab: every unfinished round, resumable and deletable
  console.log('in progress tab');
  await page.goto(`${base}/#/progress`);
  await page.waitForSelector('.round[data-slot="practice"]');
  const roundText = await page.textContent('.round[data-slot="practice"]');
  check(roundText.includes('Demo') && roundText.includes('2 of'), `the practice round is listed with its course and progress (${roundText.replace(/\s+/g, ' ').trim().slice(0, 60)})`);
  await page.screenshot({ path: `${shots}/09-in-progress.png` });
  await page.click('.round[data-slot="practice"] .round-main');
  await page.waitForSelector('.qcard');
  check((await page.textContent('.run-count')).startsWith('3'), 'tapping it resumes the round where it was left');
  await page.goBack();
  await page.goto(`${base}/#/progress`);
  await page.waitForSelector('.round[data-slot="practice"]');
  await page.click('.round[data-slot="practice"] [data-act="delete-round"]');
  await page.click('dialog.dialog .btn.danger');
  await page.waitForFunction(() => !document.querySelector('.round[data-slot="practice"]') && document.querySelector('.page h1'));
  const leftOver = (await (await authed(`${base}/api/sessions`)).json()).filter((r) => r.slot === 'practice');
  check(!leftOver.length, 'deleting it removes the round on the server');
  await clearRound(page, 'practice');

  // ---------- accounts: a second user signs up in the browser ----------
  console.log('accounts');
  const visitor = await newPage({ width: 1280, height: 860 }, { signedOut: true });
  await visitor.goto(`${base}/#/c/demo`);
  await visitor.waitForSelector('.login-card');
  check(visitor.url().includes('#/login?next='), 'signed out: the app asks you to sign in');
  check((await visitor.$$('.oauth-btn')).length === 2 && (await visitor.getAttribute('.oauth-btn', 'href')).startsWith('/api/auth/oauth/google/start?next='), 'Google and GitHub buttons, keeping where you were going');
  const toGoogle = await visitor.evaluate(async () => (await fetch('/api/auth/oauth/github/start?next=%2F', { redirect: 'manual' })).type);
  check(toGoogle === 'opaqueredirect', 'the button redirects to the provider');
  await visitor.screenshot({ path: `${shots}/40-login.png` });
  await visitor.click('[data-act="switch"]');
  await visitor.fill('input[name="username"]', 'visitor');
  await visitor.fill('input[name="password"]', 'secret1');
  await visitor.click('button[type="submit"]');
  await visitor.waitForSelector('.fork-cta');
  check(true, 'after signing up you land on the page you asked for');
  check(!(await visitor.$('[data-start]')) && await visitor.$('[data-act="fork"]') && !(await visitor.$('[data-act="visibility"]')), "someone else's public course shows its details and Fork; practising needs a fork");
  check((await visitor.textContent('.course-meta')).includes('by tester'), 'and names its owner');
  check((await visitor.textContent('.page')).includes("What's inside") && await visitor.$('.mix'), 'with what is in it');
  await visitor.screenshot({ path: `${shots}/44-public-course.png`, fullPage: true });
  await visitor.goto(`${base}/#/`);
  await visitor.waitForSelector('.public-tiles .course-tile');
  check((await visitor.textContent('.public-tiles')).includes('Demo'), 'the public course is listed under Public');
  await visitor.screenshot({ path: `${shots}/41-public-courses.png` });
  await visitor.goto(`${base}/#/c/demo/settings`);
  await visitor.waitForSelector('form.settings');
  check(new URL(visitor.url()).hash === '#/settings/c/demo', 'old course-settings links lead to the Settings tab');
  check(!(await visitor.$('form.course-form')) && !(await visitor.$('.danger-zone')) && !(await visitor.$('.import-text')), "no editing, importing or deleting someone else's course");
  await visitor.goto(`${base}/#/progress`);
  await visitor.waitForSelector('.card.empty');
  check(!(await visitor.$('.round')), "the owner's unfinished rounds are not shown to others");
  await visitor.goto(`${base}/#/`);
  await visitor.waitForSelector('.public-tiles .course-tile');
  await visitor.click('.public-tiles .course-tile');
  await visitor.waitForSelector('.fork-cta [data-act="fork"]');
  await visitor.click('.fork-cta [data-act="fork"]');
  await visitor.waitForSelector('dialog input[name="name"]');
  await visitor.click('dialog .btn.primary');
  await visitor.waitForFunction(() => /#\/c\/demo-visitor$/.test(location.hash) && document.querySelector('[data-start="practice"]'));
  check(!(await visitor.$('[data-act="visibility"]')), 'no Publish button for someone who is not an admin');
  check((await visitor.textContent('.status-chip.forked')).includes('Forked from') && !(await visitor.$('.hero [data-act="fork"]')) && await visitor.$('[data-start="practice"]'), 'forking opens your own copy, marked Forked (no Fork button), ready to practise');
  await visitor.screenshot({ path: `${shots}/42-fork.png` });
  await visitor.click('[data-start="practice"]');
  await visitor.waitForSelector('.qcard');
  check(await visitor.$('[data-act="reparse"]') && await visitor.$('[data-act="star"]'), 'your fork is yours: Re-parse and Star');
  await visitor.goBack();
  await visitor.waitForSelector('.mtile');
  await visitor.goBack();
  await visitor.waitForSelector('.course-tile');
  check(new URL(visitor.url()).hash === '#/courses', 'the fork sits under My courses');
  await visitor.goto(`${base}/#/c/demo`);
  await visitor.waitForSelector('[data-open-fork]');
  check(true, 'the original then points to your copy');
  const ownerList = await (await authed(`${base}/api/courses`)).json();
  check(!ownerList.some((c) => c.id === 'demo-visitor'), 'the fork stays private to its owner');
  await visitor.click('[data-act="account"]');
  await visitor.waitForSelector('.signin-list');
  check(new URL(visitor.url()).hash === '#/settings' && (await visitor.$$('.signin-list a.btn')).length === 2, 'account management is in the Settings tab: linking Google and GitHub');
  check((await visitor.textContent('#courses')).includes('Demo'), 'with the practice and mock exam settings of your courses');
  await visitor.screenshot({ path: `${shots}/43-account.png` });
  await visitor.close();

  // ---------- phone ----------
  console.log('phone');
  await putSettings({ practice: { types: ['calc'] } });
  const phone = await newPage({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const noOverflow = () => phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  await phone.goto(base);
  await phone.waitForSelector('.course-tile');
  await phone.screenshot({ path: `${shots}/20-phone-home.png` });
  check(await noOverflow(), 'no horizontal overflow on phone (courses)');
  const zoom = await phone.evaluate(() => ({
    meta: document.querySelector('meta[name="viewport"]').content,
    touch: getComputedStyle(document.documentElement).touchAction,
  }));
  check(/user-scalable=no/.test(zoom.meta) && /maximum-scale=1/.test(zoom.meta) && zoom.touch === 'pan-x pan-y', `page is not zoomable (${zoom.touch})`);
  await phone.goto(`${base}/#/c/demo`);
  await phone.waitForSelector('.mtile');
  await phone.screenshot({ path: `${shots}/21-phone-course.png`, fullPage: true });
  check(await noOverflow(), 'no horizontal overflow on phone (course)');
  await phone.goto(`${base}/#/c/demo/settings`);
  await phone.waitForSelector('form.settings');
  check(await noOverflow(), 'no horizontal overflow on phone (settings)');
  const foot = await phone.evaluate(() => [document.querySelector('.settings-foot').getBoundingClientRect().bottom, document.querySelector('.tabbar').getBoundingClientRect().top]);
  check(foot[0] <= foot[1] + 1, `the Save bar sits above the tab bar (${foot})`);
  // a round with a long title must not widen the In progress page
  const longRound = { courseId: 'demo', module: 'exam', slot: 'exam', title: `Mock exam ${'很长的试卷名称'.repeat(8)}`, qids: Object.keys(bank).slice(0, 3), idx: 0, entries: {}, startedAt: Date.now(), phase: 'answering' };
  await authed(`${base}/api/courses/demo/sessions/exam`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(longRound) });
  for (const [tab, sel, shot] of [['/progress', '.round[data-slot="exam"]', '23-phone-progress'], ['/settings', '.signin-list', '24-phone-settings'], ['/courses', '.course-tile', '25-phone-mine']]) {
    await phone.goto(`${base}/#${tab}`);
    await phone.waitForSelector(sel);
    const bar = await phone.evaluate(() => { const r = document.querySelector('.tabbar').getBoundingClientRect(); return [r.bottom, window.innerHeight, getComputedStyle(document.querySelector('.tabbar')).position]; });
    check(bar[2] === 'fixed' && Math.abs(bar[0] - bar[1]) < 2 && await noOverflow(), `phone: tab bar along the bottom, no overflow (${tab})`);
    await phone.screenshot({ path: `${shots}/${shot}.png` });
  }
  await phone.goto(`${base}/#/c/demo`);
  await phone.waitForSelector('.mtile');
  await phone.tap('[data-start="practice"]');
  await phone.waitForSelector('.calc-row');
  check((await phone.textContent('.run-count')).endsWith('/ 4'), 'practice honours the type setting');
  await phone.tap('[data-act="nav"]');
  await phone.waitForSelector('.navigator.open');
  await phone.tap('.nav-cell[data-go="1"]');
  await phone.tap('.calc-tools summary');
  const tiny = await phone.evaluate(() => [...document.querySelectorAll('input, textarea')].filter((el) => el.offsetParent && parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => el.className));
  check(!tiny.length, `answer inputs are >= 16px so iOS won't zoom on focus ${tiny.join(',')}`);
  await phone.screenshot({ path: `${shots}/22-phone-calc.png` });
  check(await noOverflow(), 'no horizontal overflow on phone (runner)');

  // dark mode
  const dark = await newPage({ width: 1280, height: 860 }, { colorScheme: 'dark' });
  await dark.goto(base);
  await dark.waitForSelector('.course-tile');
  await dark.screenshot({ path: `${shots}/30-dark-home.png` });
  await dark.goto(`${base}/#/c/demo`);
  await dark.waitForSelector('.mtile');
  await dark.screenshot({ path: `${shots}/31-dark-course.png` });
} catch (e) {
  failures++;
  console.error('E2E error:', e);
} finally {
  await browser.close();
  server.close();
}

for (const e of errors) console.log(`  ! ${e}`);
console.log(`\nscreenshots: ${shots}`);
console.log(failures || errors.length ? `FAILED (${failures} checks, ${errors.length} browser errors)` : 'ALL PASSED');
process.exit(failures || errors.length ? 1 : 0);
