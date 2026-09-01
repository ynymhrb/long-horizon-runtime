/**
 * Minimal deterministic YAML-subset parser for long-task validation scenarios.
 *
 * The handbook allows scenarios as versioned YAML or JSON. This repository has
 * no YAML dependency and the runner tooling must not modify dependency
 * manifests, so this parser implements exactly the YAML subset used by the
 * scenario contract:
 *
 *   - block mappings (`key: value`, `key:` + nested block)
 *   - block sequences (`- scalar`, `- key: value` inline-map entries, nested blocks)
 *   - flow scalars in brackets (`[a, b, "c"]`) and empty `[]`
 *   - plain scalars with multi-line folding (continuation lines fold with one space)
 *   - single- and double-quoted scalars (with the usual escapes for double quotes)
 *   - literal `|` and folded `>` block scalars
 *   - numbers, booleans, null
 *   - `#` comments (full-line, or trailing when preceded by whitespace and not inside quotes)
 *
 * Anything outside this subset raises a YamlParseError with a line number.
 * This is intentionally strict: an authoring error must never silently parse.
 */

export class YamlParseError extends Error {
  constructor(message, line) {
    super(`YAML parse error at line ${line}: ${message}`)
    this.name = 'YamlParseError'
    this.line = line
  }
}

/** @typedef {{ raw: string, indent: number, number: number }} Line */

/**
 * Parse YAML-subset text into plain JavaScript values.
 * @param {string} text
 * @returns {unknown}
 */
export function parseYaml(text) {
  const lines = normalizeLines(text)
  if (lines.length === 0) return null
  const state = { lines, index: 0 }
  const value = parseBlock(state, lines[0].indent)
  if (state.index < state.lines.length) {
    const line = state.lines[state.index]
    throw new YamlParseError(`unexpected content ${JSON.stringify(line.raw)}`, line.number)
  }
  return value
}

/**
 * Split into significant lines: comments stripped, blank lines dropped,
 * tabs in indentation rejected, CRLF tolerated.
 * @param {string} text
 * @returns {Line[]}
 */
function normalizeLines(text) {
  const out = []
  const rawLines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i]
    if (/^\t/.test(raw) || /^ +\t/.test(raw)) throw new YamlParseError('tab indentation is not supported', i + 1)
    const stripped = stripComment(raw)
    if (stripped.trim() === '') continue
    const indent = stripped.length - stripped.trimStart().length
    out.push({ raw: stripped.slice(indent).trimEnd(), indent, number: i + 1 })
  }
  return out
}

/**
 * Remove a trailing `# comment` that is preceded by whitespace or starts the
 * line, unless the `#` sits inside a quoted section of the line.
 * @param {string} line
 */
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote === '"') {
      if (ch === '\\') i += 1
      else if (ch === '"') quote = null
    } else if (quote === "'") {
      if (ch === "'" && line[i + 1] === "'") i += 1
      else if (ch === "'") quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i)
    }
  }
  return line
}

/**
 * Parse a block (mapping or sequence) whose entries sit exactly at `indent`.
 * @param {{ lines: Line[], index: number }} state
 * @param {number} indent
 */
function parseBlock(state, indent) {
  const first = state.lines[state.index]
  if (first === undefined) return null
  if (first.indent < indent) return null
  if (first.indent > indent) throw new YamlParseError(`unexpected indentation (expected ${indent} spaces)`, first.number)
  if (first.raw.startsWith('- ') || first.raw === '-') return parseSequence(state, indent)
  return parseMapping(state, indent)
}

/** @param {{ lines: Line[], index: number }} state @param {number} indent */
function parseMapping(state, indent) {
  const map = {}
  while (state.index < state.lines.length) {
    const line = state.lines[state.index]
    if (line.indent < indent) break
    if (line.indent > indent) throw new YamlParseError('unexpected nested indentation inside mapping', line.number)
    if (line.raw.startsWith('- ') || line.raw === '-') break
    const { key, rest } = splitKey(line)
    state.index += 1
    map[key] = parseValue(state, rest, line)
  }
  return map
}

