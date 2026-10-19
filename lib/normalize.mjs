// Validate loose question input (hand-written JSON, parsed Markdown, crawled papers) into the canonical schema.
import { createHash } from 'node:crypto';
import { TYPES, LETTERS, evaluate } from '../public/js/grade.js';

const TYPE_ALIASES = {
  single: ['single', 'single-choice', 'choice', 'mcq', 'radio', '单选', '单选题', '单项选择题', '选择题', '单项选择'],
  multi: ['multi', 'multiple', 'multiple-choice', 'multi-choice', 'checkbox', '多选', '多选题', '多项选择题', '多项选择', '不定项选择题', '不定项'],
  judge: ['judge', 'tf', 'true-false', 'truefalse', 'boolean', 'bool', '判断', '判断题', '是非题'],
  fill: ['fill', 'blank', 'fill-in', 'fill-in-the-blank', 'cloze', '填空', '填空题'],
  calc: ['calc', 'calculation', 'numeric', 'number', 'compute', '计算', '计算题', '数值'],
  short: ['short', 'short-answer', 'open', 'text', 'proof', '简答', '简答题', '问答题', '证明题', '分析题', '综合题', '应用题'],
  term: ['term', 'definition', 'define', '名词解释', '名词解释题', '名词'],
  essay: ['essay', 'discussion', 'long-answer', '论述', '论述题', '材料题', '材料分析题', '材料分析', '分析论述题'],
};
const ALIAS_MAP = new Map();
for (const [t, list] of Object.entries(TYPE_ALIASES)) for (const a of list) ALIAS_MAP.set(a, t);

export function canonicalType(t) {
  if (!t) return null;
  const k = String(t).trim().toLowerCase().replace(/[\s_]+/g, '-');
  return ALIAS_MAP.get(k) || (TYPES.includes(k) ? k : null);
}

const TRUE_WORDS = ['true', 't', 'yes', 'y', 'right', 'correct', '对', '正确', '是', '√', '✓', '✔', 'v'];
const FALSE_WORDS = ['false', 'f', 'no', 'n', 'wrong', 'incorrect', '错', '错误', '否', '×', 'x', '✗', '✘'];

export function parseJudge(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase().replace(/[。.]$/, '');
  if (TRUE_WORDS.includes(s)) return true;
  if (FALSE_WORDS.includes(s)) return false;
  return null;
}

/** Judge answer with a reason attached: "错误, 错误原因：…" → { value: false, rest: "错误原因：…" } */
export function splitJudge(v) {
  const exact = parseJudge(v);
  if (exact !== null || typeof v !== 'string') return { value: exact, rest: '' };
  const m = /^\s*(对|错|正确|错误|√|×|✓|✗|true|false|T|F)\s*[.,，。;；:：、!！]\s*([\s\S]*)$/i.exec(v);
  return m ? { value: parseJudge(m[1]), rest: m[2].trim() } : { value: null, rest: '' };
}

/** "B", "b", "AC", "A,C", "A、C", 1, [0,2], ["A","C"] → array of option indices */
export function parseLetters(v, nOptions) {
  if (v == null) return [];
  if (typeof v === 'number') return [v];
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === 'number' ? [x] : parseLetters(x, nOptions)));
  const s = String(v).normalize('NFKC').toUpperCase().replace(/[\s,、;/|和及与.。()]+/g, '');
  if (/^\d+$/.test(s)) return s.length === 1 ? [Number(s) - 1] : []; // "2" → option B (1-based)
  const out = [];
  for (const ch of s) {
    const i = LETTERS.indexOf(ch);
    if (i < 0 || (nOptions && i >= nOptions)) return []; // not a pure letter list
    out.push(i);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  return evaluate(String(v).trim());
}

