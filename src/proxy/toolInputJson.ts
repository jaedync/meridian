/**
 * Tool input JSON that is complete but malformed inside its string literals.
 * Pure leaf module: no I/O, no imports.
 *
 * When fine-grained tool streaming is on (for example
 * CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1, which query.ts sets for the
 * first-party API), the API passes the model's tool arguments through without
 * JSON validation.
 * A model editing a tab-indented file can then emit a raw TAB inside a string.
 * Claude Code rejects such a call before PreToolUse ("could not be parsed as
 * JSON"), but a passthrough client still receives the streamed deltas. Pi
 * repairs exactly these defects (pi-ai `repairJson` / `parseJsonWithRepair`),
 * so the repair below mirrors those semantics: it must never accept input
 * that Pi's repair would reject or read differently.
 */

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"])

const CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
}

function escapeControlCharacter(char: string): string {
  return CONTROL_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
}

/**
 * Escape raw U+0000–U+001F characters inside string literals and double a
 * backslash that precedes an invalid escape character. Text outside string
 * literals is copied unchanged, so truncation and structural errors survive
 * the repair and still fail to parse.
 */
export function repairJsonStringLiterals(json: string): string {
  let repaired = ""
  let inString = false
  for (let index = 0; index < json.length; index++) {
    const char = json[index]!
    if (!inString) {
      repaired += char
      if (char === '"') inString = true
      continue
    }
    if (char === '"') {
      repaired += char
      inString = false
      continue
    }
    if (char === "\\") {
      const next = json[index + 1]
      if (next === undefined) {
        repaired += "\\\\"
        continue
      }
      if (next === "u" && /^[0-9a-fA-F]{4}$/.test(json.slice(index + 2, index + 6))) {
        repaired += `\\u${json.slice(index + 2, index + 6)}`
        index += 5
        continue
      }
      if (VALID_JSON_ESCAPES.has(next)) {
        // A `\u` without four hex digits stays as written, as in pi-ai, so
        // the parser still rejects it.
        repaired += `\\${next}`
        index += 1
        continue
      }
      repaired += "\\\\"
      continue
    }
    repaired += char.charCodeAt(0) <= 0x1f ? escapeControlCharacter(char) : char
  }
  return repaired
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function tryParse(json: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(json) }
  } catch {
    // Malformed input is an expected outcome here; the caller decides.
    return { ok: false }
  }
}

/**
 * Parse complete tool input as a JSON object, accepting only the string
 * literal defects that `repairJsonStringLiterals` fixes. Returns undefined
 * for truncated JSON, any other syntax error, and non-object roots.
 */
export function parseToolInputObject(json: string): Record<string, unknown> | undefined {
  const strict = tryParse(json)
  if (strict.ok) return asObject(strict.value)
  const repairedJson = repairJsonStringLiterals(json)
  if (repairedJson === json) return undefined
  const repaired = tryParse(repairedJson)
  return repaired.ok ? asObject(repaired.value) : undefined
}
