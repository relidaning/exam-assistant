import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.EXAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-unit-'));
const { evaluate, parseNumeric, grade, normText, answerText } = await import('../public/js/grade.js');
const { normalizeQuestion, normalizeAll, parseLetters, parseCalcPart, blanksAnyOrder } = await import('../lib/normalize.mjs');
const { parseMarkdown } = await import('../lib/parse-md.mjs');
const store = await import('../lib/store.mjs');
const { pickQuestions, scoreExam, moduleConfig, examConfigured, examSummary } = await import('../public/js/session.js');
const { createServer } = await import('../server.mjs');

test('expression evaluator', () => {
  assert.equal(evaluate('1+2*3'), 7);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-2^2'), -4);
  assert.ok(Math.abs(evaluate('2pi') - 2 * Math.PI) < 1e-12);
  assert.ok(Math.abs(evaluate('sqrt(2)*sqrt 2') - 2) < 1e-12);
  assert.equal(evaluate('1.5e3'), 1500);
  assert.equal(evaluate('50%'), 0.5);
  assert.equal(evaluate('3!'), 6);
  assert.equal(evaluate('√9'), 3);
  assert.equal(evaluate('6÷3×2'), 4);
  assert.throws(() => evaluate('2+'));
  assert.throws(() => evaluate('foo(2)'));
  assert.throws(() => evaluate('1/0'));
});

test('parseNumeric tolerates units and separators', () => {
  assert.equal(parseNumeric('12.5 m/s', 'm/s'), 12.5);
  assert.equal(parseNumeric('9.8 N'), 9.8);
  assert.equal(parseNumeric('1,000'), 1000);
  assert.equal(parseNumeric(''), null);
  assert.equal(parseNumeric('abc'), null);
});

test('parseLetters', () => {
  assert.deepEqual(parseLetters('B', 4), [1]);
  assert.deepEqual(parseLetters('a, c', 4), [0, 2]);
  assert.deepEqual(parseLetters('A、C、D', 4), [0, 2, 3]);
  assert.deepEqual(parseLetters('ＡＢ', 4), [0, 1]); // full-width
  assert.deepEqual(parseLetters('E', 4), []);
  assert.deepEqual(parseLetters('hello', 4), []);
  assert.deepEqual(parseLetters('AND', 4), []); // not a letter list
});

test('parseCalcPart', () => {
  assert.deepEqual(parseCalcPart('1/4'), { value: 0.25 });
  assert.deepEqual(parseCalcPart('9.8 m/s^2'), { value: 9.8, unit: 'm/s^2' });
  assert.deepEqual(parseCalcPart('3.14±0.01'), { value: 3.14, tol: 0.01 });
  assert.deepEqual(parseCalcPart('100 ± 2% N'), { value: 100, rel: 0.02, unit: 'N' });
  assert.deepEqual(parseCalcPart('x = 2'), { label: 'x', value: 2 });
  assert.throws(() => parseCalcPart('about two'));
});

test('normalize infers types from shape', () => {
  assert.equal(normalizeQuestion({ stem: 's', options: ['a', 'b'], answer: 'A' }).type, 'single');
  assert.equal(normalizeQuestion({ stem: 's', options: ['a', 'b', 'c'], answer: 'AC' }).type, 'multi');
  assert.equal(normalizeQuestion({ stem: 's', answer: '对' }).type, 'judge');
  assert.equal(normalizeQuestion({ stem: 'x is ___', answer: '1' }).type, 'fill');
  assert.equal(normalizeQuestion({ stem: 'compute', answer: '2/3' }).type, 'calc');
  assert.equal(normalizeQuestion({ stem: 'explain', answer: 'because' }).type, 'short');
  // explicit single with two letters becomes multi
  assert.equal(normalizeQuestion({ type: '单选题', stem: 's', options: ['a', 'b', 'c'], answer: 'AB' }).type, 'multi');
  // section hint is ignored when the shape disagrees
  assert.equal(normalizeQuestion({ typeHint: 'short', stem: 'rank is ____', answer: '0' }).type, 'fill');
  assert.equal(normalizeQuestion({ typeHint: 'calc', stem: 'compute', answer: '2' }).type, 'calc');
});

test('normalize: ids are stable and cloze works', () => {
  const a = normalizeQuestion({ stem: 'Capital of France is {{Paris|paris}}.' });
  assert.equal(a.type, 'fill');
  assert.equal(a.stem, 'Capital of France is ____.');
  assert.deepEqual(a.answer, [['Paris', 'paris']]);
  assert.equal(normalizeQuestion({ stem: 'Capital of France is {{Paris|paris}}.' }).id, a.id);
  const { questions, errors } = normalizeAll([{ stem: 'ok', answer: 'T' }, { options: ['a'] }, { stem: 's', options: ['a', 'b'], answer: 'Z' }]);
  assert.equal(questions.length, 1);
  assert.equal(errors.length, 2);
});

test('grading per type', () => {
  const single = normalizeQuestion({ stem: 's', options: ['a', 'b'], answer: 'B' });
  assert.equal(grade(single, 1).correct, true);
  assert.equal(grade(single, 0).correct, false);

  const multi = normalizeQuestion({ stem: 's', options: ['a', 'b', 'c'], answer: 'AC' });
  assert.equal(grade(multi, [0, 2]).correct, true);
  assert.deepEqual([grade(multi, [0]).correct, grade(multi, [0]).score], [false, 0.5]);
  assert.equal(grade(multi, [0, 1]).score, 0);

  const fill = normalizeQuestion({ stem: '___ and ___', answer: 'H2O; 1/2' });
  assert.equal(grade(fill, ['ｈ２ｏ', '0.5']).correct, true); // full-width + numeric equivalence
  assert.equal(grade(fill, ['h2o', 'x']).score, 0.5);

  const calc = normalizeQuestion({ stem: 'c', answer: '1/3' });
  assert.equal(grade(calc, ['0.333']).correct, true); // default 1% relative tolerance
  assert.equal(grade(calc, ['0.3']).correct, false);
  const tight = normalizeQuestion({ stem: 'c', answer: '11.48 ± 0.05 m' });
  assert.equal(grade(tight, ['11.5 m']).correct, true);
  assert.equal(grade(tight, ['11.6']).correct, false);

  const short = normalizeQuestion({ stem: 'explain', answer: 'ref', keywords: 'scalar, vector' });
  const r = grade(short, 'speed is a Scalar');
  assert.equal(r.correct, null);
  assert.deepEqual(r.detail.keywordHits, ['scalar']);
});

test('fill: an x/y key accepts x and y', () => {
  const rw = normalizeQuestion({ stem: 'CPU 将地址和 ____ 命令送到总线', answer: '读/写' });
  for (const r of ['读', '写', '读/写', '读／写']) assert.equal(grade(rw, [r]).correct, true, r);
  assert.equal(grade(rw, ['控制']).correct, false);
  const cf = normalizeQuestion({ stem: 'CF 表示 ____', answer: '进/借位' });
  assert.deepEqual(['进位', '借位', '进'].map((r) => grade(cf, [r]).correct), [true, true, false], 'the shorter side shares the suffix');
  const io = normalizeQuestion({ stem: '键盘被抽象为 ____', answer: '标准输入/输出' });
  assert.deepEqual(['标准输入', '标准输出'].map((r) => grade(io, [r]).correct), [true, true], 'or the prefix');
  assert.equal(grade(normalizeQuestion({ stem: 'bus does ____', answer: 'read/write' }), ['write']).correct, true);
  for (const key of ['1/x', '3V/m', '1000Mbit/s', 'I/O', 'TCP/IP', 'km/h']) {
    const q = normalizeQuestion({ stem: 'x = ____', answer: key });
    assert.equal(grade(q, [key.split('/')[1]]).correct, false, `${key} is one answer`);
  }
});

test('fill blanks in any order', () => {
  // "____和____" names two things in no particular order
  const cpu = normalizeQuestion({ stem: '中央处理器 (CPU) 的基本部件是____和____。', answer: '运算器; 控制器' });
  assert.equal(cpu.anyOrder, true);
  assert.equal(grade(cpu, ['控制器', '运算器']).correct, true, 'swapped is right');
  assert.equal(grade(cpu, ['运算器', '控制器']).correct, true);
  assert.equal(grade(cpu, ['控制器', '控制器']).score, 0.5, 'one key is not good for two blanks');
  const half = grade(cpu, ['存储器', '运算器']);
  assert.deepEqual([half.score, half.detail.blanks, half.detail.keys], [0.5, [false, true], [['控制器'], ['运算器']]], 'a wrong blank is shown the key still owed');
  assert.equal(answerText(cpu), '运算器; 控制器 (any order)');
  assert.deepEqual([blanksAnyOrder('____与____'), blanksAnyOrder('A ___ or ___ B'), blanksAnyOrder('one blank ____')], [true, true, false]);
  assert.deepEqual([blanksAnyOrder('实现____、____、人民幸福'), blanksAnyOrder('分为 ____ 和 ____ 两种，前者用于…')], [false, false], 'set phrases (、) and 前者/后者 keep their order');

  // order matters when the blanks are apart, or the stem says so
  for (const stem of ['指令序列称为____，指令操作的对象是____。', '立即数前加 ____ 符号，寄存器前加 ____ 符号', '它们分别是____和____。', '____，____，是初心和使命。']) {
    const q = normalizeQuestion({ stem, answer: 'a; b' });
    assert.ok(!q.anyOrder, stem);
    assert.equal(grade(q, ['b', 'a']).correct, false);
  }
  // said explicitly, either way
  assert.equal(normalizeQuestion({ stem: 'x ____, y ____', answer: 'a; b', anyOrder: true }).anyOrder, true);
  assert.ok(!normalizeQuestion({ stem: '____和____', answer: 'a; b', order: 'fixed' }).anyOrder);
  const [md] = parseMarkdown('1. 前者是 ____，后者是 ____。\n答案：甲；乙\n顺序：任意\n').questions;
  assert.equal(normalizeQuestion(md).anyOrder, true, 'Markdown: 顺序：任意');
});