/** "12.5", "1/3", "9.8 m/s^2", "3.14±0.01", {value, tol, unit} → {label?, value, tol?, rel?, unit?} */
export function parseCalcPart(v) {
  if (v && typeof v === 'object') {
    const part = { value: toNumber(v.value ?? v.answer) };
    if (v.label) part.label = String(v.label);
    if (v.unit) part.unit = String(v.unit);
    if (v.tol != null || v.tolerance != null) part.tol = Math.abs(toNumber(v.tol ?? v.tolerance));
    if (v.rel != null) part.rel = Math.abs(toNumber(v.rel));
    return part;
  }
  let s = String(v).trim();
  const part = {};
  const lab = /^([A-Za-z一-龥][\w一-龥()（）']{0,12})\s*[=＝:：]\s*(.+)$/.exec(s);
  if (lab) { part.label = lab[1]; s = lab[2]; }
  const pm = /^(.*?)\s*(?:±|\+-|\+\/-)\s*([\d.eE+-]+)\s*(%?)\s*(.*)$/.exec(s);
  if (pm) {
    s = `${pm[1]} ${pm[4]}`.trim();
    if (pm[3]) part.rel = parseFloat(pm[2]) / 100; else part.tol = parseFloat(pm[2]);
  }
  try {
    part.value = evaluate(s);
  } catch {
    // split numeric expression from trailing unit: "9.8 m/s^2"
    const m = /^([-+]?[\d.\s*/^()eE+\-πpi√sqrt]+?)\s+([^\d\s].*)$/.exec(s);
    if (!m) throw new Error(`Cannot parse numeric answer "${v}"`);
    part.value = evaluate(m[1]);
    part.unit = m[2].trim();
  }
  return part;
}

function asStringList(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(/[,，;；]/).map((x) => x.trim()).filter(Boolean);
}

const BLANK_RE = /_{3,}|\{\{[^}]*\}\}/g;
const EMPTY_PAREN_RE = /[(（][\s\u3000]*[)）]/g; // "（ ）" — a blank in fill sections of Chinese papers
export function countBlanks(stem) {
  return (String(stem).match(BLANK_RE) || []).length;
}
const countParens = (stem) => (String(stem).match(EMPTY_PAREN_RE) || []).length;

/** Cloze syntax "Paris is the capital of {{France|french}}" → stem with ___ and the answers. */
function extractCloze(stem) {
  const answers = [];
  const out = stem.replace(/\{\{([^}]*)\}\}/g, (_, inner) => {
    if (inner.trim()) answers.push(inner.split('|').map((s) => s.trim()).filter(Boolean));
    else answers.push(null);
    return '____';
  });
  return { stem: out, answers };
}

function parseFillAnswer(v, nBlanks) {
  let list;
  if (Array.isArray(v)) list = v.map((x) => (Array.isArray(x) ? x.map(String) : String(x).split('|')));
  else {
    const s = String(v ?? '').trim();
    const parts = nBlanks > 1 ? s.split(/\s*[;；]\s*|\s*[，,]\s*(?=\S)/) : [s];
    list = parts.map((p) => p.split(/\s*\|\s*|\s+或\s+/));
  }
  return list.map((alts) => alts.map((a) => String(a).trim()).filter(Boolean));
}

/** Whether a hinted type (from a section heading or --type) is plausible for this question's shape. */
function fitsShape(type, raw) {
  const hasOpts = Array.isArray(raw.options) && raw.options.length >= 2;
  const blanks = countBlanks(raw.stem || '');
  switch (type) {
    case 'single': case 'multi': return hasOpts;
    case 'judge': return !hasOpts && splitJudge(raw.answer).value !== null;
    case 'fill': return !hasOpts && (blanks > 0 || countParens(raw.stem || '') > 0);
    case 'calc': {
      if (hasOpts || raw.answer == null || raw.answer === '') return false;
      try { (Array.isArray(raw.answer) ? raw.answer : String(raw.answer).split(/\s*[;；]\s*/)).forEach(parseCalcPart); return true; } catch { return false; }
    }
    case 'short':
    case 'essay':
    case 'term': return !hasOpts && !blanks;
    default: return false;
  }
}

/** Guess the type from shape when not given. */
export function inferType(raw) {
  const opts = raw.options;
  if (Array.isArray(opts) && opts.length) {
    if (Array.isArray(raw.answer) && raw.answer.length > 1) return 'multi';
    if (parseLetters(raw.answer, opts.length).length > 1) return 'multi';
    return 'single';
  }
  if (parseJudge(raw.answer) !== null && typeof raw.answer !== 'number') return 'judge';
  if (countBlanks(raw.stem || '')) return 'fill';
  if (raw.answer != null && raw.answer !== '') {
    const parts = Array.isArray(raw.answer) ? raw.answer : [raw.answer];
    try { parts.forEach(parseCalcPart); return 'calc'; } catch { /* not numeric */ }
  }
  return 'short';
}