/** @param {{ lines: Line[], index: number }} state @param {number} indent */
function parseSequence(state, indent) {
  const list = []
  while (state.index < state.lines.length) {
    const line = state.lines[state.index]
    if (line.indent < indent) break
    if (line.indent > indent) throw new YamlParseError('unexpected nested indentation inside sequence', line.number)
    if (!(line.raw.startsWith('- ') || line.raw === '-')) break
    const rest = line.raw === '-' ? '' : line.raw.slice(2)
    state.index += 1
    if (rest === '') {
      list.push(parseNested(state, line))
    } else if (isKeyValue(rest)) {
      // Inline mapping start: `- key: value` with possible sibling keys on
      // following lines indented to align under the first key.
      const inlineIndent = indent + 2
      const firstLine = { raw: rest, indent: inlineIndent, number: line.number }
      const map = {}
      const { key, rest: value } = splitKey(firstLine)
      const saved = state.lines
      state.lines = [firstLine, ...state.lines.slice(state.index)]
      const offset = state.index
      state.index = 0
      map[key] = parseValue(state, value, firstLine)
      // Continue reading sibling keys of this inline map at inlineIndent.
      while (state.index < state.lines.length) {
        const next = state.lines[state.index]
        if (next.indent !== inlineIndent || next.raw.startsWith('- ') || next.raw === '-' || !isKeyValue(next.raw)) break
        const sibling = splitKey(next)
        state.index += 1
        map[sibling.key] = parseValue(state, sibling.rest, next)
      }
      const consumed = state.index
      state.lines = saved
      state.index = offset + consumed - 1
      list.push(map)
    } else {
      list.push(parseScalarWithContinuation(state, rest, line))
    }
  }
  return list
}

/**
 * Parse the value following `key:` — inline scalar, nested block, or block scalar.
 * @param {{ lines: Line[], index: number }} state
 * @param {string} rest text after `key:`
 * @param {Line} line the key's line
 */
function parseValue(state, rest, line) {
  const trimmed = rest.trim()
  if (trimmed === '|' || trimmed === '>') return parseBlockScalar(state, line, trimmed === '>' ? 'fold' : 'literal')
  if (trimmed !== '') return parseScalarWithContinuation(state, trimmed, line)
  return parseNested(state, line)
}

/**
 * Parse a nested block more-indented than `line`; empty value becomes null.
 * @param {{ lines: Line[], index: number }} state @param {Line} line
 */
function parseNested(state, line) {
  const next = state.lines[state.index]
  if (next === undefined || next.indent <= line.indent) return null
  return parseBlock(state, next.indent)
}

/**
 * Parse an inline scalar, folding any more-indented continuation lines into it
 * with single spaces (YAML plain-scalar wrapping).
 * @param {{ lines: Line[], index: number }} state
 * @param {string} text
 * @param {Line} line the line the scalar started on
 */
function parseScalarWithContinuation(state, text, line) {
  // Quoted or flow scalars never fold; they must be complete on one line.
  if (text.startsWith('"') || text.startsWith("'") || text.startsWith('[') || text.startsWith('{')) {
    return parseInlineScalar(text, line)
  }
  let folded = text
  while (state.index < state.lines.length) {
    const next = state.lines[state.index]
    if (next.indent <= line.indent) break
    if (next.raw.startsWith('- ') || next.raw === '-' || isKeyValue(next.raw)) break
    folded += ` ${next.raw}`
    state.index += 1
  }
  return parsePlainScalar(folded)
}

/**
 * Parse a literal `|` or folded `>` block scalar.
 * @param {{ lines: Line[], index: number }} state @param {Line} line @param {'fold'|'literal'} mode
 */
function parseBlockScalar(state, line, mode) {
  const parts = []
  let blockIndent = -1
  while (state.index < state.lines.length) {
    const next = state.lines[state.index]
    if (next.indent <= line.indent) break
    if (blockIndent === -1) blockIndent = next.indent
    if (next.indent < blockIndent) break
    parts.push(next.raw)
    state.index += 1
  }
  return mode === 'literal' ? `${parts.join('\n')}\n` : `${parts.join(' ')}\n`
}

/** @param {Line} line @returns {{ key: string, rest: string }} */
function splitKey(line) {
  const match = findKeySeparator(line.raw)
  if (match === -1) throw new YamlParseError(`expected a 'key:' mapping entry, got ${JSON.stringify(line.raw)}`, line.number)
  const key = parseMapKey(line.raw.slice(0, match).trim(), line)
  return { key, rest: line.raw.slice(match + 1) }
}

/**
 * Find the `:` separating a mapping key from its value: the first colon that is
 * followed by a space or end-of-line and not inside quotes or flow brackets.
 * @param {string} raw
 */
function findKeySeparator(raw) {
  let quote = null
  let depth = 0
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (quote === '"') {
      if (ch === '\\') i += 1
      else if (ch === '"') quote = null
    } else if (quote === "'") {
      if (ch === "'") quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth -= 1
    else if (ch === ':' && depth === 0 && (i + 1 === raw.length || raw[i + 1] === ' ')) return i
  }
  return -1
}