test('store: patching a question keeps its id, source text and progress', () => {
  const c = store.createCourse({ name: 'Patch Course' });
  store.importQuestions(c.id, [{ stem: 'x ____ y ____', answer: 'a; b' }]);
  const [q] = store.getCourse(c.id).questions;
  store.recordAttempt(c.id, 0, { qid: q.id, correct: false });
  assert.equal(store.patchQuestion(c.id, q.id, { anyOrder: true }).anyOrder, true);
  assert.equal(store.getCourse(c.id).questions[0].anyOrder, true);
  assert.equal(store.getProgress(c.id, 0).questions[q.id].wrong, 1);
  assert.ok(!('anyOrder' in store.patchQuestion(c.id, q.id, { anyOrder: null })), 'null removes a field');
  assert.throws(() => store.patchQuestion(c.id, q.id, { id: 'other' }), /keeps its id/);
});

test('answerText', () => {
  assert.equal(answerText(normalizeQuestion({ stem: 's', options: ['a', 'b', 'c'], answer: 'AC' })), 'AC');
  assert.equal(answerText(normalizeQuestion({ stem: 'c', answer: 'v = 10 m/s' })), 'v = 10 m/s');
  assert.equal(normText('  Ｈｅｌｌｏ　World。'), 'hello world');
});

test('markdown parser handles a Chinese paper with sections, inline options and numbered answers', () => {
  const src = fs.readFileSync(new URL('./fixtures-sample.md', import.meta.url), 'utf8');
  const { meta, questions } = parseMarkdown(src);
  assert.equal(meta.course, '测试课程');
  const { questions: qs, errors } = normalizeAll(questions, { tags: meta.tags });
  assert.equal(errors.length, 0);
  assert.deepEqual(qs.map((q) => q.type), ['single', 'multi', 'judge', 'fill', 'fill', 'calc', 'calc', 'short', 'judge', 'fill']);
  assert.deepEqual(qs[0].options.length, 4);
  assert.equal(qs[7].answer.split('\n').length, 3); // numbered answer list kept inside the answer
  assert.equal(qs[0].chapter, '第一章 矩阵');
});

test('markdown parser: headings, callouts, obsidian embeds', () => {
  const src = `## What is 2+2?
- [ ] 3
- [x] 4
> [!answer] B
> Explanation: basic arithmetic

## Diagram question ![[fig 1.png]]
Answer: True
`;
  const { questions } = parseMarkdown(src);
  assert.equal(questions.length, 2);
  const [a, b] = normalizeAll(questions).questions;
  assert.equal(a.answer, 1);
  assert.equal(a.explanation, 'basic arithmetic');
  assert.match(b.stem, /!\[\]\(fig 1\.png\)/);
});

test('markdown parser: messy real-world notes', () => {
  const src = [
    '第二章 测试章节',                                  // title line → chapter
    '一、单选题',                                       // plain-text section line
    '1.(  )是正确的。',
    'A.甲   B. 乙',
    ' C.丙            D.丁',                           // leading space, inline options
    '答案C',                                            // no colon
    '2.下列说法正确的是（  ）。',
    'A. 生产      B 共同富裕        C. 就业        D. 生活水平', // "B" without separator
    '答案：B',
    '二、多选题',
    '1.以下包括（  ）。',
    'A.一，二 B. 三C. 四   D.五、E.六',                 // glued option markers
    'ABCDE',                                            // bare answer line
    '2.第二题（  ）。',
    'A制定出台文件',                                    // "A" without separator, B follows
    'B.另一项',
    '答案：AB',
    '三、填空题',
    '1.市场在资源配置中起（）作用。',                     // empty parens = blank in a fill section
    '答案：决定性',
    '四、判断题',
    '1.甲是乙。（    ）',
    '答案：错误, 错误原因：甲是丙。',                    // verdict + reason
    '2.丙是丁。答案：正确',                              // inline answer
    '3​.零宽字符。',                                // zero-width char
    '答案：对',
  ].join('\n');
  const { questions } = parseMarkdown(src);
  const { questions: qs, errors } = normalizeAll(questions);
  assert.deepEqual(errors, []);
  assert.deepEqual(qs.map((q) => q.type), ['single', 'single', 'multi', 'multi', 'fill', 'judge', 'judge', 'judge']);
  assert.equal(qs[0].chapter, '第二章 测试章节');
  assert.deepEqual(qs[0].options, ['甲', '乙', '丙', '丁']);
  assert.equal(qs[0].answer, 2);
  assert.equal(qs[1].answer, 1);
  assert.equal(qs[2].options.length, 5);
  assert.deepEqual(qs[2].answer, [0, 1, 2, 3, 4]);
  assert.deepEqual(qs[3].options, ['制定出台文件', '另一项']);
  assert.match(qs[4].stem, /起____作用/);
  assert.equal(qs[5].answer, false);
  assert.equal(qs[5].explanation, '错误原因：甲是丙。');
  assert.equal(qs[6].answer, true);
  assert.equal(qs[6].stem, '丙是丁。');
  // CJK punctuation inside a fill answer is ignored when grading
  const fill = normalizeQuestion({ stem: '回答了____', answer: '坚持和发展什么样的，怎样坚持' });
  assert.equal(grade(fill, ['坚持和发展什么样的怎样坚持']).correct, true);
});

test('store: import merges by id, progress and mistakes book', () => {
  const c = store.createCourse({ name: 'Unit Course' });
  assert.equal(c.id, 'unit-course');
  const raw = [{ stem: 'q1', options: ['a', 'b'], answer: 'A' }, { stem: 'q2', answer: 'yes' }];
  let r = store.importQuestions(c.id, raw);
  assert.deepEqual([r.added, r.updated, r.unchanged], [2, 0, 0]);
  r = store.importQuestions(c.id, [{ ...raw[0], explanation: 'new' }, raw[1]]);
  assert.deepEqual([r.added, r.updated, r.unchanged], [0, 1, 1]);
  r = store.importQuestions(c.id, [raw[1]], { mode: 'replace' });
  assert.equal(r.removed, 1);
  assert.equal(store.getCourse(c.id).questions.length, 1);

  const qid = store.getCourse(c.id).questions[0].id;
  const U = 1;
  store.recordAttempt(c.id, U, { qid, correct: false });
  let p = store.getProgress(c.id, U).questions[qid];
  assert.ok(store.inWrongBook(p));
  assert.equal(store.MASTERY_STREAK, 3);
  for (let i = 0; i < 2; i++) store.recordAttempt(c.id, U, { qid, correct: true });
  assert.ok(store.inWrongBook(store.getProgress(c.id, U).questions[qid]), 'still in the book after 2 right in a row');
  store.recordAttempt(c.id, U, { qid, correct: true });
  p = store.getProgress(c.id, U).questions[qid];
  assert.ok(!store.inWrongBook(p), 'leaves the book after 3 right in a row');
  assert.equal(p.wrong, 1);
  store.recordAttempt(c.id, U, { qid, correct: false });
  assert.ok(store.inWrongBook(store.getProgress(c.id, U).questions[qid]), 'back in the book after a new mistake');
  assert.deepEqual(store.getProgress(c.id, 2).questions, {}, 'progress is per user');
  assert.throws(() => store.getCourse('../etc'), /Bad course id/);
});

test('sqlite: every answer is logged, activity per local day, delete cascades', () => {
  const c = store.createCourse({ name: 'Log Course' });
  store.importQuestions(c.id, [{ stem: 'q1', options: ['a', 'b'], answer: 'A' }]);
  const qid = store.getCourse(c.id).questions[0].id;
  const U = 1;
  store.recordAttempt(c.id, U, { qid, correct: true, response: 0, mode: 'practice' });
  store.recordAttempt(c.id, U, { qid, correct: false, response: 1, mode: 'practice' });
  store.setFlags(c.id, U, { qid, starred: true, note: 'tricky' });
  const p = store.getProgress(c.id, U).questions[qid];
  assert.deepEqual([p.attempts, p.correct, p.wrong, p.streak, p.starred, p.note, p.lastResponse], [2, 1, 1, 0, true, 'tricky', 1]);
  const log = store.conn().prepare('SELECT correct, response, mode FROM attempts WHERE course_id = ? ORDER BY id').all(c.id);
  assert.deepEqual(log.map((r) => ({ ...r })), [{ correct: 1, response: '0', mode: 'practice' }, { correct: 0, response: '1', mode: 'practice' }]);
  const act = store.getActivity(c.id, U, { days: 7, tzMinutes: 480 });
  assert.equal(act.length, 7);
  assert.deepEqual([act.at(-1).answers, act.at(-1).correct], [2, 1]);
  assert.equal(act.slice(0, -1).reduce((a, d) => a + d.answers, 0), 0);
  assert.equal(store.getActivity(c.id, 2, { days: 7 }).at(-1).answers, 0, 'activity is per user');
  store.resetProgress(c.id, U);
  assert.equal(store.getActivity(c.id, U, { days: 7 }).at(-1).answers, 0);
  store.deleteCourse(c.id);
  assert.equal(store.conn().prepare('SELECT count(*) AS n FROM questions WHERE course_id = ?').get(c.id).n, 0);
});

