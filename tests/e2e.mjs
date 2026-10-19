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
  check((await page.textContent('.ct-name')).includes('Demo'), 'course card shows the course');
  await page.screenshot({ path: `${shots}/01-home.png` });
  await page.click('a.course-tile');
  await page.waitForSelector('.mtile');
  check(!(await page.$('text=Memorize')), 'no memorize module');
  check(!(await page.$('text=By chapter')), 'chapters are not on the hub');
  check(!(await page.$('.mtile[data-mod="questions"]')) && (await page.$$('.tools-row .mtile')).length === 2, 'no Questions tile; Statistics and Settings remain');
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
  await page.click('.topbar .crumbs a[href="#/"]');
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
  check(new URL(page.url()).hash === '#/', 'then back again goes to the course list');
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
  await clearRound(page, 'practice');

  // ---------- accounts: a second user signs up in the browser ----------
  console.log('accounts');
  const visitor = await newPage({ width: 1280, height: 860 }, { signedOut: true });
  await visitor.goto(`${base}/#/c/demo`);
  await visitor.waitForSelector('.login-card');
  check(visitor.url().includes('#/login?next='), 'signed out: the app asks you to sign in');
  await visitor.screenshot({ path: `${shots}/40-login.png` });
  await visitor.click('[data-act="switch"]');
  await visitor.fill('input[name="username"]', 'visitor');
  await visitor.fill('input[name="password"]', 'secret1');
  await visitor.click('button[type="submit"]');
  await visitor.waitForSelector('.mtile');
  check(true, 'after signing up you land on the page you asked for');
  check(await visitor.$('[data-act="fork"]') && !(await visitor.$('[data-act="visibility"]')), "someone else's public course offers Fork, not Publish");
  check((await visitor.textContent('.course-meta')).includes('by tester'), 'and names its owner');
  check(!(await visitor.$('.mtile.resumable')), "the owner's unfinished rounds are not shown to others");
  await visitor.goto(`${base}/#/`);
  await visitor.waitForSelector('.public-tiles .course-tile');
  check((await visitor.textContent('.public-tiles')).includes('Demo'), 'the public course is listed under Public courses');
  await visitor.screenshot({ path: `${shots}/41-public-courses.png` });
  await visitor.goto(`${base}/#/c/demo/settings`);
  await visitor.waitForSelector('form.settings');
  check(!(await visitor.$('form.course-form')) && !(await visitor.$('.danger-zone')) && !(await visitor.$('.import-text')), "no editing, importing or deleting someone else's course");
  await visitor.goto(`${base}/#/c/demo`);
  await visitor.waitForSelector('.mtile');
  await visitor.click('[data-start="practice"]');
  await visitor.waitForSelector('.qcard');
  check(!(await visitor.$('[data-act="reparse"]')) && await visitor.$('[data-act="star"]'), 'no Re-parse on a course you do not own, Star still there');
  await visitor.goto(`${base}/#/c/demo`);
  await visitor.waitForSelector('[data-act="fork"]');
  await visitor.click('[data-act="fork"]');
  await visitor.waitForSelector('dialog input[name="name"]');
  await visitor.click('dialog .btn.primary');
  await visitor.waitForFunction(() => /#\/c\/demo-visitor$/.test(location.hash) && document.querySelector('[data-act="visibility"]'));
  check((await visitor.textContent('.course-meta')).includes('forked from'), 'forking opens your own private copy, linked to the original');
  await visitor.screenshot({ path: `${shots}/42-fork.png` });
  const ownerList = await (await authed(`${base}/api/courses`)).json();
  check(!ownerList.some((c) => c.id === 'demo-visitor'), 'the fork stays private to its owner');
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