/** @param {string} raw */
function isKeyValue(raw) {
  return findKeySeparator(raw) !== -1
}

/** @param {string} raw @param {Line} line */
function parseMapKey(raw, line) {
  if (raw === '') throw new YamlParseError('empty mapping key', line.number)
  if (raw.startsWith('"')) return parseDoubleQuoted(raw, line)
  if (raw.startsWith("'")) return parseSingleQuoted(raw, line)
  return raw
}

/**
 * Parse a complete inline scalar (quoted string or flow collection).
 * @param {string} text @param {Line} line
 */
function parseInlineScalar(text, line) {
  if (text.startsWith('"')) return parseDoubleQuoted(text, line)
  if (text.startsWith("'")) return parseSingleQuoted(text, line)
  if (text.startsWith('[')) return parseFlowSequence(text, line)
  if (text.startsWith('{')) return parseFlowMapping(text, line)
  return parsePlainScalar(text)
}

/** @param {string} text @param {Line} line */
function parseDoubleQuoted(text, line) {
  const match = /^"(?:[^"\\]|\\.)*"/.exec(text)
  if (match === null) throw new YamlParseError(`unterminated double-quoted scalar ${JSON.stringify(text)}`, line.number)
  const body = match[0].slice(1, -1)
  const value = body.replace(/\\(u[0-9a-fA-F]{4}|n|t|r|"|\\|\/|0|b|f)/g, (_, esc) => {
    if (esc.startsWith('u')) return String.fromCharCode(Number.parseInt(esc.slice(1), 16))
    return { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', b: '\b', f: '\f' }[esc]
  })
  ensureFullyConsumed(text, match[0], line)
  return value
}

/** @param {string} text @param {Line} line */
function parseSingleQuoted(text, line) {
  const match = /^'(?:[^']|'')*'/.exec(text)
  if (match === null) throw new YamlParseError(`unterminated single-quoted scalar ${JSON.stringify(text)}`, line.number)
  ensureFullyConsumed(text, match[0], line)
  return match[0].slice(1, -1).replace(/''/g, "'")
}

/** @param {string} text @param {string} consumed @param {Line} line */
function ensureFullyConsumed(text, consumed, line) {
  if (text.length !== consumed.length) {
    throw new YamlParseError(`unexpected trailing content after scalar: ${JSON.stringify(text.slice(consumed.length))}`, line.number)
  }
}

/**
 * Parse a flow sequence `[a, "b", 3]`; nested flow collections are supported.
 * @param {string} text @param {Line} line
 */
function parseFlowSequence(text, line) {
  const state = { text, pos: 0, line }
  expectChar(state, '[')
  const items = []
  skipSpaces(state)
  if (peek(state) === ']') {
    state.pos += 1
  } else {
    for (;;) {
      items.push(parseFlowValue(state))
      skipSpaces(state)
      const ch = state.text[state.pos]
      if (ch === ',') {
        state.pos += 1
        skipSpaces(state)
        continue
      }
      if (ch === ']') {
        state.pos += 1
        break
      }
      throw new YamlParseError(`expected ',' or ']' in flow sequence at ${JSON.stringify(state.text.slice(state.pos))}`, line.number)
    }
  }
  skipSpaces(state)
  if (state.pos !== state.text.length) throw new YamlParseError(`trailing content after flow sequence: ${JSON.stringify(state.text.slice(state.pos))}`, line.number)
  return items
}

/** @param {string} text @param {Line} line */
function parseFlowMapping(text, line) {
  const state = { text, pos: 0, line }
  expectChar(state, '{')
  const map = {}
  skipSpaces(state)
  if (peek(state) === '}') {
    state.pos += 1
  } else {
    for (;;) {
      skipSpaces(state)
      const keyStart = state.pos
      while (state.pos < state.text.length && state.text[state.pos] !== ':' && state.text[state.pos] !== '}') state.pos += 1
      if (state.text[state.pos] !== ':') throw new YamlParseError('expected ":" in flow mapping', line.number)
      const key = state.text.slice(keyStart, state.pos).trim()
      state.pos += 1
      map[key] = parseFlowValue(state)
      skipSpaces(state)
      const ch = state.text[state.pos]
      if (ch === ',') {
        state.pos += 1
        continue
      }
      if (ch === '}') {
        state.pos += 1
        break
      }
      throw new YamlParseError('expected \',\' or \'}\' in flow mapping', line.number)
    }
  }
  skipSpaces(state)
  if (state.pos !== state.text.length) throw new YamlParseError(`trailing content after flow mapping: ${JSON.stringify(state.text.slice(state.pos))}`, line.number)
  return map
}