test('sqlite: JSON data from the old storage is migrated once and backed up', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-migrate-'));
  fs.mkdirSync(path.join(dir, 'courses'));
  fs.mkdirSync(path.join(dir, 'progress'));
  const q = normalizeQuestion({ stem: 'old q', options: ['a', 'b'], answer: 'B', chapter: 'ch1' });
  fs.writeFileSync(path.join(dir, 'courses', 'old.json'), JSON.stringify({ id: 'old', name: 'Old', description: 'd', examDate: '2030-01-01', sources: [{ kind: 'file', name: 'x.md', at: '2026-01-01T00:00:00Z', count: 1 }], questions: [q] }));
  fs.writeFileSync(path.join(dir, 'progress', 'old.json'), JSON.stringify({
    questions: { [q.id]: { attempts: 3, correct: 1, wrong: 2, streak: 0, starred: true, history: [0, 1, 0] } },
    exams: [{ at: '2026-01-02T00:00:00Z', total: 1, score: 2, maxScore: 2, correct: 1, durationSec: 30, byType: {} }],
    settings: { practice: { types: ['single'] } },
  }));
  const script = `import * as s from ${JSON.stringify(new URL('../lib/store.mjs', import.meta.url).href)};
    const c = s.getCourse('old'); const p = s.getProgress('old', 0);
    console.log(JSON.stringify({ name: c.name, examDate: c.examDate, n: c.questions.length, sources: c.sources.length, p: p.questions[c.questions[0].id], exams: p.exams.length, types: p.settings.practice.types }));`;
  const run = () => execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, EXAM_DATA_DIR: dir }, encoding: 'utf8' });
  const first = run().trim().split('\n');
  assert.match(first[0], /^Migrated JSON data to SQLite: 1 courses, 1 questions/);
  const out = JSON.parse(first.at(-1));
  assert.deepEqual([out.name, out.examDate, out.n, out.sources, out.exams, out.types], ['Old', '2030-01-01', 1, 1, 1, ['single']]);
  assert.deepEqual([out.p.attempts, out.p.wrong, out.p.starred, out.p.history], [3, 2, true, [0, 1, 0]]);
  assert.ok(fs.existsSync(path.join(dir, 'json-backup', 'courses', 'old.json')), 'old files kept in json-backup/');
  assert.ok(!fs.existsSync(path.join(dir, 'courses')));
  assert.equal(run().trim().split('\n').length, 1, 'second start does not migrate again');
});

test('markdown parser: an option marked with a full-width comma ("D，")', () => {
  const { questions } = parseMarkdown('8.全面依法治国的总抓手是(     )。\nA.甲，乙\nB.甲   C.乙\nD，丙\n答案: B');
  assert.equal(questions[0].stem, '全面依法治国的总抓手是(     )。');
  assert.deepEqual(questions[0].options, ['甲，乙', '甲', '乙', '丙']);
});

test('parser keeps each question\'s source block and file line', () => {
  const src = '---\ncourse: x\n---\n# Ch\n\n1. first?\nA. a\nB. b\n答案：A\n\n2. second ____\n答案：yes\n';
  const { questions } = parseMarkdown(src);
  assert.deepEqual(questions.map((q) => q._line), [6, 11]);
  assert.equal(questions[0]._raw, '1. first?\nA. a\nB. b\n答案：A');
  assert.equal(questions[1]._raw, '2. second ____\n答案：yes');
});

