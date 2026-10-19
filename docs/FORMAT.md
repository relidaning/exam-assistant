# Question formats

Everything is normalized into one schema (`lib/normalize.mjs`). Input can be loose JSON or loose Markdown.

## Canonical question (JSON)

```jsonc
{
  "id": "6a08820cdad6",          // optional; default = stable hash of type+stem+options (re-imports update in place)
  "type": "single",              // single | multi | judge | fill | calc | short (aliases: 单选, 多选, 判断, 填空, 计算, 简答, mcq, tf, essay…)
  "stem": "Markdown, $math$, ![img](url)",
  "options": ["…", "…"],         // single / multi only (also accepts {"A": "...", "B": "..."})
  "answer": …,                    // see below
  "explanation": "Markdown",
  "chapter": "Chapter 1",
  "tags": ["2023", "final"],
  "difficulty": 3,               // 1–5
  "source": "2023 final, uni X website",
  "score": 4,                    // points in mock exams (default per type: 2/3/1/2/5/5)
  "keywords": ["…"],             // short answers: key points highlighted when self-grading
  "media": [{ "type": "image|audio|video|pdf", "src": "/media/<course>/file.png", "caption": "…" }]
}
```

| type | `answer` accepts | stored as |
|---|---|---|
| single | `"B"`, `"b"`, `1` (0-based index) | `1` |
| multi | `"AC"`, `"A,C"`, `"A、C"`, `[0,2]`, `["A","C"]` | `[0,2]` |
| judge | `true/false`, `T/F`, `对/错`, `√/×`, `正确/错误`, `yes/no` | `true` |
| fill | `"a; b"` (one per blank, `;` separated), alternatives with `\|`: `"1/x \| x^-1; 2"`, or `[["1/x","x^-1"],["2"]]` | `[["1/x","x^-1"],["2"]]` |
| calc | `"1/3"`, `"9.8 m/s^2"`, `"11.48 ± 0.05 m"`, `"100 ± 2%"`, `"x = 2; y = -1"`, `[{label, value, unit, tol, rel}]` | `[{"value":0.333…}]` |
| short | reference answer text (Markdown) | string |

Blanks in fill questions are `___` (3+ underscores) or cloze `{{answer|alt}}` (answer taken from the braces).
Calculation grading: absolute `tol`, relative `rel`, default ±1 % relative. Users may type expressions (`2*sqrt(2)`, `1/3`, `pi/4`, `1.2e-3`) and units.

A JSON file may be an array of questions or `{ "course": "...", "chapter": "...", "tags": "...", "questions": [...] }` (top-level fields become defaults).

## Markdown

```markdown
---
course: Linear Algebra        # informational
chapter: Ch 1                 # default chapter
tags: 2023, final
source: 2023 final paper
type: single                  # default type hint
---
# Chapter 2 · Determinants          ← H1 = chapter (unless it names a question type)

## 一、单项选择题                     ← a short heading naming a type = section type hint

1. Stem text, may span lines,
   include $math$ and ![[figure.png]]
A. option   B. option              ← options one per line or inline; "(A)" / "A、" / "A)" also fine
C. option   D. option
答案：B                              ← Answer / Ans / 答案 / 正确答案 / 参考答案
解析：…                              ← Explanation / Solution / 解析 / 详解 (multi-line until next field/question)

2. [多选] Checkbox style works too   ← inline type tag: [single] [multi] [判断] 【填空题】 …
- [x] right
- [ ] wrong
- [x] also right

## Question as a heading               ← H2+ headings start a question too
> [!answer] True                     ← Obsidian callouts / blockquotes work for answer & explanation
```

Other fields (one line each): `Type/题型`, `Tags/标签`, `Difficulty/难度`, `Source/来源`, `Chapter/章节`,
`Unit/单位`, `Tolerance/误差`, `Keywords/得分点/要点`, `Score/分值`.

Rules worth knowing:
- A numbered line at column 0 (`12.`, `12、`, `12)`) starts a new question. Inside a multi-line answer or explanation a
  numbered list `1. 2. 3.` stays in the answer; the next question number (current + 1) still starts a new question.
  When in doubt, use `##` headings for questions.
- Section type hints are soft: a question under "简答题" that has a `____` blank becomes a fill question.
- If no type is given it is inferred: options → single/multi (by answer letters), true/false answer → judge,
  blanks → fill, numeric answer → calc, otherwise short.
- `![[file.png]]` and relative `![](img/x.png)` are copied into `data/media/<course>/` on import. The CLI looks next to the
  file, in its parent, in `--vault` dirs and in the enclosing Obsidian vault (nearest `.obsidian` folder).
