// Turn an import payload (Markdown or JSON text, optionally from a file on disk) into raw questions,
// copying referenced local media (Obsidian embeds, relative images) into data/media/<course>/.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseMarkdown } from './parse-md.mjs';
import { MEDIA_DIR } from './store.mjs';

/** Nearest ancestor holding an Obsidian vault (".obsidian" dir), so ![[embeds]] resolve anywhere in the vault. */
export function findVaultRoot(dir) {
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.obsidian'))) return d;
  }
  return null;
}

/** Directories to resolve a source file's relative media against. */
export function mediaDirsFor(file) {
  if (!file) return [];
  const dir = path.dirname(file);
  return [dir, path.dirname(dir), findVaultRoot(dir)].filter(Boolean);
}

/** Character-bigram similarity of two stems (0..1), ignoring whitespace and punctuation. */
export function stemSimilarity(a, b) {
  const grams = (s) => {
    const t = String(s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, '');
    const out = new Map();
    for (let i = 0; i < t.length - 1; i++) out.set(t.slice(i, i + 2), (out.get(t.slice(i, i + 2)) || 0) + 1);
    return out;
  };
  const x = grams(a), y = grams(b);
  let common = 0, nx = 0, ny = 0;
  for (const v of x.values()) nx += v;
  for (const v of y.values()) ny += v;
  for (const [g, v] of x) common += Math.min(v, y.get(g) || 0);
  return nx + ny ? (2 * common) / (nx + ny) : 0;
}

/**
 * Re-read a question's source file and find the block that is (now) that question:
 * the most similar stem, preferring the original line when similarities tie. Returns { raw, line } or null.
 */
export function findInSourceFile(file, stem, line) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const { questions } = parseMarkdown(content);
  let best = null;
  for (const q of questions) {
    const score = stemSimilarity(stem, q.stem) - Math.abs((q._line || 0) - (line || 0)) / 1e6;
    if (!best || score > best.score) best = { score, raw: q._raw, line: q._line };
  }
  return best && best.score >= 0.5 ? { raw: best.raw, line: best.line } : null;
}

export function detectFormat(content, filename = '') {
  if (/\.json$/i.test(filename)) return 'json';
  if (/\.(md|markdown|txt)$/i.test(filename)) return 'md';
  const t = String(content).trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return 'md';
  try { JSON.parse(t); return 'json'; } catch { /* not valid JSON: still JSON when it is clearly shaped like it */ }
  // a broken JSON paste should say so; Markdown can start with "[" too: "[single] Which…", "[[note]]", "[link](…)"
  return t.startsWith('{') || /^\[\s*[[{"\]]/.test(t) && !t.startsWith('[[') ? 'json' : 'md';
}

/**
 * @returns {{ meta, questions: object[], warnings: string[] }}
 * JSON may be an array of questions or { course, chapter, tags, questions: [...] }.
 */
export function parsePayload(content, format) {
  if (format === 'json') {
    let data;
    try { data = JSON.parse(content); } catch (e) { throw Object.assign(new Error(`Invalid JSON: ${e.message}`), { status: 400 }); }
    if (Array.isArray(data)) return { meta: {}, questions: data, warnings: [] };
    const { questions = [], ...meta } = data;
    if (!Array.isArray(questions)) throw Object.assign(new Error('"questions" must be an array'), { status: 400 });
    return { meta, questions, warnings: [] };
  }
  return parseMarkdown(content);
}

const MD_IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * Rewrite local media references in all text fields to /media/<course>/<file>, copying files.
 * searchDirs: directories to resolve relative/bare names against (source file dir, vault root, attachments dir).
 */
export function localizeMedia(questions, courseId, searchDirs = []) {
  const warnings = [];
  const destDir = path.join(MEDIA_DIR(), courseId);
  const cache = new Map();

  const resolve = (ref) => {
    if (/^(https?:|data:|\/media\/)/i.test(ref)) return null;
    const rel = decodeURIComponent(ref);
    const candidates = [];
    if (path.isAbsolute(rel)) candidates.push(rel);
    for (const d of searchDirs) {
      candidates.push(path.join(d, rel));
      candidates.push(path.join(d, path.basename(rel)));
    }
    let found = candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
    if (!found) found = findByName(searchDirs, path.basename(rel));
    return found || false;
  };

  const copy = (ref) => {
    if (cache.has(ref)) return cache.get(ref);
    const src = resolve(ref);
    let out = ref;
    if (src) {
      const buf = fs.readFileSync(src);
      const hash = createHash('sha1').update(buf).digest('hex').slice(0, 8);
      const name = `${hash}-${path.basename(src).replace(/[^\w.\-一-龥]+/g, '_')}`;
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, name);
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
      out = `/media/${encodeURIComponent(courseId)}/${encodeURIComponent(name)}`;
    } else if (src === false) {
      warnings.push(`media not found: ${ref}`);
    }
    cache.set(ref, out);
    return out;
  };

  const fix = (text) => (typeof text === 'string'
    ? text.replace(MD_IMG_RE, (m, alt, ref) => `![${alt}](${copy(ref)})`)
    : text);

  for (const q of questions) {
    for (const k of ['stem', 'explanation', 'answer']) q[k] = fix(q[k]);
    if (Array.isArray(q.options)) q.options = q.options.map(fix);
    if (Array.isArray(q.media)) q.media = q.media.map((m) => (typeof m === 'string' ? copy(m) : { ...m, src: copy(m.src) }));
  }
  return warnings;
}

function findByName(dirs, name, maxDepth = 4) {
  for (const root of dirs) {
    const stack = [[root, 0]];
    while (stack.length) {
      const [d, depth] = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = path.join(d, e.name);
        if (e.isFile() && e.name === name) return p;
        if (e.isDirectory() && depth < maxDepth) stack.push([p, depth + 1]);
      }
    }
  }
  return null;
}