test('re-parse: progress follows the question to its new id; the note\'s fixed version is found', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-note-'));
  const note = path.join(dir, 'ch1.md');
  fs.writeFileSync(note, '一、多选题\n1.Which hold?（ ）\nA.one\nB.two\nB.three\n答案：AB\n\n2.Other question?\nA.x\nB.y\n答案：A\n');
  const { parseMarkdown: pm } = await import('../lib/parse-md.mjs');
  const parsed = pm(fs.readFileSync(note, 'utf8')).questions.map((q) => ({ ...q, _file: note }));
  const owner = store.createUser({ username: 'reparser', password: 'secret1' });
  const cookie = `ea_sid=${store.createLogin(owner.id)}`;
  const c = store.createCourse({ name: 'Reparse Course', ownerId: owner.id });
  store.importQuestions(c.id, parsed);
  const broken = store.getCourse(c.id).questions[0];
  assert.equal(broken.options.length, 2, 'duplicate "B." swallowed into the stem');
  store.recordAttempt(c.id, owner.id, { qid: broken.id, correct: false });

  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/courses/${c.id}/questions`;
  const call = async (method, url, body) => (await fetch(url, { method, headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) })).json();
  try {
    let src = await call('GET', `${base}/${broken.id}/source`);
    assert.equal(src.line, 2);
    assert.equal(src.fileName, 'ch1.md');
    assert.match(src.raw, /^1\.Which hold\?/);
    assert.equal(src.fromFile.raw.trim(), src.raw.trim(), 'note unchanged so far');

    // the user fixes the typo in the note; the dialog offers the note's new version
    fs.writeFileSync(note, fs.readFileSync(note, 'utf8').replace('B.three', 'C.three'));
    src = await call('GET', `${base}/${broken.id}/source`);
    assert.match(src.fromFile.raw, /C\.three/);

    const preview = await call('POST', `${base}/${broken.id}/reparse`, { content: src.fromFile.raw, type: 'multi' });
    assert.deepEqual([preview.question.type, preview.question.options.length, preview.question.answer], ['multi', 3, [0, 1]]);
    assert.equal(store.getCourse(c.id).questions[0].options.length, 2, 'preview does not save');
    fs.writeFileSync(path.join(dir, 'fig.png'), 'png-bytes');
    const withImg = await call('POST', `${base}/${broken.id}/reparse`, { content: '1. Look ![[fig.png]]\nA. a\nB. b\n答案：A' });
    assert.match(withImg.question.stem, /\/media\//, 'preview shows images from the note folder, not broken links');
    const bad = await call('POST', `${base}/${broken.id}/reparse`, { content: '1. stem only?\nA. a\nB. b\n答案：Z' });
    assert.match(bad.error, /not option letters/);

    const saved = await call('POST', `${base}/${broken.id}/reparse`, { content: src.fromFile.raw, type: 'multi', save: true, line: src.fromFile.line });
    assert.notEqual(saved.question.id, broken.id, 'content changed, so the id changed');
    const qs = store.getCourse(c.id).questions;
    assert.equal(qs.length, 2);
    assert.equal(qs[0].id, saved.question.id, 'kept its position');
    assert.equal(qs[0].options.length, 3);
    const p = store.getProgress(c.id, owner.id).questions;
    assert.equal(p[saved.question.id].wrong, 1, 'progress moved to the new id');
    assert.equal(p[broken.id], undefined);
    // a later re-import of the fixed note matches the re-parsed question instead of adding a duplicate
    const again = store.importQuestions(c.id, pm(fs.readFileSync(note, 'utf8')).questions.map((q) => ({ ...q, _file: note })));
    assert.equal(again.added, 0);
    // re-parsing into a copy of another question merges the two: the other one stays, with both questions' progress
    const other = qs[1];
    store.setFlags(c.id, owner.id, { qid: other.id, starred: true });
    const merged = await call('POST', `${base}/${saved.question.id}/reparse`, { content: (await call('GET', `${base}/${other.id}/source`)).raw, type: other.type, save: true });
    assert.equal(merged.question.id, other.id);
    assert.deepEqual(store.getCourse(c.id).questions.map((q) => q.id), [other.id], 'the edited copy is gone');
    const pm2 = store.getProgress(c.id, owner.id).questions;
    assert.equal(pm2[saved.question.id], undefined);
    assert.equal(pm2[other.id].starred, true, 'the star stays');
    assert.equal(pm2[other.id].correct + pm2[other.id].wrong, 1, 'the edited copy\'s answer is now the twin\'s');
    assert.match(store.courseHistory(c.id).entries[0].summary, /^Merged a duplicate/);
  } finally {
    server.close();
  }
});

test('questions without stored source are rebuilt as Markdown that parses back the same', async () => {
  const { toMarkdown } = await import('../lib/tomd.mjs');
  const samples = normalizeAll([
    { stem: 'Pick two', options: ['a', 'b', 'c'], answer: 'AC', explanation: 'because' },
    { stem: 'Is it?', answer: false },
    { stem: '$x$ = ____ and ____', answer: [['1', 'one'], ['2']] },
    { stem: 'Speed?', answer: [{ label: 'v', value: 10, unit: 'm/s', tol: 0.5 }] },
    { stem: 'Explain', answer: 'Line one\nLine two', keywords: ['one', 'two'] },
  ]).questions;
  const { detectFormat, parsePayload } = await import('../lib/importer.mjs');
  for (const q of samples) {
    const md = toMarkdown(q);
    assert.equal(detectFormat(md), 'md', `the rebuilt text starts with its type tag, "[${q.type}]", and is still Markdown`);
    const back = normalizeAll(parsePayload(md, detectFormat(md)).questions).questions[0]; // the way Re-parse reads it
    assert.deepEqual(back, q, md);
  }
  // pasted text: JSON only when it is JSON, or broken but clearly meant as JSON
  for (const [text, format] of [['[{"stem":"x"}]', 'json'], ['{"questions":[]}', 'json'], ['[{"stem": oops', 'json'], ['[[Note]] what?', 'md'], ['[link](u) q?', 'md']]) {
    assert.equal(detectFormat(text), format, text);
  }
});

test('past-paper format: essay sections, 答：/【参考答案】 answers, and a past-papers-only exam', () => {
  const src = [
    '一、单选题', '1、中国特色社会主义最本质的特征是（  ）', 'A.中国共产党领导', 'B.实现人的全面发展', '答案：A',
    '二、简答题', '26.两个结合', '【参考答案】', '马克思主义基本原理同中国具体实际相结合、同中华优秀传统文化相结合。',
    '27、简述高质量发展的重大战略意义。', '答：(1)物质基础；', '(2)重要保证。',
    '三、论述题', '31、结合材料回答问题', '——摘自某书', '试述中国式现代化的中国特色。', '答：(1)人口规模巨大的现代化。(3分)',
  ].join('\n');
  const { questions, errors } = normalizeAll(parseMarkdown(src).questions, { tags: 'past-paper' });
  assert.deepEqual(errors, []);
  assert.deepEqual(questions.map((q) => q.type), ['single', 'short', 'short', 'essay']);
  assert.match(questions[1].answer, /中华优秀传统文化/);
  assert.equal(questions[2].answer, '(1)物质基础；\n(2)重要保证。');
  assert.equal(grade(questions[3], 'x').correct, null, 'essays are self-graded like short answers');
  assert.equal(normalizeQuestion({ type: '材料分析题', stem: 's', answer: 'a' }).type, 'essay');

  const extra = normalizeAll([{ type: 'short', stem: 'chapter q', answer: 'x', chapter: 'c1' }]).questions;
  const course = { questions: [...questions, ...extra] };
  const settings = store.sanitizeSettings({ chapters: ['c1'], exam: { perType: { single: 1, short: 2, essay: 1 }, points: { short: 7, essay: 15 }, timeMin: 150, tag: 'past-paper' } });
  const exam = pickQuestions(course, { questions: {} }, moduleConfig('exam', settings));
  assert.deepEqual(exam.map((q) => q.type), ['single', 'short', 'short', 'essay'], 'type order of a real paper; chapter filter ignored');
  assert.ok(exam.every((q) => q.tags?.includes('past-paper')));
  assert.equal(scoreExam(exam, {}, { ...examSummary(settings).points }).maxScore, 2 + 7 + 7 + 15);
  const noTag = pickQuestions(course, { questions: {} }, moduleConfig('exam', { ...settings, exam: { ...settings.exam, tag: '' } }));
  assert.equal(noTag.length, 1, 'without the tag the exam follows the chapter selection (c1 has one short answer)');
});

test('definitions (名词解释) are their own type, between fill-ins and short answers on a paper', () => {
  const src = ['二、填空题', '11. 主频的倒数是____。', '答案：时钟周期', '三、名词解释题', '21. 主频', '答案：CPU 主脉冲信号的时钟频率。',
    '四、简答题', '23. 简述原码乘法。', '答案：符号异或，数值相乘。', '27. [essay] 计算 CPI。', '答案：1.4'].join('\n');
  const { questions, errors } = normalizeAll(parseMarkdown(src).questions, { tags: 'past-paper' });
  assert.deepEqual(errors, []);
  assert.deepEqual(questions.map((q) => q.type), ['fill', 'term', 'short', 'essay']);
  assert.equal(normalizeQuestion({ type: '名词解释题', stem: '进程', answer: 'x' }).type, 'term');
  assert.equal(grade(questions[1], 'anything').correct, null, 'definitions are self-graded');
  const settings = store.sanitizeSettings({ exam: { perType: { fill: 1, term: 1, short: 1, essay: 1 }, points: { fill: 2, term: 3, short: 6, essay: 10 }, tag: 'past-paper' } });
  const exam = pickQuestions({ questions }, { questions: {} }, moduleConfig('exam', settings));
  assert.deepEqual(exam.map((q) => q.type), ['fill', 'term', 'short', 'essay']);
  assert.equal(examSummary(settings, { fill: 1, term: 1, short: 1, essay: 1 }).maxScore, 2 + 3 + 6 + 10);
});

test('session picking from settings and exam scoring', () => {
  const course = { questions: normalizeAll([
    { stem: 'a', options: ['x', 'y'], answer: 'A', chapter: 'c1' },
    { stem: 'b', answer: 'T', chapter: 'c1' },
    { stem: 'c', answer: '2', chapter: 'c2' },
    { stem: 'd', answer: 'ref', chapter: 'c2' },
  ]).questions };
  const [a, b, c, d] = course.questions;
  const progress = { questions: { [a.id]: { attempts: 3, correct: 1, wrong: 2, streak: 0 }, [b.id]: { attempts: 1, correct: 0, wrong: 1, streak: 0 }, [c.id]: { attempts: 1, correct: 1, wrong: 0, streak: 1, starred: true } } };
  const ids = (qs) => qs.map((q) => q.id).sort();
  const settings = store.sanitizeSettings({ chapters: ['c2'], practice: { types: ['short', 'bogus'], count: 5 }, exam: { perType: { judge: 1, single: 1 }, timeMin: 30 } });
  assert.deepEqual(settings.practice.types, ['short']);
  assert.deepEqual(ids(pickQuestions(course, progress, moduleConfig('practice', settings))), [d.id]);
  assert.deepEqual(ids(pickQuestions(course, progress, moduleConfig('mistakes', {}))), ids([a, b]));
  assert.deepEqual(ids(pickQuestions(course, progress, moduleConfig('mistakes', { mistakes: { frequentOnly: true } }))), [a.id]);
  assert.deepEqual(ids(pickQuestions(course, progress, moduleConfig('starred', {}))), [c.id]);
  // practice is shuffled: with a fixed rng the order differs from the bank order
  let seed = 1; const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  assert.notDeepEqual(pickQuestions(course, progress, { module: 'practice' }, rng).map((q) => q.id), course.questions.map((q) => q.id));
  assert.equal(examConfigured(settings), true);
  assert.equal(examConfigured(store.sanitizeSettings({})), false);
  const exam = pickQuestions(course, progress, moduleConfig('exam', { exam: { perType: { judge: 1, single: 1 } } }));
  assert.deepEqual(exam.map((q) => q.type), ['judge', 'single']);
  const sum = examSummary(settings, { judge: 1, single: 1 });
  assert.deepEqual([sum.questions, sum.maxScore, sum.timeMin], [2, 3, 30]);
  const s = scoreExam([a, b, c], { [a.id]: { correct: true, score: 1 }, [b.id]: { correct: false, score: 0 }, [c.id]: { correct: false, score: 0.5 } });
  assert.deepEqual([s.score, s.maxScore, s.correct], [2 + 2.5, 2 + 1 + 5, 1]);
});

test('HTTP API round trip', async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.equal((await call('GET', '/api/courses')).status, 401, 'signed out: no API');
    const reg = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'api-user', password: 'secret1' }) });
    cookie = reg.headers.get('set-cookie').split(';')[0];
    assert.match(reg.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    assert.equal((await call('GET', '/api/auth/me')).body.user.username, 'api-user');
    const created = await call('POST', '/api/courses', { name: '数据结构' });
    assert.equal(created.status, 200);
    const id = created.body.id;
    assert.equal(id, '数据结构');
    const prev = await call('POST', '/api/import/preview', { content: '1. 栈的特点是 ____。\n答案：后进先出|LIFO' });
    assert.equal(prev.body.questions[0].type, 'fill');
    const imp = await call('POST', `/api/courses/${encodeURIComponent(id)}/import`, { content: JSON.stringify([{ stem: 'q', options: ['a', 'b'], answer: 'B' }]) });
    assert.equal(imp.body.added, 1);
    const got = await call('GET', `/api/courses/${encodeURIComponent(id)}`);
    const qid = got.body.course.questions[0].id;
    const att = await call('POST', `/api/courses/${encodeURIComponent(id)}/attempt`, { qid, correct: false });
    assert.equal(att.body.wrong, 1);
    const list = await call('GET', '/api/courses');
    assert.equal(list.body.find((c) => c.id === id).stats.wrongBook, 1);
    const saved = await call('PUT', `/api/courses/${encodeURIComponent(id)}/settings`, { exam: { perType: { single: 3 }, timeMin: 45 } });
    assert.deepEqual(saved.body.exam.perType, { single: 3 });
    // unfinished rounds live on the server, one per module slot
    const round = { courseId: id, module: 'practice', slot: 'practice', qids: [qid], idx: 0, entries: { [qid]: { response: 1 } }, phase: 'answering' };
    assert.equal((await call('PUT', `/api/courses/${encodeURIComponent(id)}/sessions/practice`, round)).status, 200);
    assert.deepEqual((await call('GET', `/api/courses/${encodeURIComponent(id)}`)).body.sessions, { practice: round });
    assert.equal((await call('PUT', `/api/courses/${encodeURIComponent(id)}/sessions/bogus`, round)).status, 400);
    assert.equal((await call('PUT', `/api/courses/${encodeURIComponent(id)}/sessions/exam`, { nope: 1 })).status, 400);
    await call('PUT', `/api/courses/${encodeURIComponent(id)}/sessions/exam`, { ...round, slot: 'exam' });
    await call('DELETE', `/api/courses/${encodeURIComponent(id)}/sessions/exam`);
    assert.deepEqual(Object.keys((await call('GET', `/api/courses/${encodeURIComponent(id)}/sessions`)).body), ['practice']);
    const everywhere = (await call('GET', '/api/sessions')).body;
    assert.deepEqual(everywhere.map((r) => [r.courseId, r.courseName, r.slot]), [[id, '数据结构', 'practice']], 'every course\'s rounds in one list');
    assert.deepEqual(everywhere[0].session, round);
    await call('POST', `/api/courses/${encodeURIComponent(id)}/reset-progress`);
    assert.deepEqual((await call('GET', `/api/courses/${encodeURIComponent(id)}/sessions`)).body, {}, 'a progress reset drops unfinished rounds');
    assert.equal((await call('GET', `/api/courses/${encodeURIComponent(id)}`)).body.progress.settings.exam.timeMin, 45, 'settings survive a progress reset');
    assert.equal((await call('GET', '/api/courses/nope')).status, 404);
    assert.equal((await fetch(`${base}/media/..%2F..%2Fpackage.json`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/media/x/y.png`)).status, 401, 'media needs a sign-in');
    const foreign = await fetch(`${base}/api/courses`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: 'http://evil.example' }, body: '{"name":"x"}' });
    assert.equal(foreign.status, 403, 'writes from another origin are refused');
    await call('POST', '/api/auth/logout');
    assert.equal((await call('GET', '/api/courses')).status, 401, 'the token is gone after signing out');
    assert.equal((await fetch(`${base}/c/x/run`)).status, 200); // SPA fallback
  } finally {
    server.close();
  }
});

