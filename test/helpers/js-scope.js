/**
 * Working out how deeply nested a declaration is, in a script we cannot import.
 *
 * The console is one HTML file with a module inside it, so there is nothing to
 * import and nothing to lint. `node --check` catches syntax and stops there —
 * it will happily accept a helper declared inside one function and called from
 * another, which is a `ReferenceError` the moment somebody clicks the button
 * and not a moment before.
 *
 * So this counts braces, which needs the parts of the source that merely
 * contain braces to be removed first: comments, strings, template literals and
 * regular expressions.
 */

/**
 * Blanks out everything that is not code, preserving newlines and length.
 *
 * Replacing rather than deleting keeps offsets intact, so a position in the
 * result is the same position in the original.
 * @param {string} source - JavaScript source.
 * @returns {string} - The same source with literals and comments blanked.
 */
export function stripLiterals(source) {
  const out = [...source];
  let index = 0;

  /** Characters after which a `/` starts a regular expression rather than dividing. */
  const beforeRegex = /[(,=:[!&|?{};+\-*%^~<>]$/;

  const blank = (from, to) => {
    for (let at = from; at < to && at < out.length; at++) {
      if (out[at] !== '\n') out[at] = ' ';
    }
  };

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      blank(index, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
      continue;
    }

    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      blank(index, end === -1 ? source.length : end + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }

    if (character === '"' || character === "'") {
      let at = index + 1;
      while (at < source.length && source[at] !== character) {
        at += source[at] === '\\' ? 2 : 1;
      }
      blank(index, at + 1);
      index = at + 1;
      continue;
    }

    if (character === '`') {
      // Template literals nest: `${ `${x}` }` is legal, and the braces of an
      // interpolation are code that happens to sit inside a string.
      let at = index + 1;
      let depth = 0;
      while (at < source.length) {
        if (source[at] === '\\') {
          at += 2;
          continue;
        }
        if (depth === 0 && source[at] === '`') break;
        if (source[at] === '$' && source[at + 1] === '{') {
          depth += 1;
          at += 2;
          continue;
        }
        if (depth > 0 && source[at] === '}') depth -= 1;
        at += 1;
      }
      // Only the literal text is blanked; interpolations are left as code,
      // which is what makes a `${}` containing a function still countable.
      let cursor = index + 1;
      let inner = 0;
      for (let scan = index + 1; scan <= at; scan++) {
        if (source[scan] === '$' && source[scan + 1] === '{' && inner === 0) {
          blank(cursor, scan);
          inner = 1;
          scan += 1;
          continue;
        }
        if (inner > 0) {
          if (source[scan] === '{') inner += 1;
          if (source[scan] === '}') {
            inner -= 1;
            if (inner === 0) cursor = scan + 1;
          }
        }
      }
      if (inner === 0) blank(cursor, at + 1);
      index = at + 1;
      continue;
    }

    if (character === '/') {
      const before = source.slice(0, index).trimEnd();
      if (beforeRegex.test(before) || before === '') {
        let at = index + 1;
        let inClass = false;
        while (at < source.length) {
          if (source[at] === '\\') {
            at += 2;
            continue;
          }
          if (source[at] === '[') inClass = true;
          else if (source[at] === ']') inClass = false;
          else if (source[at] === '/' && !inClass) break;
          else if (source[at] === '\n') break;
          at += 1;
        }
        blank(index, at + 1);
        index = at + 1;
        continue;
      }
    }

    index += 1;
  }

  return out.join('');
}

/**
 * The brace depth at which each named function is declared.
 *
 * Depth 0 is the top level of the script, which is where anything called from
 * more than one place has to be.
 * @param {string} source - JavaScript source.
 * @returns {Map<string, number>} - Function name to depth.
 */
export function declarationDepths(source) {
  const code = stripLiterals(source);
  const depths = new Map();
  let depth = 0;

  const pattern =
    // eslint-disable-next-line security/detect-unsafe-regex -- the classes do not overlap, so each character has one place to go
    /(?:^|[^.\w])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  const positions = [...code.matchAll(pattern)].map((match) => ({
    name: match[1],
    at: match.index,
  }));

  let cursor = 0;
  for (const { name, at } of positions) {
    for (; cursor < at; cursor++) {
      if (code[cursor] === '{') depth += 1;
      else if (code[cursor] === '}') depth -= 1;
    }
    if (!depths.has(name)) depths.set(name, depth);
  }

  return depths;
}

/**
 * Top-level statements that call a `const` helper declared further down.
 *
 * `node --check` accepts this, and so does a scope check: the name exists and
 * is reachable from where it is called. It is a temporal dead zone error,
 * thrown the moment the script runs — which for a single-file console means the
 * whole page dies before drawing anything, leaving one line in the browser's
 * console and a blank screen.
 *
 * Only depth-zero calls count. A call inside a function body is fine however
 * far above the declaration it sits, because it does not run until something
 * invokes it — which is the whole difference between this and a scope check.
 * @param {string} source - JavaScript source.
 * @returns {Array<object>} - `{ name, calledAt, declaredAt }` for each offender.
 */
export function useBeforeDeclaration(source) {
  const code = stripLiterals(source);

  /**
   * Walks the brace depth forward to an offset, from wherever it was.
   * @param {object} state - `{ cursor, depth }`, advanced in place.
   * @param {number} to - Offset to stop at.
   * @returns {number} - The depth there.
   */
  const depthAt = (state, to) => {
    for (; state.cursor < to; state.cursor += 1) {
      if (code[state.cursor] === '{') state.depth += 1;
      else if (code[state.cursor] === '}') state.depth -= 1;
    }
    return state.depth;
  };

  const declared = new Map();
  const walk = { cursor: 0, depth: 0 };
  const declaration = /(?:^|\n)\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g;
  for (const match of code.matchAll(declaration)) {
    if (depthAt(walk, match.index) !== 0) continue;
    if (!declared.has(match[1])) declared.set(match[1], match.index);
  }

  const offenders = [];
  const second = { cursor: 0, depth: 0 };
  const call = /(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of code.matchAll(call)) {
    if (depthAt(second, match.index) !== 0) continue;
    const declaredAt = declared.get(match[1]);
    if (declaredAt !== undefined && match.index < declaredAt) {
      offenders.push({ name: match[1], calledAt: match.index, declaredAt });
    }
  }
  return offenders;
}
