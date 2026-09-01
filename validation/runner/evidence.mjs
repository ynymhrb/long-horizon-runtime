/**
 * Immutable evidence bundle writer (handbook "Evidence bundle").
 *
 * One immutable directory per run with stable file identifiers:
 *   run.json, commands.ndjson, task.json, events.json, snapshot.json,
 *   artifacts.json, assertions.json, environment.json, screenshots/ (UI).
 *
 * Evidence is always written BEFORE cleanup. Secrets, large artifact bodies and
 * unrelated user data are excluded; environment.json is redacted. A missing
 * required evidence item turns a passing execution into `inconclusive`.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Evidence file every run must contain, mapped to the contract item name. */
export const BASE_EVIDENCE_FILES = [
  ['run', 'run.json'],
  ['command_log', 'commands.ndjson'],
  ['task', 'task.json'],
  ['events', 'events.json'],
  ['runtime_snapshot', 'snapshot.json'],
  ['artifacts', 'artifacts.json'],
  ['assertions', 'assertions.json'],
  ['environment', 'environment.json'],
]

/** artifact bodies larger than this are never inlined into evidence. */
export const MAX_INLINE_ARTIFACT_BYTES = 64 * 1024

/** Environment variables that must never appear in evidence, even redacted-value form. */
const SECRET_KEY_PATTERN = /(secret|token|password|passwd|api[-_]?key|access[-_]?key|private[-_]?key|credential|authorization|auth[-_]?token|bearer|session[-_]?cookie)/i

/** Values that look like credentials even under an innocuous key. */
const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{16,}/,
  /glpat-[A-Za-z0-9_-]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
]

/**
 * Recursively redact secrets from a JSON-safe value. Secret-looking keys are
 * replaced with '<redacted>'; secret-looking string values anywhere are masked.
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactSecrets(value) {
  if (typeof value === 'string') return maskString(value)
  if (Array.isArray(value)) return value.map(item => redactSecrets(item))
  if (value !== null && typeof value === 'object') {
    const out = /** @type {Record<string, unknown>} */ ({})
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = '<redacted>'
      } else {
        out[key] = redactSecrets(item)
      }
    }
    return out
  }
  return value
}

/** @param {string} text */
function maskString(text) {
  let out = text
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(new RegExp(pattern.source, 'g'), '<redacted>')
  return out
}

/**
 * Filter process environment for environment.json: keep only non-secret,
 * runtime-relevant variables, redacted.
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} extraAllowlist variables explicitly requested by the scenario
 * @returns {Record<string, string>}
 */