test('accounts: private progress, public courses, publish, fork', async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, password = 'secret1') => {
    let res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (res.status === 401) res = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(res.status, 200, `sign in as ${username}`);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
  };
  try {
    const ann = await as('ann');
    const bob = await as('bob');
    assert.equal((await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ANN', password: 'secret1' }) })).status, 409, 'names are unique, ignoring case');
    assert.equal((await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'carl', password: '123' }) })).status, 400, 'short password');
    assert.equal((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ann', password: 'nope' }) })).status, 401);

    // ann's new course is private: bob can't see it, or touch it
    const c = (await ann('POST', '/api/courses', { name: 'Shared Bank' })).body;
    assert.equal(c.visibility, 'private');
    await ann('POST', `/api/courses/${c.id}/import`, { content: JSON.stringify([{ stem: 'q1', options: ['a', 'b'], answer: 'A' }, { stem: 'q2', options: ['a', 'b'], answer: 'B' }]) });
    await ann('PUT', `/api/courses/${c.id}/settings`, { exam: { perType: { single: 2 }, timeMin: 20 } });
    assert.ok(!(await bob('GET', '/api/courses')).body.some((x) => x.id === c.id));
    assert.equal((await bob('GET', `/api/courses/${c.id}`)).status, 404, 'a private course of someone else does not exist for you');
    assert.equal((await bob('POST', `/api/courses/${c.id}/attempt`, { qid: 'x', correct: true })).status, 404);
    assert.equal((await bob('PATCH', `/api/courses/${c.id}`, { visibility: 'public' })).status, 404);

    // only an admin publishes: ann (not one) can't put her course up; here it is published behind the API's back
    assert.equal((await ann('PATCH', `/api/courses/${c.id}`, { visibility: 'public' })).status, 403, 'publishing is for admins');
    assert.equal(store.updateCourse(c.id, { visibility: 'public' }).visibility, 'public');

    // published: bob sees it, practises it with his own progress and settings, but can't edit it
    const listed = (await bob('GET', '/api/courses')).body.find((x) => x.id === c.id);
    assert.deepEqual([listed.mine, listed.owner.username, listed.stats.total], [false, 'ann', 2]);
    const view = (await bob('GET', `/api/courses/${c.id}`)).body;
    assert.deepEqual(view.course.access, { isOwner: false, canEdit: false, canManage: false });
    assert.equal(view.progress.settings.exam.timeMin, 20, "starts from the owner's settings");
    const [q1, q2] = view.course.questions.map((q) => q.id);
    await ann('POST', `/api/courses/${c.id}/attempt`, { qid: q1, correct: true });
    await bob('POST', `/api/courses/${c.id}/attempt`, { qid: q1, correct: false });
    await bob('POST', `/api/courses/${c.id}/flag`, { qid: q2, starred: true, note: 'bob only' });
    const sat = (await bob('POST', `/api/courses/${c.id}/exam`, { title: 'P', total: 2, score: 1, maxScore: 2, correct: 1, detail: { qids: [q1, q2], entries: { [q1]: { response: 0 } } } })).body;
    assert.ok(sat.id && sat.reviewable, 'a sitting saved with its answers can be reviewed');
    assert.deepEqual((await bob('GET', `/api/courses/${c.id}/exams/${sat.id}`)).body.qids, [q1, q2]);
    assert.equal((await ann('GET', `/api/courses/${c.id}/exams/${sat.id}`)).status, 404, "another user's sitting is not theirs to open");
    const old = (await bob('POST', `/api/courses/${c.id}/exam`, { title: 'P', total: 2, score: 0, maxScore: 2, correct: 0 })).body;
    assert.equal(old.reviewable, false);
    assert.equal((await bob('GET', `/api/courses/${c.id}/exams/${old.id}`)).status, 404, 'a sitting without answers has nothing to review');
    assert.deepEqual((await bob('GET', `/api/courses/${c.id}`)).body.progress.exams.map((e) => [e.id, e.reviewable, 'detail' in e]), [[sat.id, true, false], [old.id, false, false]], 'the course load lists sittings without their answers');
    await bob('PUT', `/api/courses/${c.id}/sessions/practice`, { qids: [q1], entries: {} });
    assert.deepEqual((await ann('GET', '/api/sessions')).body.filter((r) => r.courseId === c.id), [], "bob's rounds are not in ann's list");
    await bob('PUT', `/api/courses/${c.id}/settings`, { exam: { perType: { single: 1 }, timeMin: 5 } });
    const annSees = (await ann('GET', `/api/courses/${c.id}`)).body;
    assert.deepEqual([annSees.progress.questions[q1].correct, annSees.progress.questions[q1].wrong, annSees.progress.questions[q2], annSees.progress.exams.length, annSees.sessions],
      [1, 0, undefined, 0, {}], "bob's answers, stars, notes, exams and rounds are invisible to ann");
    assert.equal(annSees.progress.settings.exam.timeMin, 20, "bob's settings don't change the course's");
    assert.equal(annSees.learners, 1, 'the owner sees how many others practise it');
    const bobSees = (await bob('GET', `/api/courses/${c.id}`)).body;
    assert.deepEqual([bobSees.progress.questions[q1].wrong, bobSees.progress.questions[q2].note, bobSees.progress.settings.exam.timeMin, bobSees.stats.wrongBook], [1, 'bob only', 5, 1]);
    assert.equal((await bob('GET', '/api/courses')).body.find((x) => x.id === c.id).stats.wrongBook, 1, 'list stats are your own');
    assert.equal((await ann('GET', '/api/courses')).body.find((x) => x.id === c.id).stats.wrongBook, 0);
    for (const [method, url, body] of [
      ['PATCH', `/api/courses/${c.id}`, { name: 'hijacked' }],
      ['POST', `/api/courses/${c.id}/import`, { content: '1. x ____\n答案：y' }],
      ['DELETE', `/api/courses/${c.id}/questions/${q1}`],
      ['GET', `/api/courses/${c.id}/questions/${q1}/source`],
      ['POST', `/api/courses/${c.id}/questions/${q1}/reparse`, { content: '1. x?\nA. a\nB. b\n答案：A', save: true }],
      ['DELETE', `/api/courses/${c.id}`],
      ['PATCH', `/api/courses/${c.id}`, { visibility: 'private' }],
    ]) assert.equal((await bob(method, url, body)).status, 403, `${method} ${url} is the owner's`);
    await bob('POST', `/api/courses/${c.id}/reset-progress`);
    assert.equal((await ann('GET', `/api/courses/${c.id}`)).body.progress.questions[q1].correct, 1, "a reset clears only your own progress");
    await bob('POST', `/api/courses/${c.id}/attempt`, { qid: q1, correct: false });

    // bob forks it: a private copy he owns, his progress comes along, ann's doesn't
    const fork = (await bob('POST', `/api/courses/${c.id}/fork`, { withProgress: true })).body;
    assert.notEqual(fork.id, c.id);
    assert.deepEqual([fork.name, fork.visibility, fork.owner.username, fork.forkedFrom.id, fork.questions.length], ['Shared Bank', 'private', 'bob', c.id, 2]);
    const fv = (await bob('GET', `/api/courses/${fork.id}`)).body;
    assert.deepEqual(fv.course.access, { isOwner: true, canEdit: true, canManage: true });
    assert.deepEqual([fv.progress.questions[q1].wrong, fv.progress.settings.exam.timeMin], [1, 5], 'progress and settings follow the fork');
    assert.equal((await ann('GET', `/api/courses/${fork.id}`)).status, 404, 'the fork is private');
    assert.equal((await bob('PATCH', `/api/courses/${fork.id}`, { name: 'Bank, fixed' })).status, 200);
    assert.equal((await bob('POST', `/api/courses/${fork.id}/import`, { content: JSON.stringify([{ stem: 'q3', answer: 'yes' }]) })).body.added, 1);
    assert.equal((await ann('GET', `/api/courses/${c.id}`)).body.course.questions.length, 2, 'the original is untouched');
    assert.equal((await bob('PATCH', `/api/courses/${fork.id}`, { visibility: 'public' })).status, 403, 'nor can bob publish his fork');
    store.updateCourse(fork.id, { visibility: 'public' });
    assert.equal((await ann('GET', '/api/courses')).body.find((x) => x.id === fork.id).owner.username, 'bob', 'a published fork shows up for everyone');
    assert.equal((await bob('POST', `/api/courses/${fork.id}/fork`, {})).body.id !== fork.id, true, 'forking your own course makes another copy');

    // ann takes hers private again: bob loses access, his progress stays for when it comes back
    assert.equal((await ann('PATCH', `/api/courses/${c.id}`, { visibility: 'private' })).status, 403, 'or take it down');
    store.updateCourse(c.id, { visibility: 'private' });
    assert.equal((await bob('GET', `/api/courses/${c.id}`)).status, 404);
    assert.ok(!(await bob('GET', '/api/sessions')).body.some((r) => r.courseId === c.id), "rounds of a course you can't see any more are not listed");
    store.updateCourse(c.id, { visibility: 'public' });
    assert.equal((await bob('GET', `/api/courses/${c.id}`)).body.progress.questions[q1].wrong, 1);

    // the admin (first account in this data dir) may take down anyone's public course, but not edit it
    const admin = await as('reparser');
    assert.equal((await admin('PATCH', `/api/courses/${fork.id}`, { name: 'nope' })).status, 403);
    assert.equal((await admin('PATCH', `/api/courses/${fork.id}`, { visibility: 'private' })).status, 200);
    assert.equal((await admin('GET', `/api/courses/${fork.id}`)).status, 404, 'and then it is private to its owner');

    // password change
    assert.equal((await ann('POST', '/api/auth/password', { current: 'wrong', password: 'newpass1' })).status, 403);
    assert.equal((await ann('POST', '/api/auth/password', { current: 'secret1', password: 'newpass1' })).status, 200);
    await as('ann', 'newpass1');
  } finally {
    server.close();
  }
});

