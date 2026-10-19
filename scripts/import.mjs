#!/usr/bin/env node
// Import questions into a course bank from Markdown/JSON files (vault notes, crawled papers, hand-written lists).
//
//   node scripts/import.mjs --course "Linear Algebra" notes/la-ch1.md notes/la-ch2.md
//   node scripts/import.mjs --course la --dry-run bank.json
//   node scripts/import.mjs --course la --vault ~/vault --chapter "Ch 3" --tags final,2024 file.md
//   cat paper.md | node scripts/import.mjs --course la -
//
// Options:
//   --course <name|id>   target course (created if missing)            [required]
//   --description <txt>  description when creating the course
//   --chapter <name>     default chapter for questions without one
//   --type <type>        default question type (single|multi|judge|fill|calc|short)
//   --tags a,b           tags added to every imported question
//   --source <txt>       source label (e.g. "2023 final, uni website")
//   --vault <dir>        extra directory to search for embedded media (repeatable; the enclosing
//                        Obsidian vault of each file is searched automatically)
//   --replace            drop questions of the course that are not in this import
//   --dry-run            parse and report, write nothing
//   --json               print the normalized questions (with --dry-run)
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../lib/store.mjs';
import { detectFormat, parsePayload, localizeMedia, findVaultRoot } from '../lib/importer.mjs';
import { normalizeAll } from '../lib/normalize.mjs';

function parseArgs(argv) {
  const opts = { files: [], vault: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--course') opts.course = val();
    else if (a === '--description') opts.description = val();
    else if (a === '--chapter') opts.chapter = val();
    else if (a === '--type') opts.type = val();
    else if (a === '--tags') opts.tags = val();
    else if (a === '--source') opts.source = val();
    else if (a === '--vault') opts.vault.push(val());
    else if (a === '--replace') opts.replace = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts.files.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.course || !opts.files.length) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(opts.help ? 0 : 1);
}

const expand = (p) => p.replace(/^~(?=$|\/)/, process.env.HOME);
let course = null;
if (!opts.dryRun) {
  course = store.ensureCourse(opts.course);
  if (opts.description && !course.description) store.updateCourse(course.id, { description: opts.description });
}
const courseId = course?.id || store.slugify(opts.course);

let totals = { added: 0, updated: 0, unchanged: 0, removed: 0, errors: 0 };
const allRaw = [];
for (const f of opts.files) {
  const isStdin = f === '-';
  const file = isStdin ? null : path.resolve(expand(f));
  const content = isStdin ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  const format = detectFormat(content, file || '');
  const parsed = parsePayload(content, format);
  if (file) for (const q of parsed.questions) q._file = file; // remembered so a question can be re-parsed from its note later
  const vaultRoot = file ? findVaultRoot(path.dirname(file)) : null;
  const searchDirs = [...(file ? [path.dirname(file), path.dirname(path.dirname(file))] : []), ...opts.vault.map((v) => path.resolve(expand(v))), ...(vaultRoot ? [vaultRoot] : [])];
  const warnings = [...parsed.warnings];
  if (!opts.dryRun) warnings.push(...localizeMedia(parsed.questions, courseId, searchDirs));
  const defaults = {
    // questions without a chapter heading fall back to the file name ("la-ch3.md" → "la-ch3")
    chapter: opts.chapter || parsed.meta.chapter || (file ? path.basename(file).replace(/\.[^.]+$/, '') : undefined),
    type: opts.type || parsed.meta.type,
    tags: [opts.tags, parsed.meta.tags].filter(Boolean).join(','),
    source: opts.source || parsed.meta.source,
  };
  const label = isStdin ? '<stdin>' : path.relative(process.cwd(), file);
  if (opts.dryRun) {
    const { questions, errors } = normalizeAll(parsed.questions, defaults);
    const byType = {};
    for (const q of questions) byType[q.type] = (byType[q.type] || 0) + 1;
    console.log(`${label}: ${questions.length} ok ${JSON.stringify(byType)}, ${errors.length} errors`);
    for (const e of errors) console.log(`  ✗ #${e.index + 1} (line ${parsed.questions[e.index]?._line ?? '?'}) ${e.error} — "${e.stem}"`);
    for (const w of warnings) console.log(`  ! ${w}`);
    if (opts.json) allRaw.push(...questions);
    totals.errors += errors.length;
    continue;
  }
  if (opts.replace) allRaw.push({ parsed, defaults, label, warnings });
  else {
    const r = store.importQuestions(courseId, parsed.questions, { defaults, source: { kind: 'file', name: label } });
    report(label, r, parsed, warnings);
  }
}

if (opts.replace && !opts.dryRun) {
  // replace mode: import all files in one batch so questions from every file survive
  const raw = allRaw.flatMap(({ parsed, defaults }) => parsed.questions.map((q) => ({ ...defaults, ...q, tags: [defaults.tags, q.tags].filter(Boolean).join(',') })));
  const r = store.importQuestions(courseId, raw, { mode: 'replace', source: { kind: 'file', name: allRaw.map((x) => x.label).join(', ') } });
  report('all files (replace)', r, { questions: raw }, allRaw.flatMap((x) => x.warnings));
}

if (opts.dryRun && opts.json) console.log(JSON.stringify(allRaw, null, 2));
if (!opts.dryRun) console.log(`\nCourse "${courseId}": ${store.getCourse(courseId).questions.length} questions total. ${JSON.stringify(totals)}`);
process.exit(totals.errors && opts.dryRun ? 2 : 0);

function report(label, r, parsed, warnings) {
  console.log(`${label}: +${r.added} new, ${r.updated} updated, ${r.unchanged} unchanged${r.removed ? `, ${r.removed} removed` : ''}, ${r.errors.length} errors`);
  for (const e of r.errors) console.log(`  ✗ #${e.index + 1} (line ${parsed.questions[e.index]?._line ?? '?'}) ${e.error} — "${e.stem}"`);
  for (const w of warnings) console.log(`  ! ${w}`);
  for (const k of ['added', 'updated', 'unchanged', 'removed']) totals[k] += r[k];
  totals.errors += r.errors.length;
}