export function sanitizeEnvironment(env, extraAllowlist = []) {
  const keep = {}
  const allow = new Set(['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'OS', 'COMSPEC', 'SystemRoot', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'SHELL', 'LANG', 'TERM', ...extraAllowlist])
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (SECRET_KEY_PATTERN.test(key)) continue
    if (!allow.has(key) && !key.startsWith('LT_')) continue
    keep[key] = maskString(value)
  }
  return keep
}

export class EvidenceWriter {
  /**
   * @param {string} dir absolute evidence directory (already run-scoped)
   */
  constructor(dir) {
    this.dir = dir
    /** @type {Map<string, string>} evidence id -> relative file */
    this.files = new Map()
    /** @type {string[]} */
    this.commandLines = []
  }

  async init() {
    await mkdir(this.dir, { recursive: true })
  }

  /** Relative path used as the stable evidence identifier prefix. */
  idOf(fileName) {
    return fileName
  }

  /**
   * Write (or overwrite, while the run is live) one JSON evidence file.
   * Values are redacted before they touch disk.
   * @param {string} fileName e.g. 'run.json'
   * @param {unknown} value JSON-safe value
   */
  async writeJson(fileName, value) {
    const redacted = redactSecrets(value)
    await writeFile(path.join(this.dir, fileName), `${JSON.stringify(redacted, null, 2)}\n`, 'utf8')
    this.files.set(fileName, fileName)
  }

  /**
   * Append one command record to commands.ndjson (memory; flushed by flushCommands).
   * @param {Record<string, unknown>} record
   */
  recordCommand(record) {
    this.commandLines.push(JSON.stringify(redactSecrets(record)))
  }

  /** Flush the accumulated command log to commands.ndjson. */
  async flushCommands() {
    await writeFile(path.join(this.dir, 'commands.ndjson'), this.commandLines.length === 0 ? '' : `${this.commandLines.join('\n')}\n`, 'utf8')
    this.files.set('commands.ndjson', 'commands.ndjson')
  }

  /** Ensure screenshots/ exists (UI scenarios). */
  async ensureScreenshotsDir() {
    await mkdir(path.join(this.dir, 'screenshots'), { recursive: true })
    this.files.set('screenshots/', 'screenshots/')
  }

  /**
   * Copy a staged evidence file produced by scenario actions (e.g. task.json
   * exported from the durable database) into the immutable bundle, redacted.
   * @param {string} stagedPath absolute path of the staged file
   * @param {string} fileName target evidence file name
   */
  async importStagedJson(stagedPath, fileName) {
    const text = await readFile(stagedPath, 'utf8')
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`staged evidence ${stagedPath} is not valid JSON`)
    }
    await this.writeJson(fileName, parsed)
  }

  /**
   * Summarize artifacts for artifacts.json: path, sha256, size, validation
   * status — never the body.
   * @param {{ path?: string, content?: string, storage?: string, validated?: boolean, active?: boolean, type?: string, id?: string }[]} artifacts
   */
  static summarizeArtifacts(artifacts) {
    return artifacts.map(artifact => {
      const summary = {
        id: artifact.id,
        type: artifact.type,
        storage: artifact.storage ?? (artifact.path !== undefined ? 'file' : 'inline'),
        validated: artifact.validated ?? false,
        active: artifact.active ?? true,
      }
      if (artifact.path !== undefined) summary.path = artifact.path
      if (artifact.content !== undefined) {
        summary.size = Buffer.byteLength(artifact.content, 'utf8')
        summary.sha256 = createHash('sha256').update(artifact.content, 'utf8').digest('hex')
      }
      return summary
    })
  }

  /**
   * Which required evidence items are missing from the bundle on disk?
   * @param {string[]} evidenceRequired scenario's evidence_required list
   * @returns {Promise<string[]>} missing item names
   */
  async missingRequired(evidenceRequired) {
    const missing = []
    for (const item of evidenceRequired) {
      if (item === 'screenshots') {
        try {
          await stat(path.join(this.dir, 'screenshots'))
        } catch {
          missing.push('screenshots')
        }
        continue
      }
      const base = BASE_EVIDENCE_FILES.find(([name]) => name === item)
      if (base === undefined) {
        missing.push(item)
        continue
      }
      try {
        const fileStat = await stat(path.join(this.dir, base[1]))
        if (!fileStat.isFile()) missing.push(item)
      } catch {
        missing.push(item)
      }
    }
    return missing
  }

  /**
   * Inventory of files in the bundle with sizes and hashes (written into
   * run.json for tamper evidence; the bundle itself stays immutable after
   * finalization).
   */
  async inventory() {
    /** @type {Record<string, { size: number, sha256: string }>} */
    const out = {}
    const entries = await readdir(this.dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(this.dir, entry.name)
      if (entry.isDirectory()) {
        const inner = await readdir(full)
        for (const name of inner) {
          const innerFull = path.join(full, name)
          const content = await readFile(innerFull)
          out[`${entry.name}/${name}`] = { size: content.length, sha256: createHash('sha256').update(content).digest('hex') }
        }
      } else {
        const content = await readFile(full)
        out[entry.name] = { size: content.length, sha256: createHash('sha256').update(content).digest('hex') }
      }
    }
    return out
  }
}

/**
 * The base evidence item names every run must produce regardless of scenario.
 * @returns {string[]}
 */
export function baseEvidenceItems() {
  return BASE_EVIDENCE_FILES.map(([item]) => item)
}
