// Exam Assistant server: JSON API + static SPA. No framework; Node >= 20.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.mjs';
import { detectFormat, parsePayload, localizeMedia, mediaDirsFor, findInSourceFile } from './lib/importer.mjs';
import { normalizeAll, normalizeQuestion } from './lib/normalize.mjs';
import { toMarkdown } from './lib/tomd.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8710);
const HOST = process.env.HOST || '0.0.0.0';

const STATIC = [
  ['/vendor/katex/', path.join(ROOT, 'node_modules/katex/dist/')],
  ['/vendor/marked/', path.join(ROOT, 'node_modules/marked/lib/')],
  ['/vendor/dompurify/', path.join(ROOT, 'node_modules/dompurify/dist/')],
  ['/media/', null], // resolved at request time (DATA_DIR may be overridden)
  ['/', path.join(ROOT, 'public/')],
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/opus',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.ogv': 'video/ogg',
  '.pdf': 'application/pdf', '.map': 'application/json',
};

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

async function readBody(req, limit = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw store.httpError(413, 'Body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw store.httpError(400, 'Invalid JSON body'); }
}

function serveStatic(req, res, pathname) {
  for (const [prefix, dir0] of STATIC) {
    if (!pathname.startsWith(prefix)) continue;
    const dir = dir0 ?? store.MEDIA_DIR() + path.sep;
    let rel;
    try { rel = decodeURIComponent(pathname.slice(prefix.length)); } catch { return send(res, 400, 'Bad path'); }
    const file = path.resolve(dir, rel || 'index.html');
    if (!file.startsWith(path.resolve(dir))) return send(res, 403, 'Forbidden');
    let stat;
    try { stat = fs.statSync(file); } catch { stat = null; }
    if (!stat || !stat.isFile()) {
      if (prefix === '/' && !path.extname(rel)) return serveFile(req, res, path.join(ROOT, 'public/index.html')); // SPA fallback
      return send(res, 404, 'Not found');
    }
    return serveFile(req, res, file, stat);
  }
  send(res, 404, 'Not found');
}

function serveFile(req, res, file, stat = fs.statSync(file)) {
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': file.includes('node_modules') ? 'max-age=86400' : 'no-cache' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) { // audio/video seeking on mobile Safari needs ranges
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) return send(res, 416, 'Range not satisfiable', { 'content-range': `bytes */${stat.size}` });
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function preparseImport(body, courseId) {
  const content = String(body.content ?? '');
  if (!content.trim()) throw store.httpError(400, 'Nothing to import');
  const format = body.format && body.format !== 'auto' ? body.format : detectFormat(content, body.filename);
  const parsed = parsePayload(content, format);
  const warnings = [...parsed.warnings];
  if (courseId) warnings.push(...localizeMedia(parsed.questions, courseId, []));
  const defaults = { chapter: body.chapter || parsed.meta.chapter, tags: body.tags || parsed.meta.tags, source: body.source || parsed.meta.source, type: body.type || parsed.meta.type };
  return { format, parsed, warnings, defaults };
}

const routes = [
  ['GET', /^\/api\/courses$/, () => store.listCourses()],
  ['POST', /^\/api\/courses$/, async (req) => store.createCourse(await readBody(req))],
  ['GET', /^\/api\/courses\/([^/]+)$/, (req, [id]) => {
    const course = store.getCourse(id);
    const progress = store.getProgress(id);
    return { course, progress, stats: store.courseStats(course, progress), masteryStreak: store.MASTERY_STREAK, sessions: store.getSessions(id) };
  }],
  // unfinished rounds, shared by every browser and device
  ['GET', /^\/api\/courses\/([^/]+)\/sessions$/, (req, [id]) => store.getSessions(id)],
  ['PUT', /^\/api\/courses\/([^/]+)\/sessions\/([^/]+)$/, async (req, [id, slot]) => store.saveSession(id, slot, await readBody(req))],
  ['DELETE', /^\/api\/courses\/([^/]+)\/sessions\/([^/]+)$/, (req, [id, slot]) => { store.deleteSession(id, slot); return { ok: true }; }],
  ['DELETE', /^\/api\/courses\/([^/]+)\/sessions$/, (req, [id]) => { store.deleteSession(id); return { ok: true }; }],
  ['PATCH', /^\/api\/courses\/([^/]+)$/, async (req, [id]) => store.updateCourse(id, await readBody(req))],
  ['DELETE', /^\/api\/courses\/([^/]+)$/, (req, [id]) => { store.deleteCourse(id); return { ok: true }; }],
  ['GET', /^\/api\/courses\/([^/]+)\/export$/, (req, [id]) => store.getCourse(id)],
  ['GET', /^\/api\/courses\/([^/]+)\/activity$/, (req, [id]) => {
    const q = new URL(req.url, 'http://x').searchParams;
    return store.getActivity(id, { days: Number(q.get('days')) || 30, tzMinutes: Number(q.get('tz')) || 0 });
  }],
  ['POST', /^\/api\/import\/preview$/, async (req) => {
    const body = await readBody(req);
    const { format, parsed, warnings, defaults } = preparseImport(body, null);
    const { questions, errors } = normalizeAll(parsed.questions, defaults);
    return { format, meta: parsed.meta, questions, errors, warnings };
  }],
  ['POST', /^\/api\/courses\/([^/]+)\/import$/, async (req, [id]) => {
    const body = await readBody(req);
    store.getCourse(id);
    const { format, parsed, warnings, defaults } = preparseImport(body, id);
    const result = store.importQuestions(id, parsed.questions, {
      mode: body.mode, defaults, source: { kind: body.sourceKind || 'paste', name: body.filename || body.source || format },
    });
    return { ...result, warnings };
  }],
  // where a question came from: its stored source text (or one rebuilt from the question) and, if its note
  // still exists, the note's current version of it
  ['GET', /^\/api\/courses\/([^/]+)\/questions\/([^/]+)\/source$/, (req, [id, qid]) => {
    const src = store.getQuestionSource(id, qid);
    const fromFile = src.file ? findInSourceFile(src.file, src.question.stem, src.line) : null;
    return {
      question: src.question, raw: src.raw || toMarkdown(src.question), generated: !src.raw,
      file: src.file, fileName: src.file ? path.basename(src.file) : null, line: src.line,
      fileExists: src.file ? fs.existsSync(src.file) : false, fromFile,
    };
  }],
  // re-parse edited source text: preview (save: false) or replace the question (save: true), keeping its progress
  ['POST', /^\/api\/courses\/([^/]+)\/questions\/([^/]+)\/reparse$/, async (req, [id, qid]) => {
    const body = await readBody(req);
    const old = store.getQuestionSource(id, qid);
    const content = String(body.content ?? '');
    if (!content.trim()) throw store.httpError(400, 'The source text is empty');
    const parsed = parsePayload(content, detectFormat(content));
    const raw = parsed.questions[0];
    if (!raw) throw store.httpError(400, 'No question found in the text');
    const warnings = parsed.questions.length > 1 ? [`Found ${parsed.questions.length} questions; only the first is used`] : [];
    // resolve images for the preview too (copies are content-addressed, so this is idempotent)
    warnings.push(...localizeMedia([raw], id, mediaDirsFor(old.file)));
    const defaults = { type: body.type || undefined, chapter: old.question.chapter, tags: old.question.tags, source: old.question.source };
    let q;
    try { q = normalizeQuestion(raw, defaults); } catch (e) {
      if (body.save) throw store.httpError(400, e.message);
      return { error: e.message, warnings };
    }
    if (old.question.difficulty && !q.difficulty) q.difficulty = old.question.difficulty;
    if (!body.save) return { question: q, warnings };
    const saved = store.replaceQuestion(id, qid, q, { raw: content, line: body.line ?? null });
    return { question: saved, oldId: qid, warnings };
  }],
  ['DELETE', /^\/api\/courses\/([^/]+)\/questions\/([^/]+)$/, (req, [id, qid]) => { store.deleteQuestion(id, qid); return { ok: true }; }],
  ['POST', /^\/api\/courses\/([^/]+)\/attempt$/, async (req, [id]) => store.recordAttempt(id, await readBody(req))],
  ['POST', /^\/api\/courses\/([^/]+)\/flag$/, async (req, [id]) => store.setFlags(id, await readBody(req))],
  ['POST', /^\/api\/courses\/([^/]+)\/exam$/, async (req, [id]) => store.recordExam(id, await readBody(req))],
  ['PUT', /^\/api\/courses\/([^/]+)\/settings$/, async (req, [id]) => store.setSettings(id, await readBody(req))],
  ['POST', /^\/api\/courses\/([^/]+)\/reset-progress$/, (req, [id]) => { store.resetProgress(id); return { ok: true }; }],
];

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/')) {
        for (const [method, re, handler] of routes) {
          const m = re.exec(pathname);
          if (m && method === req.method) {
            const out = await handler(req, m.slice(1).map(decodeURIComponent));
            return send(res, 200, out);
          }
        }
        return send(res, 404, { error: 'No such endpoint' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      serveStatic(req, res, pathname);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      send(res, status, { error: e.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  store.conn(); // open (and migrate) before the first request
  createServer().listen(PORT, HOST, () => {
    console.log(`Exam Assistant on http://localhost:${PORT}`);
    for (const ifs of Object.values(os.networkInterfaces())) {
      for (const a of ifs || []) if (a.family === 'IPv4' && !a.internal) console.log(`  on your network: http://${a.address}:${PORT}`);
    }
    console.log(`  data: ${store.DB_FILE()}`);
  });
}
