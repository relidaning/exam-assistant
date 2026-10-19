// Canonical question → Markdown in the importer's own format, so it re-parses to the same question.
// Used when a question has no stored source text (e.g. imported from JSON) and someone wants to re-parse it.
import { LETTERS } from '../public/js/grade.js';

function calcPart(p) {
  let s = `${p.label ? `${p.label} = ` : ''}${p.value}`;
  if (p.tol) s += ` ± ${p.tol}`;
  else if (p.rel) s += ` ± ${p.rel * 100}%`;
  if (p.unit) s += ` ${p.unit}`;
  return s;
}

export function toMarkdown(q) {
  const lines = [`[${q.type}] ${q.stem}`];
  if (q.options) q.options.forEach((o, i) => lines.push(`${LETTERS[i]}. ${o}`));
  switch (q.type) {
    case 'single': lines.push(`Answer: ${LETTERS[q.answer]}`); break;
    case 'multi': lines.push(`Answer: ${q.answer.map((i) => LETTERS[i]).join('')}`); break;
    case 'judge': lines.push(`Answer: ${q.answer ? 'True' : 'False'}`); break;
    case 'fill': lines.push(`Answer: ${q.answer.map((alts) => alts.join(' | ')).join('; ')}`); break;
    case 'calc': lines.push(`Answer: ${q.answer.map(calcPart).join('; ')}`); break;
    case 'short':
    case 'essay':
    case 'term': lines.push('Answer:', q.answer); break;
  }
  if (q.keywords?.length) lines.push(`Keywords: ${q.keywords.join(', ')}`);
  if (q.explanation) lines.push(`Explanation: ${q.explanation}`);
  return lines.join('\n');
}