test('reports: a learner reports a question from their fork, the owner fixes it and answers', async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, password = 'secret1') => {
    let res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (res.status === 401) res = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
  };
  try {
    const olga = await as('olga');
    const lena = await as('lena');
    const eve = await as('eve');
    const c = (await olga('POST', '/api/courses', { name: 'Report Bank' })).body;
    await olga('POST', `/api/courses/${c.id}/import`, { content: JSON.stringify([{ stem: 'Capital of France?', options: ['Paris', 'Rome'], answer: 'B' }]) });
    store.updateCourse(c.id, { visibility: 'public' });
    const own = (await olga('GET', `/api/courses/${c.id}`)).body.course;
    assert.equal(own.reportTo, null, 'nobody to report to in your own course');
    const qid = own.questions[0].id;

    // lena practises her fork; a report from it goes to olga's course
    const fork = (await lena('POST', `/api/courses/${c.id}/fork`, {})).body;
    await lena('POST', `/api/courses/${fork.id}/attempt`, { qid, correct: false });
    assert.deepEqual((await lena('GET', `/api/courses/${fork.id}`)).body.course.reportTo, { id: c.id, name: 'Report Bank', owner: { id: own.owner.id, username: 'olga' } });
    assert.deepEqual((await lena('GET', `/api/courses/${fork.id}/questions/${qid}/report`)).body, { target: { id: c.id, name: 'Report Bank', owner: { id: own.owner.id, username: 'olga' } }, exists: true, openId: null });
    assert.equal((await lena('POST', `/api/courses/${fork.id}/questions/${qid}/report`, { kind: 'answer', message: '  ' })).status, 400, 'an empty report');
    const sent = await lena('POST', `/api/courses/${fork.id}/questions/${qid}/report`, { kind: 'answer', message: 'The answer should be A (Paris)' });
    assert.equal(sent.status, 200);
    assert.deepEqual([sent.body.status, sent.body.role, sent.body.kind, sent.body.course.id], ['open', 'reporter', 'answer', c.id]);
    assert.equal((await lena('POST', `/api/courses/${fork.id}/questions/${qid}/report`, { message: 'again' })).status, 409, 'one open report per question');
    assert.equal((await eve('GET', `/api/reports/${sent.body.id}`)).status, 404, "someone else's report");
    assert.equal((await olga('POST', `/api/courses/${c.id}/questions/${qid}/report`, { message: 'x' })).status, 400, 'the owner fixes it instead');

    // olga sees it as new in her messages; opening it marks it read
    assert.equal((await olga('GET', '/api/reports/unread')).body.count, 1);
    const inbox = (await olga('GET', '/api/reports')).body;
    assert.deepEqual([inbox.received.length, inbox.received[0].reporter, inbox.received[0].unread, inbox.sent.length], [1, 'lena', true, 0]);
    const opened = (await olga('GET', `/api/reports/${sent.body.id}`)).body;
    assert.deepEqual([opened.role, opened.message, opened.question.id, opened.changed], ['owner', 'The answer should be A (Paris)', qid, false]);
    assert.equal((await olga('GET', '/api/reports/unread')).body.count, 0);
    assert.equal((await lena('PATCH', `/api/reports/${sent.body.id}`, { status: 'fixed' })).status, 403, 'only the owner answers');

    // she fixes the question (it gets a new id) and answers; the report follows the question
    const fixed = (await olga('POST', `/api/courses/${c.id}/questions/${qid}/reparse`, { content: 'Capital of France?\nA. Paris\nB. Rome\nC. Berlin\n答案：A', save: true })).body.question;
    assert.notEqual(fixed.id, qid);
    assert.equal((await olga('PATCH', `/api/reports/${sent.body.id}`, { status: 'nope' })).status, 400);
    const answered = (await olga('PATCH', `/api/reports/${sent.body.id}`, { status: 'fixed', reply: 'Thanks, fixed' })).body;
    assert.deepEqual([answered.status, answered.reply, answered.qid, answered.changed], ['fixed', 'Thanks, fixed', fixed.id, true]);

    // lena gets the answer, and can take the fixed version into her fork, keeping her progress
    assert.equal((await lena('GET', '/api/reports/unread')).body.count, 1);
    const back = (await lena('GET', `/api/reports/${sent.body.id}`)).body;
    assert.deepEqual([back.reply, back.status, back.canApply, back.fromCourse.id], ['Thanks, fixed', 'fixed', true, fork.id]);
    const applied = (await lena('POST', `/api/reports/${sent.body.id}/apply`)).body;
    assert.deepEqual([applied.courseId, applied.oldId, applied.question.id], [fork.id, qid, fixed.id]);
    const fv = (await lena('GET', `/api/courses/${fork.id}`)).body;
    assert.deepEqual([fv.course.questions.map((q) => q.id), fv.progress.questions[fixed.id].wrong], [[fixed.id], 1]);
    assert.equal((await lena('GET', `/api/reports/${sent.body.id}`)).body.canApply, false, 'up to date now');
    assert.equal((await lena('POST', `/api/reports/${sent.body.id}/apply`)).status, 409);
    assert.equal((await lena('GET', '/api/reports/unread')).body.count, 0);

    // a report on a question that changed upstream can't be sent; the reporter withdraws hers, the owner can't
    const other = (await lena('POST', `/api/courses/${fork.id}/import`, { content: JSON.stringify([{ stem: 'only in my copy', answer: 'x' }]) })).body;
    assert.equal(other.added, 1);
    const mineOnly = (await lena('GET', `/api/courses/${fork.id}`)).body.course.questions.find((q) => q.stem === 'only in my copy').id;
    assert.equal((await lena('POST', `/api/courses/${fork.id}/questions/${mineOnly}/report`, { message: 'hm' })).status, 409);
    assert.equal((await olga('DELETE', `/api/reports/${sent.body.id}`)).status, 403);
    assert.equal((await lena('DELETE', `/api/reports/${sent.body.id}`)).status, 200);
    assert.deepEqual((await olga('GET', '/api/reports')).body.received, []);
  } finally {
    server.close();
  }
});

test('fixing an answer key grades again what was answered: log, mistakes book, past sittings and rounds', () => {
  const c = store.createCourse({ name: 'Regrade Bank' });
  store.importQuestions(c.id, [
    { stem: 'Prompt of user mode?', options: ['switch>', 'switch#', 'switch', 'none'], answer: 'D' },
    { stem: 'Other question?', options: ['a', 'b'], answer: 'A' },
    { stem: 'Explain it.', type: 'short', answer: 'because' },
  ]);
  const [q, other, open] = store.getCourse(c.id).questions;
  const uid = 4242;
  // answered A (index 0): wrong by the old key, in a mock exam and once in practice
  store.recordAttempt(c.id, uid, { qid: q.id, correct: false, score: 0, response: 0, mode: 'exam' });
  store.recordAttempt(c.id, uid, { qid: other.id, correct: true, score: 1, response: 0, mode: 'exam' });
  store.recordAttempt(c.id, uid, { qid: open.id, correct: false, score: 0, response: 'dunno', mode: 'exam' });
  const entries = { [q.id]: { response: 0, submitted: true, result: { correct: false, score: 0 } }, [other.id]: { response: 0, submitted: true, result: { correct: true, score: 1 } },
    [open.id]: { response: 'dunno', submitted: true, selfGrade: 'wrong', result: { correct: false, score: 0 } } };
  const summary = scoreExam([q, other, open], { [q.id]: entries[q.id].result, [other.id]: entries[other.id].result, [open.id]: entries[open.id].result });
  const sat = store.recordExam(c.id, uid, { title: 'P', ...summary, detail: { qids: [q.id, other.id, open.id], entries, summary } });
  store.saveSession(c.id, uid, 'exam', { module: 'exam', qids: [q.id, other.id, open.id], entries, phase: 'done', summary: { ...summary, durationSec: 60 } });
  store.saveSession(c.id, uid, 'practice', { module: 'practice', qids: [q.id], entries: { [q.id]: { response: 0, submitted: true, result: { correct: false, score: 0 } } }, phase: 'answering' });
  assert.equal(store.getProgress(c.id, uid).exams[0].score, summary.score);
  assert.ok(store.inWrongBook(store.getProgress(c.id, uid).questions[q.id]));

  // the key is fixed to A (same stem and options: same id)
  store.patchQuestion(c.id, q.id, { answer: 0 });
  const p = store.getProgress(c.id, uid);
  assert.deepEqual([p.questions[q.id].correct, p.questions[q.id].wrong, p.questions[q.id].streak, p.questions[q.id].history], [1, 0, 1, [1]], 'the answer log and summary follow the key');
  assert.ok(!store.inWrongBook(p.questions[q.id]), 'out of the mistakes book');
  assert.equal(p.questions[open.id].wrong, 1, 'a self-graded written answer keeps its grade');
  const pts = summary.byType.single.maxScore / 2;
  assert.equal(p.exams[0].score, summary.score + pts, 'the sitting scores the point');
  const detail = store.examDetail(c.id, uid, sat.id);
  assert.deepEqual([detail.entries[q.id].result.correct, detail.summary.correct, detail.summary.score], [true, 2, summary.score + pts], 'its review shows it right');
  const rounds = store.getSessions(c.id, uid);
  assert.deepEqual([rounds.exam.entries[q.id].result.correct, rounds.exam.summary.score, rounds.exam.summary.durationSec], [true, summary.score + pts, 60], 'the finished round too, keeping its time');
  assert.equal(rounds.practice.entries[q.id].result.correct, true, 'and an answer in an unfinished round');

  // a fix that changes the question's id (an option edited): sittings and rounds follow it to the new id
  const fixed = normalizeQuestion({ stem: 'Prompt of user mode?', options: ['switch>', 'switch#', 'switch', 'none of these'], answer: 'B' });
  store.replaceQuestion(c.id, q.id, fixed);
  const d2 = store.examDetail(c.id, uid, sat.id);
  assert.deepEqual([d2.qids[0], d2.entries[fixed.id].result.correct, q.id in d2.entries], [fixed.id, false, false], 'the sitting points at the new id, graded by the new key');
  const r2 = store.getSessions(c.id, uid);
  assert.deepEqual([r2.exam.qids[0], r2.exam.entries[fixed.id]?.response, r2.practice.qids[0], fixed.id in r2.practice.entries], [fixed.id, 0, fixed.id, false], 'a finished round keeps the answer, an unfinished one asks again');
  assert.equal(store.getProgress(c.id, uid).questions[fixed.id].wrong, 1);
  store.deleteCourse(c.id);
});