function stableId(q) {
  const key = [q.type, q.stem.trim().replace(/\s+/g, ' '), ...(q.options || [])].join('␞');
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/**
 * Normalize one loose question. Returns the canonical question; throws Error with a message on invalid input.
 */
export function normalizeQuestion(raw, defaults = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Question must be an object');
  let stem = String(raw.stem ?? raw.question ?? raw.title ?? raw.q ?? '').trim();
  if (!stem) throw new Error('Missing stem');
  let options = raw.options ?? raw.choices;
  if (options && !Array.isArray(options)) {
    // {A: "...", B: "..."}
    options = Object.keys(options).sort().map((k) => options[k]);
  }
  if (options) options = options.map((o) => String(o).trim().replace(/^[A-L][.、．):）]\s*/, ''));
  let answer = raw.answer ?? raw.answers ?? raw.key;

  const cloze = /\{\{[^}]*\}\}/.test(stem) ? extractCloze(stem) : null;
  if (cloze) {
    stem = cloze.stem;
    if ((answer == null || answer === '') && cloze.answers.every(Boolean)) answer = cloze.answers;
  }

  const shape = { ...raw, stem, options, answer };
  const hint = [raw.typeHint, defaults.type].map(canonicalType).find((t) => t && fitsShape(t, shape));
  const explicit = canonicalType(raw.type);
  const type = explicit || hint || inferType(shape);
  const q = { id: raw.id ? String(raw.id) : undefined, type, stem };
  let extraExplanation = '';

  switch (type) {
    case 'single':
    case 'multi': {
      if (!options || options.length < 2) throw new Error('Choice question needs at least 2 options');
      q.options = options;
      const idx = parseLetters(answer, options.length);
      if (!idx.length) throw new Error(`Choice answer "${answer}" is not option letters`);
      if (type === 'single' && idx.length !== 1) {
        q.type = 'multi';
      }
      q.answer = q.type === 'single' ? idx[0] : idx;
      break;
    }
    case 'judge': {
      const { value, rest } = splitJudge(answer);
      if (value === null) throw new Error(`True/false answer "${answer}" not recognized`);
      q.answer = value;
      extraExplanation = rest;
      break;
    }
    case 'fill': {
      if (!countBlanks(stem) && countParens(stem)) q.stem = stem = stem.replace(EMPTY_PAREN_RE, '____');
      let n = countBlanks(stem);
      const ans = parseFillAnswer(answer, n);
      if (!ans.length || ans.some((a) => !a.length)) throw new Error('Fill question needs an answer per blank');
      if (n === 0) { q.stem = stem + '\n\n____'; n = 1; }
      if (ans.length === n) q.answer = ans;
      else if (n === 1) q.answer = [ans.flat()];
      else if (!explicit) {
        // blanks and answers don't line up (e.g. one combined answer for two "（ ）"): keep it as a self-graded question
        q.type = 'short';
        q.stem = stem;
        q.answer = String(answer).trim();
      } else throw new Error(`Fill question has ${n} blanks but ${ans.length} answers`);
      break;
    }
    case 'calc': {
      if (answer == null || answer === '') throw new Error('Calculation needs a numeric answer');
      const parts = (Array.isArray(answer) ? answer : String(answer).split(/\s*[;；]\s*/)).map(parseCalcPart);
      if (raw.unit && parts.length === 1 && !parts[0].unit) parts[0].unit = String(raw.unit);
      const tol = raw.tol ?? raw.tolerance;
      if (tol != null) for (const p of parts) if (p.tol == null) p.tol = Math.abs(toNumber(tol));
      q.answer = parts;
      break;
    }
    case 'short':
    case 'essay':
    case 'term': {
      q.answer = String(answer ?? '').trim() || '(no reference answer)';
      const kw = asStringList(raw.keywords ?? raw.points);
      if (kw.length) q.keywords = kw;
      break;
    }
  }

  const explanation = [extraExplanation, raw.explanation ?? raw.analysis ?? raw.solution].filter(Boolean).join('\n\n');
  if (explanation) q.explanation = String(explanation).trim();
  const chapter = raw.chapter ?? defaults.chapter;
  if (chapter) q.chapter = String(chapter).trim();
  const tags = [...new Set([...asStringList(defaults.tags), ...asStringList(raw.tags)])];
  if (tags.length) q.tags = tags;
  const diff = Number(raw.difficulty);
  if (diff >= 1 && diff <= 5) q.difficulty = Math.round(diff);
  const source = raw.source ?? defaults.source;
  if (source) q.source = String(source).trim();
  if (raw.score != null && Number(raw.score) > 0) q.score = Number(raw.score);
  if (Array.isArray(raw.media) && raw.media.length) {
    q.media = raw.media.map((m) => (typeof m === 'string' ? { src: m } : m)).filter((m) => m && m.src)
      .map((m) => ({ type: m.type || mediaType(m.src), src: String(m.src), ...(m.caption ? { caption: String(m.caption) } : {}) }));
  }
  q.id = q.id || stableId(q);
  return q;
}

export function mediaType(src) {
  const ext = String(src).split('?')[0].split('.').pop().toLowerCase();
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) return 'video';
  if (ext === 'pdf') return 'pdf';
  return 'image';
}

/** Normalize a list; collects per-question errors instead of failing the whole batch. */
export function normalizeAll(list, defaults = {}) {
  const questions = [];
  const errors = [];
  list.forEach((raw, i) => {
    try {
      questions.push(normalizeQuestion(raw, defaults));
    } catch (e) {
      const stem = String(raw?.stem ?? raw?.question ?? '').slice(0, 60);
      errors.push({ index: i, stem, error: e.message });
    }
  });
  return { questions, errors };
}