/** @param {{ text: string, pos: number, line: Line }} state */
function parseFlowValue(state) {
  skipSpaces(state)
  const ch = state.text[state.pos]
  if (ch === '[') return parseFlowSequenceFromState(state)
  if (ch === '{') return parseFlowMappingFromState(state)
  if (ch === '"') {
    const match = /^"(?:[^"\\]|\\.)*"/.exec(state.text.slice(state.pos))
    if (match === null) throw new YamlParseError('unterminated double-quoted scalar in flow collection', state.line.number)
    state.pos += match[0].length
    return parseDoubleQuoted(match[0], state.line)
  }
  if (ch === "'") {
    const match = /^'(?:[^']|'')*'/.exec(state.text.slice(state.pos))
    if (match === null) throw new YamlParseError('unterminated single-quoted scalar in flow collection', state.line.number)
    state.pos += match[0].length
    return parseSingleQuoted(match[0], state.line)
  }
  const start = state.pos
  while (state.pos < state.text.length && !',]}'.includes(state.text[state.pos])) state.pos += 1
  return parsePlainScalar(state.text.slice(start, state.pos).trim())
}

/** @param {{ text: string, pos: number, line: Line }} state */
function parseFlowSequenceFromState(state) {
  const start = state.pos
  let depth = 0
  let quote = null
  while (state.pos < state.text.length) {
    const ch = state.text[state.pos]
    if (quote === '"') {
      if (ch === '\\') state.pos += 1
      else if (ch === '"') quote = null
    } else if (quote === "'") {
      if (ch === "'") quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) {
        state.pos += 1
        const slice = state.text.slice(start, state.pos)
        const inner = { text: slice, pos: 0, line: state.line }
        expectChar(inner, '[')
        const items = []
        skipSpaces(inner)
        if (peek(inner) === ']') inner.pos += 1
        else {
          for (;;) {
            items.push(parseFlowValue(inner))
            skipSpaces(inner)
            const ch2 = inner.text[inner.pos]
            if (ch2 === ',') { inner.pos += 1; skipSpaces(inner); continue }
            if (ch2 === ']') { inner.pos += 1; break }
            throw new YamlParseError('expected \',\' or \']\' in nested flow sequence', state.line.number)
          }
        }
        return items
      }
    }
    state.pos += 1
  }
  throw new YamlParseError('unterminated flow sequence', state.line.number)
}

/** @param {{ text: string, pos: number, line: Line }} state */
function parseFlowMappingFromState(state) {
  const start = state.pos
  let depth = 0
  let quote = null
  while (state.pos < state.text.length) {
    const ch = state.text[state.pos]
    if (quote === '"') {
      if (ch === '\\') state.pos += 1
      else if (ch === '"') quote = null
    } else if (quote === "'") {
      if (ch === "'") quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        state.pos += 1
        return parseFlowMapping(state.text.slice(start, state.pos), state.line)
      }
    }
    state.pos += 1
  }
  throw new YamlParseError('unterminated flow mapping', state.line.number)
}

/** @param {{ text: string, pos: number }} state @param {string} ch */
function expectChar(state, ch) {
  if (state.text[state.pos] !== ch) throw new YamlParseError(`expected ${JSON.stringify(ch)}`, 0)
  state.pos += 1
}

/** @param {{ text: string, pos: number }} state */
function skipSpaces(state) {
  while (state.pos < state.text.length && state.text[state.pos] === ' ') state.pos += 1
}

/** @param {{ text: string, pos: number }} state */
function peek(state) {
  return state.text[state.pos]
}

/**
 * Convert a plain (unquoted) scalar to its typed value.
 * @param {string} text
 */
function parsePlainScalar(text) {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === '~' || trimmed === 'null' || trimmed === 'Null' || trimmed === 'NULL') return null
  if (trimmed === 'true' || trimmed === 'True' || trimmed === 'TRUE') return true
  if (trimmed === 'false' || trimmed === 'False' || trimmed === 'FALSE') return false
  if (/^-?(0|[1-9][0-9]*)$/.test(trimmed)) {
    const asNumber = Number(trimmed)
    if (Number.isSafeInteger(asNumber)) return asNumber
  }
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(trimmed) && /[.eE]/.test(trimmed)) {
    const asNumber = Number(trimmed)
    if (Number.isFinite(asNumber)) return asNumber
  }
  return trimmed
}