test('course history: every change is listed with who made it; only for whoever may manage the course', async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, password = 'secret1') => {
    let res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (res.status === 401) res = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
  };
  try {
    const hana = await as('hana');
    const ivo = await as('ivo');
    const c = (await hana('POST', '/api/courses', { name: 'History Bank' })).body;
    await hana('POST', `/api/courses/${c.id}/import`, { content: JSON.stringify([{ stem: 'One?', options: ['a', 'b'], answer: 'A' }, { stem: 'Two?', options: ['a', 'b'], answer: 'B' }]), filename: 'paper.json' });
    await hana('PATCH', `/api/courses/${c.id}`, { name: 'History Bank 2', examDate: '2027-01-10' });
    const [one, two] = (await hana('GET', `/api/courses/${c.id}`)).body.course.questions;
    await hana('POST', `/api/courses/${c.id}/questions/${one.id}/reparse`, { content: 'One?\nA. a\nB. b\n答案：B', save: true });
    await hana('DELETE', `/api/courses/${c.id}/questions/${two.id}`);
    await hana('PUT', `/api/courses/${c.id}/settings`, { practice: { count: 20 } });
    await hana('PUT', `/api/courses/${c.id}/settings`, { practice: { count: 20 } }); // the same again: nothing changed
    await hana('PUT', `/api/courses/${c.id}/settings`, { practice: { count: 30 } }); // tweaked again soon after: the same entry
    store.updateCourse(c.id, { visibility: 'public' });

    const h = (await hana('GET', `/api/courses/${c.id}/history`)).body;
    assert.deepEqual(h.entries.map((e) => e.action).reverse(), ['created', 'import', 'details', 'question', 'question-deleted', 'settings', 'published']);
    assert.equal(h.total, 7);
    const by = Object.fromEntries(h.entries.map((e) => [e.action, e]));
    assert.deepEqual([by.import.by, by.import.summary], ['hana', 'Imported from paper.json: 2 added']);
    assert.deepEqual(by.details.detail.fields, { name: { before: 'History Bank', after: 'History Bank 2' }, examDate: { before: null, after: '2027-01-10' } });
    assert.deepEqual([by.question.detail.before.answer, by.question.detail.after.answer, by.question.summary], [0, 1, 'Edited a question: One?']);
    assert.equal(by['question-deleted'].detail.before.stem, 'Two?');
    assert.deepEqual([by.settings.detail.before.practice.count, by.settings.detail.after.practice.count], [0, 30], 'one settings entry, from the first state to the last');
    assert.equal(by.published.by, null, 'a change made outside the app has no one to name');
    assert.equal((await hana('GET', `/api/courses/${c.id}/history?limit=2&offset=6`)).body.entries.length, 1, 'a page at a time');

    // others: a public course's history isn't theirs, a private one doesn't exist; their own settings aren't logged
    await ivo('PUT', `/api/courses/${c.id}/settings`, { practice: { count: 50 } });
    assert.equal((await ivo('GET', `/api/courses/${c.id}/history`)).status, 403);
    assert.equal((await hana('GET', `/api/courses/${c.id}/history`)).body.total, 7);
    const fork = (await ivo('POST', `/api/courses/${c.id}/fork`, {})).body;
    assert.deepEqual((await ivo('GET', `/api/courses/${fork.id}/history`)).body.entries.map((e) => [e.action, e.by]), [['forked', 'ivo']], 'a fork starts its own history');
  } finally {
    server.close();
  }
});

test('owners: a public profile on the course page, and direct messages to them', async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, password = 'secret1') => {
    // register first: failed sign-ins count towards the throttle shared by the whole test run
    let res = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (res.status === 409) res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
  };
  try {
    const owen = await as('owen');
    const pia = await as('pia');
    const quin = await as('quin');
    const pub = (await owen('POST', '/api/courses', { name: 'Owen Public', description: 'Networks\nMore about it' })).body;
    await owen('POST', '/api/courses', { name: 'Owen Private' });
    store.updateCourse(pub.id, { visibility: 'public' });

    const prof = (await pia('GET', '/api/users/owen')).body;
    assert.deepEqual([prof.username, prof.courses.map((c) => [c.name, c.summary]), prof.canMessage, prof.isYou], ['owen', [['Owen Public', 'Networks']], true, false], 'public courses only');
    assert.ok(prof.memberSince);
    assert.equal((await owen('GET', '/api/users/owen')).body.isYou, true);
    assert.equal((await pia('GET', '/api/users/nobody')).status, 404);

    // pia writes about his course; quin (no public course) can't be written to out of the blue
    assert.equal((await pia('POST', '/api/messages/owen', { body: '  ' })).status, 400);
    assert.equal((await pia('POST', '/api/messages/pia', { body: 'me' })).status, 400, 'not to yourself');
    assert.equal((await owen('POST', '/api/messages/quin', { body: 'hi' })).status, 403);
    const sent = (await pia('POST', '/api/messages/owen', { body: 'Is question 3 right?', courseId: pub.id })).body;
    assert.deepEqual([sent.mine, sent.course, sent.read], [true, { id: pub.id, name: 'Owen Public' }, false]);
    assert.deepEqual((await owen('GET', '/api/inbox/unread')).body, { count: 1, reports: 0, messages: 1 });
    const convs = (await owen('GET', '/api/messages')).body;
    assert.deepEqual(convs.map((c) => [c.with, c.unread, c.last.body, c.last.mine]), [['pia', 1, 'Is question 3 right?', false]]);

    // owen opens it (read), and can answer pia although she has no course of her own
    const thread = (await owen('GET', '/api/messages/pia')).body;
    assert.deepEqual([thread.messages.length, thread.messages[0].mine, thread.canMessage], [1, false, true]);
    assert.equal((await owen('GET', '/api/inbox/unread')).body.count, 0, 'read once opened');
    assert.equal((await owen('POST', '/api/messages/pia', { body: 'Yes, checked' })).status, 200);
    const back = (await pia('GET', '/api/messages/owen')).body.messages;
    assert.deepEqual(back.map((m) => [m.mine, m.body, m.read]), [[true, 'Is question 3 right?', true], [false, 'Yes, checked', false]], 'she sees he read hers');
    assert.deepEqual((await quin('GET', '/api/messages')).body, [], "other people's conversations are not yours");
    assert.equal((await quin('GET', '/api/messages/owen')).body.messages.length, 0);
  } finally {
    server.close();
  }
});

