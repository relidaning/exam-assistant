// Shared by the browser and Node (server-side normalization + tests). No DOM access here.

export const TYPES = ['single', 'multi', 'judge', 'fill', 'calc', 'short', 'essay', 'term'];

/** Open-ended types: typed freely, compared with a reference answer, graded by the student. */
export const isOpen = (type) => type === 'short' || type === 'essay' || type === 'term';

export const TYPE_LABELS = {
  single: 'Single choice',
  multi: 'Multiple choice',
  judge: 'True / False',
  fill: 'Fill in the blank',
  calc: 'Calculation',
  short: 'Short answer',
  essay: 'Essay',
  term: 'Definition',
};

export const LETTERS = 'ABCDEFGHIJKL';

// ---------- arithmetic expression evaluator (for calculation answers) ----------

const FUNCS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp,
  ln: Math.log, log: Math.log10, lg: Math.log10, log2: Math.log2, log10: Math.log10,
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
};
const CONSTS = { pi: Math.PI, 'π': Math.PI, e: Math.E };

function tokenize(src) {
  const s = src
    .replace(/[×✕·]/g, '*').replace(/÷/g, '/').replace(/−|–/g, '-')
    .replace(/（/g, '(').replace(/）/g, ')').replace(/，/g, ',').replace(/√/g, 'sqrt')
    .replace(/\*\*/g, '^');
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (num) { toks.push({ t: 'num', v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const id = /^(?:log2|log10|[a-zA-Zπ]+)/.exec(s.slice(i)); // digits only in log2/log10, so √9 → sqrt 9
    if (id) { toks.push({ t: 'id', v: id[0].toLowerCase() }); i += id[0].length; continue; }
    if ('+-*/^(),%!'.includes(c)) { toks.push({ t: c }); i++; continue; }
    throw new Error(`Unexpected "${c}"`);
  }
  return toks;
}

/** Evaluate a numeric expression like "2*pi*sqrt(2)/3", "1.5e3", "50%". Throws on invalid input. */
export function evaluate(expr) {
  if (typeof expr === 'number') return expr;
  const toks = tokenize(String(expr));
  let p = 0;
  const peek = () => toks[p];
  const take = (t) => { if (!toks[p] || toks[p].t !== t) throw new Error(`Expected ${t}`); return toks[p++]; };
  const startsPrimary = (tk) => tk && (tk.t === 'num' || tk.t === 'id' || tk.t === '(');

  function expression() {
    let v = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) v = take(peek().t).t === '+' ? v + term() : v - term();
    return v;
  }
  function term() {
    let v = unary();
    for (;;) {
      const tk = peek();
      if (tk && tk.t === '*') { p++; v *= unary(); }
      else if (tk && tk.t === '/') { p++; v /= unary(); }
      else if (startsPrimary(tk)) v *= power(); // implicit multiplication: 2pi, 3(4+1)
      else return v;
    }
  }
  function unary() {
    if (peek() && peek().t === '-') { p++; return -unary(); }
    if (peek() && peek().t === '+') { p++; return unary(); }
    return power();
  }
  function power() {
    const base = postfix();
    if (peek() && peek().t === '^') { p++; return Math.pow(base, unary()); }
    return base;
  }
  function postfix() {
    let v = primary();
    for (;;) {
      if (peek() && peek().t === '%') { p++; v /= 100; }
      else if (peek() && peek().t === '!') { p++; v = factorial(v); }
      else return v;
    }
  }
  function primary() {
    const tk = toks[p++];
    if (!tk) throw new Error('Unexpected end');
    if (tk.t === 'num') return tk.v;
    if (tk.t === '(') { const v = expression(); take(')'); return v; }
    if (tk.t === 'id') {
      if (tk.v in CONSTS) return CONSTS[tk.v];
      if (tk.v in FUNCS) {
        if (peek() && peek().t === '(') { p++; const v = expression(); take(')'); return FUNCS[tk.v](v); }
        return FUNCS[tk.v](power());
      }
      throw new Error(`Unknown "${tk.v}"`);
    }
    throw new Error(`Unexpected "${tk.t}"`);
  }
  const v = expression();
  if (p < toks.length) throw new Error('Trailing input');
  if (!Number.isFinite(v)) throw new Error('Not a finite number');
  return v;
}

function factorial(n) {
  if (n < 0 || !Number.isInteger(n) || n > 170) throw new Error('Bad factorial');
  let r = 1; for (let i = 2; i <= n; i++) r *= i; return r;
}

/** Parse a user's numeric answer, tolerating a trailing unit ("12.5 m/s") and thousands separators. */
export function parseNumeric(input, unit) {
  let s = String(input ?? '').trim();
  if (!s) return null;
  if (unit && s.toLowerCase().endsWith(unit.toLowerCase())) s = s.slice(0, -unit.length).trim();
  s = s.replace(/(\d),(?=\d{3}\b)/g, '$1');
  try { return evaluate(s); } catch { /* fall through */ }
  const lead = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(s);
  return lead ? parseFloat(lead[0]) : null;
}

// ---------- text normalization for fill-in answers ----------

export function normText(s) {
  return String(s ?? '')
    .normalize('NFKC') // full-width → half-width
    .toLowerCase()
    .replace(/[\s　]+/g, ' ')
    .replace(/^[\s.,;:。，；：、]+|[\s.,;:。，；：、]+$/g, '')
    .trim();
}

function textMatches(user, accepted) {
  const u = normText(user);
  if (!u) return false;
  for (const a of accepted) {
    const n = normText(a);
    if (u === n) return true;
    // ignore spaces and CJK punctuation/quotes inside the answer: "坚持和发展、怎样坚持" == "坚持和发展怎样坚持"
    // (after NFKC, full-width ，；： are already ASCII; "." and "-" stay significant: 0.5 ≠ 05, -sin x ≠ sin x)
    const loose = (x) => x.replace(/[\s、。“”‘’"'《》·,;:!?()]/g, '');
    if (loose(u) === loose(n)) return true;
    // "0.5" vs "1/2": compare numerically when both sides are pure numeric expressions
    const un = tryEval(u), an = tryEval(n);
    if (un !== null && an !== null && closeEnough(un, an, { rel: 1e-6 })) return true;
  }
  return false;
}

/**
 * Pair a fill question's blanks with its answer keys in whatever order gives the most right (each key used once).
 * Returns the key for each blank; a blank left unmatched gets one of the keys still owed, to show as its answer.
 */
function matchAnyOrder(resp, answer) {
  const n = answer.length, keyOf = Array(n).fill(-1), blankOf = Array(n).fill(-1);
  const assign = (b, seen) => { // augmenting path: take a free key, or move the blank that holds one elsewhere
    for (let k = 0; k < n; k++) {
      if (seen[k] || !textMatches(resp[b], answer[k])) continue;
      seen[k] = true;
      if (blankOf[k] < 0 || assign(blankOf[k], seen)) { blankOf[k] = b; keyOf[b] = k; return true; }
    }
    return false;
  };
  for (let b = 0; b < n; b++) assign(b, []);
  const owed = answer.map((_, k) => k).filter((k) => blankOf[k] < 0);
  return keyOf.map((k) => answer[k >= 0 ? k : owed.shift()]);
}

function tryEval(s) {
  try { return evaluate(s); } catch { return null; }
}

export function closeEnough(user, target, { tol, rel } = {}) {
  const absTol = tol ?? 0;
  const relTol = rel ?? (tol == null ? 0.01 : 0);
  return Math.abs(user - target) <= Math.max(absTol, Math.abs(target) * relTol, 1e-12);
}

// ---------- grading ----------

/**
 * Grade a response against a normalized question.
 * Returns { correct: boolean|null, score: 0..1, detail } — correct === null means it needs self-grading (short answer).
 */
export function grade(q, response) {
  switch (q.type) {
    case 'single': {
      const ok = response === q.answer;
      return { correct: ok, score: ok ? 1 : 0 };
    }
    case 'multi': {
      const picked = new Set(response || []);
      const want = new Set(q.answer);
      const wrongPick = [...picked].some((i) => !want.has(i));
      const hits = [...picked].filter((i) => want.has(i)).length;
      const ok = !wrongPick && hits === want.size;
      // partial credit: picked only correct options but not all of them
      const score = ok ? 1 : (!wrongPick && hits > 0 ? 0.5 : 0);
      return { correct: ok, score, detail: { partial: score === 0.5 } };
    }
    case 'judge': {
      const ok = response === q.answer;
      return { correct: ok, score: ok ? 1 : 0 };
    }
    case 'fill': {
      const resp = response || [];
      // any order: each blank is checked against the key it was matched with ("运算器 / 控制器" either way round)
      const keys = q.anyOrder ? matchAnyOrder(resp, q.answer) : q.answer;
      const blanks = keys.map((accepted, i) => textMatches(resp[i], accepted));
      const n = blanks.filter(Boolean).length;
      return { correct: n === blanks.length, score: blanks.length ? n / blanks.length : 0, detail: { blanks, ...(q.anyOrder ? { keys } : {}) } };
    }
    case 'calc': {
      const resp = response || [];
      const parts = q.answer.map((part, i) => {
        const v = parseNumeric(resp[i], part.unit);
        return { value: v, ok: v !== null && closeEnough(v, part.value, part) };
      });
      const n = parts.filter((x) => x.ok).length;
      return { correct: n === parts.length, score: parts.length ? n / parts.length : 0, detail: { parts } };
    }
    case 'short':
    case 'essay':
    case 'term': {
      const text = normText(response);
      const kws = q.keywords || [];
      const hit = kws.filter((k) => text.includes(normText(k)));
      return { correct: null, score: kws.length ? hit.length / kws.length : 0, detail: { keywordHits: hit } };
    }
    default:
      return { correct: false, score: 0 };
  }
}

/** True when the response is empty (nothing entered). */
export function isBlank(q, response) {
  if (response == null) return true;
  if (q.type === 'multi') return !response.length;
  if (q.type === 'fill' || q.type === 'calc') return !response.some((x) => String(x ?? '').trim());
  if (isOpen(q.type)) return !String(response).trim();
  return false;
}

/** Human-readable correct answer (plain text, may contain markdown/math). */
export function answerText(q) {
  switch (q.type) {
    case 'single': return LETTERS[q.answer];
    case 'multi': return q.answer.map((i) => LETTERS[i]).join('');
    case 'judge': return q.answer ? 'True' : 'False';
    case 'fill': return q.answer.map((alts) => alts.join(' / ')).join('; ') + (q.anyOrder && q.answer.length > 1 ? ' (any order)' : '');
    case 'calc': return q.answer.map((p) => `${p.label ? p.label + ' = ' : ''}${fmtNum(p.value)}${p.unit ? ' ' + p.unit : ''}`).join('; ');
    case 'short':
    case 'essay':
    case 'term': return q.answer;
    default: return '';
  }
}

export function fmtNum(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e9)) return v.toExponential(4);
  return String(parseFloat(v.toPrecision(8)));
}