test('migration: a database from before accounts keeps everything, published, for the first account', async () => {
  const { execFileSync } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-accounts-'));
  const old = new DatabaseSync(path.join(dir, 'exam.db'));
  old.exec(`
    CREATE TABLE courses (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', exam_date TEXT, settings TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE questions (course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, id TEXT NOT NULL, position INTEGER NOT NULL, type TEXT NOT NULL, chapter TEXT, data TEXT NOT NULL, raw TEXT, src_file TEXT, src_line INTEGER, PRIMARY KEY (course_id, id));
    CREATE TABLE attempts (id INTEGER PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, question_id TEXT NOT NULL, at TEXT NOT NULL, correct INTEGER NOT NULL, score REAL, response TEXT, mode TEXT);
    CREATE INDEX attempts_course_at ON attempts (course_id, at);
    CREATE TABLE question_state (course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, question_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, correct INTEGER NOT NULL DEFAULT 0, wrong INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0, last_at TEXT, last_wrong_at TEXT, last_score REAL, last_response TEXT, last_mode TEXT, history TEXT NOT NULL DEFAULT '[]', starred INTEGER NOT NULL DEFAULT 0, note TEXT, cleared INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (course_id, question_id));
    CREATE TABLE exams (id INTEGER PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, at TEXT NOT NULL, title TEXT, total INTEGER, score REAL, max_score REAL, correct INTEGER, duration_sec INTEGER, by_type TEXT);
    CREATE INDEX exams_course ON exams (course_id, at);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, kind TEXT, name TEXT, at TEXT, count INTEGER);
    CREATE TABLE sessions (course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, slot TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (course_id, slot));
    INSERT INTO courses VALUES ('old', 'Old', '', NULL, '{"exam":{"perType":{"single":1},"timeMin":9}}', '2026-01-01', '2026-01-01');
    INSERT INTO questions (course_id, id, position, type, data) VALUES ('old', 'q1', 1, 'single', '{"id":"q1","type":"single","stem":"s","options":["a","b"],"answer":0}');
    INSERT INTO attempts (course_id, question_id, at, correct) VALUES ('old', 'q1', '2026-01-02T00:00:00Z', 0);
    INSERT INTO question_state (course_id, question_id, attempts, wrong, starred) VALUES ('old', 'q1', 1, 1, 1);
    INSERT INTO exams (course_id, at, title, total, score, max_score, correct, duration_sec, by_type) VALUES ('old', '2026-01-03', 'P', 1, 0, 2, 0, 9, '{}');
    INSERT INTO sessions VALUES ('old', 'practice', '{"qids":["q1"]}', '2026-01-04');`);
  old.close();
  const script = `import * as s from ${JSON.stringify(new URL('../lib/store.mjs', import.meta.url).href)};
    s.conn();
    const u = s.createUser({ username: 'me', password: 'secret1' });
    const other = s.createUser({ username: 'you', password: 'secret1' });
    const c = s.courseAccess('old', u);
    const p = s.getProgress('old', u.id);
    console.log(JSON.stringify({ admin: u.isAdmin, otherAdmin: other.isAdmin, vis: c.row.visibility, owner: c.isOwner, q: p.questions.q1, exams: p.exams.length, sess: Object.keys(s.getSessions('old', u.id)),
      timeMin: p.settings.exam.timeMin, act: s.getActivity('old', u.id, { days: 400 }).reduce((a, d) => a + d.answers, 0), others: s.getProgress('old', other.id).questions }));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, EXAM_DATA_DIR: dir }, encoding: 'utf8' }).trim().split('\n');
  assert.match(out[0], /^Adding accounts to the database\. Backup first: .*exam-before-accounts-\d+\.db$/);
  const r = JSON.parse(out.at(-1));
  assert.deepEqual([r.admin, r.otherAdmin, r.vis, r.owner, r.q.wrong, r.q.starred, r.exams, r.sess, r.timeMin, r.act, r.others],
    [true, false, 'public', true, 1, true, 1, ['practice'], 9, 1, {}]);
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);
});

test('Google/GitHub sign-in: new account, same account next time, linking, forged state', async () => {
  const http = await import('node:http');
  const oauth = await import('../lib/oauth.mjs');
  // a fake GitHub: the code says which GitHub user signs in
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/token') {
        const code = new URLSearchParams(body).get('code');
        return res.end(JSON.stringify(code === 'bad' ? { error: 'bad_verification_code' } : { access_token: `tok-${code}` }));
      }
      const who = String(req.headers.authorization).replace('Bearer tok-', '');
      res.end(JSON.stringify({ id: { octo: 101, other: 202, ann: 303 }[who], login: who === 'octo' ? 'octo cat' : who, email: null }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const fakeBase = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(oauth.PROVIDERS.github, { tokenUrl: `${fakeBase}/token`, userUrl: `${fakeBase}/user` });
  process.env.GITHUB_CLIENT_ID = 'cid';
  process.env.GITHUB_CLIENT_SECRET = 'csecret';
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (url, cookie = '') => fetch(base + url, { redirect: 'manual', headers: { cookie } });
  const cookieOf = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) || '').split(';')[0];
  /** Run the whole round trip; returns the final redirect and the cookies it set. */
  const signInWith = async (code, { next = '/c/x', session = '', link = false, state } = {}) => {
    const start = await get(`/api/auth/oauth/github/start?next=${encodeURIComponent(next)}${link ? '&link=1' : ''}`, session);
    assert.equal(start.status, 302);
    const to = new URL(start.headers.get('location'));
    assert.equal(to.origin + to.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(to.searchParams.get('redirect_uri'), `${base}/api/auth/oauth/github/callback`);
    assert.equal(to.searchParams.get('client_id'), 'cid');
    const done = await get(`/api/auth/oauth/github/callback?code=${code}&state=${state ?? to.searchParams.get('state')}`, [session, cookieOf(start, 'ea_oauth')].filter(Boolean).join('; '));
    assert.equal(done.status, 302);
    return { location: done.headers.get('location'), session: cookieOf(done, 'ea_sid') };
  };
  const me = async (session) => (await (await get('/api/auth/me', session)).json());
  try {
    assert.deepEqual((await me()).providers, [{ id: 'github', label: 'GitHub' }], 'only configured providers are offered');

    const first = await signInWith('octo');
    assert.equal(first.location, '/#/c/x', 'back to where you were going');
    const octo = await me(first.session);
    assert.equal(octo.user.username, 'octo-cat', 'a new account named after the GitHub login');
    assert.deepEqual([octo.user.hasPassword, octo.identities[0].provider, octo.identities[0].login], [false, 'github', 'octo cat']);
    assert.equal((await me((await signInWith('octo')).session)).user.id, octo.user.id, 'the same GitHub user gets the same account');

    assert.match((await signInWith('octo', { state: 'forged' })).location, /^\/#\/login\?error=.*expired/, 'a state that was not issued here is refused');
    assert.match((await signInWith('bad')).location, /^\/#\/login\?error=GitHub%20refused/);
    assert.equal((await signInWith('octo', { next: '//evil.example' })).location, '/#/', 'next is a path in the app');

    // a password account links its GitHub, then signs in with it
    const ann = store.createUser({ username: 'gh-ann', password: 'secret1' });
    const annSession = `ea_sid=${store.createLogin(ann.id)}`;
    assert.equal((await signInWith('ann', { session: annSession, link: true })).location, '/#/account?linked=github');
    assert.equal((await me((await signInWith('ann')).session)).user.id, ann.id);
    assert.match((await signInWith('octo', { session: annSession, link: true })).location, /^\/#\/account\?error=.*already%20linked%20to%20another/, "someone else's GitHub can't be linked");

    // unlinking keeps at least one way in; a GitHub-only account sets a password first
    const call = (method, url, session, body) => fetch(base + url, { method, headers: { cookie: session, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    assert.equal((await call('DELETE', '/api/auth/identities/github', first.session)).status, 400);
    assert.equal((await call('POST', '/api/auth/password', first.session, { password: 'newpass1' })).status, 200, 'no current password to give');
    assert.equal((await call('DELETE', '/api/auth/identities/github', first.session)).status, 200);
    assert.equal(store.verifyUser('octo-cat', 'newpass1')?.id, octo.user.id);
    assert.notEqual((await me((await signInWith('octo')).session)).user.id, octo.user.id, 'once unlinked, that GitHub user gets a fresh account');

    process.env.GITHUB_PUBLIC_URL = 'http://localhost:8710';
    assert.deepEqual(oauth.enabledProviders('192.168.1.7:8710'), [], 'a provider registered at localhost is not offered on other addresses');
    assert.equal(oauth.enabledProviders('localhost:8710').length, 1, 'but is on this machine');
    assert.equal((await me()).providers.length, 1, '(127.0.0.1 is this machine too)');
    delete process.env.GITHUB_PUBLIC_URL;
    delete process.env.GITHUB_CLIENT_ID;
    assert.match((await get('/api/auth/oauth/github/start')).headers.get('location'), /error=.*not%20set%20up/);
  } finally {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.GITHUB_PUBLIC_URL;
    server.close();
    fake.close();
  }
});

test('a stray sign-in account folds into the real one', () => {
  const real = store.createUser({ username: 'merge-real', password: 'secret1' });
  const stray = store.createIdentityUser('github', { subject: 'merge-777', login: 'merge-stray' });
  const token = store.createLogin(stray.id);
  const busy = store.createIdentityUser('google', { subject: 'merge-888', login: 'merge-busy' });
  const c = store.createCourse({ name: 'Merge Busy', ownerId: busy.id });
  store.importQuestions(c.id, [{ stem: 'q', options: ['a', 'b'], answer: 'A' }]);
  store.recordAttempt(c.id, busy.id, { qid: store.getCourse(c.id).questions[0].id, correct: true });
  assert.throws(() => store.mergeAccount(busy.id, real.id), /own progress/, 'an account with progress is not merged');
  assert.throws(() => store.mergeAccount(real.id, real.id), /two different/);
  assert.deepEqual(store.mergeAccount(stray.id, real.id), { identities: 1, courses: 0, reports: 0, messages: 0 });
  assert.equal(store.userForIdentity('github', 'merge-777').id, real.id, 'its GitHub now signs in to the real account');
  assert.ok(!store.getUser(stray.id));
  assert.ok(!store.userForToken(token), 'and its sign-ins are gone');
});

test('pinning: your own courses only, per user, kept apart from study settings', async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, password = 'secret1') => {
    let res = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (res.status === 409) res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
  };
  try {
    const rae = await as('rae');
    const sol = await as('sol');
    const a = (await rae('POST', '/api/courses', { name: 'Rae A' })).body;
    const b = (await rae('POST', '/api/courses', { name: 'Rae B' })).body;
    store.updateCourse(b.id, { visibility: 'public' });
    const pinned = async (who) => Object.fromEntries((await who('GET', '/api/courses')).body.map((c) => [c.id, c.pinnedAt]));

    assert.equal((await pinned(rae))[a.id], null);
    const res = await rae('PUT', `/api/courses/${a.id}/pin`, { pinned: true });
    assert.equal(res.status, 200);
    assert.ok(res.body.pinnedAt);
    assert.equal((await pinned(rae))[a.id], res.body.pinnedAt);

    // saving study settings keeps the pin, and the pin doesn't replace the settings
    await rae('PUT', `/api/courses/${a.id}/settings`, { exam: { timeMin: 45 } });
    assert.ok((await pinned(rae))[a.id]);
    assert.equal(store.getProgress(a.id, (await rae('GET', '/api/auth/me')).body.user.id).settings.exam.timeMin, 45);

    // someone else's (public) course can't be pinned, and your pins aren't theirs
    assert.equal((await sol('PUT', `/api/courses/${b.id}/pin`, { pinned: true })).status, 403);
    assert.equal((await pinned(sol))[b.id], null);

    assert.equal((await rae('PUT', `/api/courses/${a.id}/pin`, { pinned: false })).body.pinnedAt, null);
    assert.equal((await pinned(rae))[a.id], null);
  } finally {
    server.close();
  }
});

test('mock exam answers left blank count as wrong: past sittings are logged once, starred or not', () => {
  const c = store.createCourse({ name: 'Blank Bank' });
  store.importQuestions(c.id, [
    { stem: 'Left blank?', options: ['a', 'b'], answer: 'A' },
    { stem: 'Explain the cache.', type: 'short', answer: 'sets and ways' },
    { stem: 'Answered right?', options: ['a', 'b'], answer: 'B' },
  ]);
  const [blank, essay, right] = store.getCourse(c.id).questions;
  const uid = 4343;
  store.setFlags(c.id, uid, { qid: essay.id, starred: true });
  store.recordAttempt(c.id, uid, { qid: right.id, correct: true, score: 1, response: 1, mode: 'exam' });
  const entries = {
    [blank.id]: { blank: true, submitted: true, result: { correct: false, score: 0 } },
    [essay.id]: { blank: true, submitted: true, result: { correct: false, score: 0 } },
    [right.id]: { response: 1, submitted: true, result: { correct: true, score: 1 } },
  };
  const finishedAt = Date.parse('2026-10-20T10:00:00Z');
  store.recordExam(c.id, uid, { title: 'P', total: 3, score: 1, detail: { qids: [blank.id, essay.id, right.id], entries, finishedAt } });

  assert.equal(store.logBlankExamAnswers({ dryRun: true }).filter((a) => a.course === c.id).length, 2);
  assert.ok(!store.inWrongBook(store.getProgress(c.id, uid).questions[essay.id]), 'a dry run changes nothing');
  assert.equal(store.logBlankExamAnswers().filter((a) => a.course === c.id).length, 2);
  const p = store.getProgress(c.id, uid).questions;
  assert.ok(store.inWrongBook(p[blank.id]) && store.inWrongBook(p[essay.id]), 'both blanks are in the mistakes book');
  assert.ok(p[essay.id].starred, 'and the star stays');
  assert.ok(!store.inWrongBook(p[right.id]));
  assert.equal(store.logBlankExamAnswers().filter((a) => a.course === c.id).length, 0, 'running it again adds nothing');
});
