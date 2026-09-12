// ============================================================================
// Skill Memory for DSH: workspace knowledge that is learned and recalled.
//
// pre_query equivalent : 'agent/pre-step' waterfall. Matches the current turn
//                        query against stored skills and hands the result to the
//                        step as a plugin-sourced recall message. Pinned skills
//                        always inject.
// post_query equivalent: 'session/event' feed. A completed turn is analyzed by
//                        the model in a background job; skills are created or
//                        merged into .dsh-skill-memory.json in the workspace.
//
// Language policy: skills are written in the language the conversation is
// conducted in, and matching happens in that same language. No translation step.
//
// Identifier fidelity: symbols, file paths and API names are stored exactly as
// they appear in the source, never as the user typed them. Symbols are verified
// against the referenced file at capture time.
//
// Configuration: one source only, the workspace config file
//   <workspace>/.dsh-skill-memory.config.json
// with the keys aliases, globalStore and home. There is no machine-level layer
// and no implicit default: if globalStore is absent, the global layer is simply
// disabled, and global-scope skills stay in the workspace store.
//
// Portability: this source contains no machine-specific values, and persisted
// skill records never embed an absolute workspace path.
// ============================================================================
import z from '@deepseek-ai/schemastery'

const PLUGIN_NAME = 'skill-memory'
const LOCAL_FILE = '.dsh-skill-memory.json'
const CONFIG_FILE = '.dsh-skill-memory.config.json'
const MAX_SKILLS = 250
const TOP_K = 4
const MIN_SCORE = 0.3
const MAX_PINNED = 2
const MAX_RECALL_CHARS = 4000
const DIGEST_MESSAGES = 40
const DIGEST_CHARS = 1500
const MIN_CONFIDENCE = 0.5
const EXTRACT_MAX_TOKENS = 1800
const MAX_PENDING_JOBS = 8
const SIMILARITY_KEEP = 0.6
const VERIFY_MAX_BYTES = 400000
const RAW_CLIP = 3000

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'not', 'you', 'your', 'our',
  'but', 'can', 'have', 'has', 'had', 'will', 'would', 'should', 'could', 'into', 'out', 'use', 'using',
  'bir', 'ile', 'icin', 'ama', 'daha', 'cok', 'var', 'yok', 'ben', 'sen', 'biz', 'bu', 'ki', 've', 'gibi',
  'olarak', 'olan', 'oldu', 'ise', 'simdi', 'nasil', 'neden', 'uzere',
])

const FOLD = {
  '\u00e7': 'c', '\u011f': 'g', '\u0131': 'i', '\u00f6': 'o', '\u015f': 's', '\u00fc': 'u',
  '\u00e2': 'a', '\u00ee': 'i', '\u00fb': 'u', '\u00e9': 'e', '\u00e8': 'e', '\u00ea': 'e',
  '\u00e1': 'a', '\u00e0': 'a', '\u00e4': 'a', '\u00e5': 'a', '\u00f1': 'n', '\u00f8': 'o',
  '\u00df': 'ss', '\u0130': 'i', '\u015e': 's', '\u011e': 'g', '\u00c7': 'c',
}

// ---------------------------------------------------------------- utilities
function uniqueId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36)
}

function stripTrailingSlash(value) {
  let out = String(value || '')
  while (out.length > 1 && out.charAt(out.length - 1) === '/') out = out.slice(0, out.length - 1)
  return out
}

function stripLeadingSlash(value) {
  let out = String(value || '')
  while (out.length > 1 && out.charAt(0) === '/') out = out.slice(1)
  return out
}

function joinPath(base, name) {
  const left = stripTrailingSlash(base)
  const right = stripLeadingSlash(name)
  if (left.length === 0 || left === '.') return right
  return left + '/' + right
}

function isAbsolutePath(value) {
  const text = String(value || '')
  if (text.length === 0) return false
  if (text.charAt(0) === '/') return true
  return text.indexOf(':') === 1
}

function clip(value, max) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= max) return text
  return text.slice(0, max) + ' ...'
}

function errorText(error) {
  if (error === null || error === undefined) return String(error)
  if (typeof error.message === 'string') return error.message
  return String(error)
}

function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out += (out.length === 0 ? '' : '\n') + block.text
    }
  }
  return out.trim()
}

function sourceKind(message) {
  const source = message === null || message === undefined ? undefined : message.source
  return source !== null && typeof source === 'object' && typeof source.kind === 'string' ? source.kind : ''
}

function foldText(text) {
  const lower = String(text || '').toLowerCase()
  let out = ''
  for (let index = 0; index < lower.length; index += 1) {
    const ch = lower.charAt(index)
    out += Object.prototype.hasOwnProperty.call(FOLD, ch) ? FOLD[ch] : ch
  }
  return out
}

function tokenize(text) {
  const tokens = new Set()
  const words = foldText(text).split(/[^0-9a-z]+/)
  for (const word of words) {
    if (word.length >= 3 && !STOPWORDS.has(word)) tokens.add(word)
  }
  return tokens
}

function wordOverlap(left, right) {
  const a = tokenize(left)
  const b = tokenize(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) {
    if (b.has(token)) shared += 1
  }
  const smallest = a.size < b.size ? a.size : b.size
  return shared / smallest
}

function cleanStrings(value, max) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text.length === 0) continue
    const key = foldText(text)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out.slice(0, max)
}

// --------------------------------------------------------------------- refs
function normalizeRef(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const repo = typeof raw.repo === 'string' && raw.repo.trim().length > 0 ? raw.repo.trim() : 'self'
  const path = typeof raw.path === 'string' ? raw.path.trim() : ''
  if (path.length === 0) return undefined
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim() : ''
  let seenVersion = ''
  if (typeof raw.seenVersion === 'string') seenVersion = raw.seenVersion
  else if (typeof raw.seenVersion === 'number') seenVersion = String(raw.seenVersion)
  const seenSize = typeof raw.seenSize === 'number' && isFinite(raw.seenSize) ? raw.seenSize : 0
  const ref = { repo: repo, path: path, symbol: symbol, seenVersion: seenVersion, seenSize: seenSize }
  if (raw.verified === true) ref.verified = true
  else if (raw.verified === false) ref.verified = false
  return ref
}

function parseRefString(text) {
  if (typeof text !== 'string') return undefined
  let body = text.trim()
  if (body.length === 0) return undefined
  let symbol = ''
  const sep = body.indexOf('::')
  if (sep >= 0) {
    symbol = body.slice(sep + 2).trim()
    body = body.slice(0, sep).trim()
  }
  let repo = 'self'
  const colon = body.indexOf(':')
  if (colon > 0 && !isAbsolutePath(body)) {
    repo = body.slice(0, colon).trim()
    body = body.slice(colon + 1).trim()
  }
  if (body.length === 0) return undefined
  return { repo: repo, path: body, symbol: symbol, seenVersion: '', seenSize: 0 }
}

function refToString(ref) {
  const base = ref.repo + ':' + ref.path
  return ref.symbol.length > 0 ? base + ' :: ' + ref.symbol : base
}

function refKey(ref) {
  return ref.repo + '|' + ref.path + '|' + ref.symbol
}

function symbolAppears(text, symbol) {
  if (symbol.length === 0) return undefined
  if (text.indexOf(symbol) >= 0) return true
  const sep = symbol.lastIndexOf('::')
  const member = (sep >= 0 ? symbol.slice(sep + 2) : symbol).trim()
  if (member.length === 0) return undefined
  return text.indexOf(member) >= 0
}

// --------------------------------------------------------------- skill shape
function isSkillLike(value) {
  return value !== null && typeof value === 'object' && typeof value.id === 'string' && typeof value.name === 'string'
}

function cleanEvidence(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) out.push(item)
  }
  return out.slice(-3)
}

function makeSkill(raw, cwd) {
  const time = Date.now()
  const confidence = typeof raw.confidence === 'number' && isFinite(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : 0.6
  const version = typeof raw.version === 'number' && isFinite(raw.version) && raw.version > 0 ? Math.floor(raw.version) : 1
  const uses = typeof raw.uses === 'number' && isFinite(raw.uses) ? Math.floor(raw.uses) : 0
  const refs = []
  if (Array.isArray(raw.refs)) {
    for (const item of raw.refs) {
      const ref = normalizeRef(item)
      if (ref !== undefined) refs.push(ref)
    }
  }
  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : uniqueId('skill'),
    workspace: cwd,
    scope: raw.scope === 'global' ? 'global' : 'workspace',
    kind: typeof raw.kind === 'string' ? raw.kind : 'note',
    name: clip(String(raw.name || 'untitled skill'), 120),
    description: clip(String(raw.description || ''), 400),
    instructions: String(raw.instructions || ''),
    triggers: cleanStrings(raw.triggers, 10),
    refs: refs.slice(0, 8),
    tags: cleanStrings(raw.tags, 12),
    pinned: raw.pinned === true,
    source: raw.source === 'manual' ? 'manual' : 'auto',
    confidence: confidence,
    version: version,
    uses: uses,
    created_at: typeof raw.created_at === 'number' ? raw.created_at : time,
    updated_at: typeof raw.updated_at === 'number' ? raw.updated_at : time,
    evidence: cleanEvidence(raw.evidence),
  }
}

// Records written to disk carry no machine-specific path: `workspace` is a
// runtime-only convenience and is re-derived from the session on load.
function toRecords(skills) {
  const out = []
  for (const skill of skills) {
    const copy = {}
    for (const key of Object.keys(skill)) {
      if (key === 'workspace') continue
      copy[key] = skill[key]
    }
    out.push(copy)
  }
  return out
}

function refSummary(ref) {
  if (ref.symbol.length === 0) return refToString(ref)
  if (ref.verified === true) return refToString(ref) + '  (verified)'
  if (ref.verified === false) return refToString(ref) + '  (NOT FOUND in that file)'
  return refToString(ref)
}

function serializeSkill(skill, score) {
  const refs = []
  for (const ref of skill.refs || []) refs.push(refSummary(ref))
  return {
    id: skill.id,
    name: skill.name,
    kind: skill.kind,
    scope: skill.scope,
    pinned: skill.pinned === true,
    description: skill.description,
    instructions: skill.instructions,
    triggers: skill.triggers || [],
    refs: refs,
    tags: skill.tags || [],
    source: skill.source,
    confidence: typeof skill.confidence === 'number' ? skill.confidence : 0,
    version: typeof skill.version === 'number' ? skill.version : 1,
    uses: typeof skill.uses === 'number' ? skill.uses : 0,
    score: typeof score === 'number' && isFinite(score) ? score : 0,
  }
}

// ---------------------------------------------------------------- matching
function matchSkill(queryFolded, queryTokens, skill) {
  let triggerHits = 0
  for (const trigger of skill.triggers || []) {
    const folded = foldText(trigger).trim()
    if (folded.length < 3) continue
    if (queryFolded.indexOf(folded) >= 0) {
      triggerHits += 1
      continue
    }
    const triggerTokens = tokenize(folded)
    if (triggerTokens.size === 0) continue
    let all = true
    for (const token of triggerTokens) {
      if (!queryTokens.has(token)) {
        all = false
        break
      }
    }
    if (all) triggerHits += 1
  }
  const docText = [skill.name, skill.description, skill.instructions, (skill.tags || []).join(' '), (skill.triggers || []).join(' ')].join(' ')
  const docTokens = tokenize(docText)
  let hits = 0
  for (const token of queryTokens) {
    if (docTokens.has(token)) hits += 1
  }
  const coverage = queryTokens.size === 0 ? 0 : hits / queryTokens.size
  let score = 0.45 * coverage
  if (triggerHits > 0) score += Math.min(0.85, 0.55 + 0.15 * (triggerHits - 1))
  if (skill.source === 'manual') score += 0.02
  score = Math.max(0, Math.min(1, score))
  return { score: score, triggerHits: triggerHits, coverage: coverage }
}

// ------------------------------------------------------------------ config
async function readJsonFile(ctx, path, cwd) {
  const fs = ctx.get('fs')
  if (fs === undefined || path.length === 0) return undefined
  const full = isAbsolutePath(path) ? path : joinPath(cwd, path)
  const target = await fs.resolve(full, {})
  const text = await fs.readText(target)
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : undefined
}

async function resolveStorePath(ctx, cwd, raw) {
  const fs = ctx.get('fs')
  if (fs === undefined || raw.length === 0) return raw
  try {
    const target = await fs.resolve(isAbsolutePath(raw) ? raw : joinPath(cwd, raw), {})
    const path = fs.processPath(target)
    if (typeof path === 'string' && path.length > 0) return path
    return raw
  } catch (error) {
    return raw + ' (unresolved: ' + errorText(error) + ')'
  }
}

// One source only: the workspace config file. No machine layer and no implicit
// default, so where the global store lives is always an explicit decision.
async function readConfig(ctx, cwd) {
  const config = { aliases: {}, globalStore: '', globalStoreError: '', home: '', configFile: '', configRead: false, globalSource: '' }
  let parsed
  try {
    parsed = await readJsonFile(ctx, joinPath(cwd, CONFIG_FILE), cwd)
  } catch (error) {
    parsed = undefined
  }
  if (parsed !== undefined) {
    config.configRead = true
    config.configFile = joinPath(cwd, CONFIG_FILE)
    if (parsed.aliases !== null && typeof parsed.aliases === 'object') {
      for (const key of Object.keys(parsed.aliases)) {
        const value = parsed.aliases[key]
        if (typeof value === 'string' && value.trim().length > 0) config.aliases[key] = value.trim()
      }
    }
    if (typeof parsed.home === 'string' && parsed.home.trim().length > 0) config.home = stripTrailingSlash(parsed.home.trim())
    if (typeof parsed.globalStore === 'string' && parsed.globalStore.trim().length > 0) {
      config.globalStore = parsed.globalStore.trim()
      config.globalSource = 'config: ' + config.configFile
    }
  }
  if (config.globalStore.indexOf('~') === 0) {
    if (config.home.length > 0) {
      config.globalStore = joinPath(config.home, config.globalStore.slice(1))
      config.globalSource = 'config: ' + config.configFile + ' (tilde expanded with home)'
    } else {
      config.globalStoreError = 'globalStore begins with a tilde, which the fs layer treats as a literal directory name; set "home" or use an absolute path'
      config.globalStore = ''
      config.globalSource = ''
    }
  }
  if (config.globalStore.length > 0 && !isAbsolutePath(config.globalStore)) {
    config.globalStore = joinPath(cwd, config.globalStore)
    config.globalSource = config.globalSource + ' (relative, resolved against the workspace)'
  }
  return config
}

function resolveRepoRoot(config, cwd, repo) {
  if (repo === 'self' || repo === 'workspace') return cwd
  const alias = config.aliases[repo]
  if (alias === undefined) return ''
  if (isAbsolutePath(alias) || alias.charAt(0) === '~') return stripTrailingSlash(alias)
  return stripTrailingSlash(joinPath(cwd, alias))
}

function resolveRefPath(config, cwd, ref) {
  const root = resolveRepoRoot(config, cwd, ref.repo)
  if (root.length === 0) return ''
  return joinPath(root, ref.path)
}

function describeRepoRoots(config, cwd) {
  const lines = ['- self -> ' + cwd]
  for (const key of Object.keys(config.aliases)) {
    const root = resolveRepoRoot(config, cwd, key)
    lines.push('- ' + key + ' -> ' + root)
  }
  return lines.join('\n')
}

// ------------------------------------------------------------------ store
const storeCache = new Map()

async function loadState(ctx, cwd) {
  const cached = storeCache.get(cwd)
  if (cached !== undefined) return cached
  const config = await readConfig(ctx, cwd)
  const state = { skills: [], config: config, globalWritable: false, globalError: config.globalStoreError, globalRead: false, globalResolved: '' }
  if (cwd.length > 0) {
    if (config.globalStore.length > 0) {
      state.globalWritable = true
      state.globalResolved = await resolveStorePath(ctx, cwd, config.globalStore)
      try {
        const parsed = await readJsonFile(ctx, config.globalStore, cwd)
        if (parsed !== undefined && Array.isArray(parsed.skills)) {
          for (const raw of parsed.skills) {
            if (!isSkillLike(raw)) continue
            const skill = makeSkill(raw, cwd)
            skill.scope = 'global'
            state.skills.push(skill)
          }
          state.globalRead = true
        }
      } catch (error) {
        // A missing global store is normal; a denied one is reported on write.
      }
    }
    try {
      const parsed = await readJsonFile(ctx, joinPath(cwd, LOCAL_FILE), cwd)
      if (parsed !== undefined && Array.isArray(parsed.skills)) {
        for (const raw of parsed.skills) {
          if (!isSkillLike(raw)) continue
          const skill = makeSkill(raw, cwd)
          const index = state.skills.findIndex((entry) => entry.id === skill.id)
          if (index >= 0) state.skills[index] = skill
          else state.skills.push(skill)
        }
      }
    } catch (error) {
      // First run: no local store yet.
    }
  }
  storeCache.set(cwd, state)
  return state
}

async function statForRef(fs, config, cwd, ref) {
  const resolved = resolveRefPath(config, cwd, ref)
  if (resolved.length === 0) return undefined
  try {
    const target = await fs.resolve(resolved, {})
    const info = await fs.stat(target)
    if (info === undefined || info === null) return undefined
    return { target: target, info: info, resolved: resolved }
  } catch (error) {
    return undefined
  }
}

async function captureRefFacts(ctx, cwd, state, diag) {
  const fs = ctx.get('fs')
  if (fs === undefined) return
  for (const skill of state.skills) {
    for (const ref of skill.refs || []) {
      let stat = await statForRef(fs, state.config, cwd, ref)
      if (stat === undefined) {
        const alternates = []
        const repos = ['self'].concat(Object.keys(state.config.aliases))
        for (const repo of repos) {
          if (repo === ref.repo) continue
          const probe = { repo: repo, path: ref.path, symbol: ref.symbol, seenVersion: '', seenSize: 0 }
          const alt = await statForRef(fs, state.config, cwd, probe)
          if (alt !== undefined) alternates.push({ repo: repo, stat: alt })
        }
        if (alternates.length === 1) {
          const chosen = alternates[0]
          diag.refRepoRepairs += 1
          if (diag.refRepoRepairList.length < 3) diag.refRepoRepairList.push(refToString(ref) + ' -> ' + chosen.repo + ':' + ref.path)
          ref.repo = chosen.repo
          stat = chosen.stat
        }
      }
      if (stat === undefined) {
        diag.refStatErrors += 1
        if (diag.refStatError.length === 0) diag.refStatError = refToString(ref) + ' not found'
        continue
      }
      ref.seenVersion = stat.info.version === undefined || stat.info.version === null ? '' : String(stat.info.version)
      ref.seenSize = typeof stat.info.size === 'number' ? stat.info.size : 0
      diag.refStats += 1
      if (ref.symbol.length > 0 && (stat.info.size === undefined || stat.info.size <= VERIFY_MAX_BYTES)) {
        try {
          const text = await fs.readText(stat.target)
          const found = symbolAppears(text, ref.symbol)
          if (found === undefined) delete ref.verified
          else ref.verified = found
          if (found === true) diag.symbolVerified += 1
          if (found === false) {
            diag.symbolMissing += 1
            if (diag.symbolMissingList.length < 3) diag.symbolMissingList.push(refToString(ref))
          }
        } catch (error) {
          // Unreadable for verification: leave the symbol unverified.
        }
      }
    }
  }
}

async function persistState(ctx, cwd, state, diag) {
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('fs service is unavailable, cannot persist skills')
  if (cwd.length === 0) throw new Error('no workspace path resolved, cannot persist skills')
  state.skills = state.skills.slice(0, MAX_SKILLS)
  await captureRefFacts(ctx, cwd, state, diag)
  const localTarget = await fs.resolve(joinPath(cwd, LOCAL_FILE), {})
  await fs.writeText(localTarget, JSON.stringify({ version: 4, updated_at: Date.now(), skills: toRecords(state.skills) }, null, 2) + '\n')
  if (state.globalWritable && state.config.globalStore.length > 0) {
    try {
      const globalSkills = toRecords(state.skills.filter((skill) => skill.scope === 'global'))
      const globalTarget = await fs.resolve(state.config.globalStore, {})
      await fs.writeText(globalTarget, JSON.stringify({ version: 4, updated_at: Date.now(), skills: globalSkills }, null, 2) + '\n')
      const check = await fs.stat(globalTarget)
      if (check === undefined || check === null) {
        state.globalWritable = false
        state.globalError = 'write reported success but the global store is not readable at ' + state.globalResolved
      } else {
        state.globalError = state.config.globalStoreError
      }
    } catch (error) {
      state.globalWritable = false
      state.globalError = errorText(error)
    }
  }
}

// ------------------------------------------------------------------- recall
function buildRefLines(state, cwd, skill) {
  const lines = []
  for (const ref of skill.refs || []) {
    const resolved = resolveRefPath(state.config, cwd, ref)
    if (resolved.length === 0) {
      lines.push('  - ' + refToString(ref) + '  [alias not defined, unresolved]')
      continue
    }
    let line = '  - ' + refToString(ref) + '  ->  ' + resolved
    if (ref.verified === false) line += '  [symbol not found in that file, verify]'
    lines.push(line)
  }
  return lines
}

async function checkRefs(ctx, cwd, state) {
  const fs = ctx.get('fs')
  const notes = []
  if (fs === undefined) return notes
  for (const skill of state.skills) {
    for (const ref of skill.refs || []) {
      const resolved = resolveRefPath(state.config, cwd, ref)
      if (resolved.length === 0) {
        notes.push(refToString(ref) + ': alias not defined')
        continue
      }
      try {
        const target = await fs.resolve(resolved, {})
        const info = await fs.stat(target)
        if (info === undefined || info === null) {
          notes.push(refToString(ref) + ': not found at ' + resolved)
          continue
        }
        const current = info.version === undefined || info.version === null ? '' : String(info.version)
        if (ref.seenVersion.length > 0 && current.length > 0 && ref.seenVersion !== current) {
          notes.push(refToString(ref) + ': changed since learned, re-verify the entry point')
        }
        if (ref.symbol.length > 0 && ref.verified !== true && info.size !== undefined && info.size <= VERIFY_MAX_BYTES) {
          const text = await fs.readText(target)
          const found = symbolAppears(text, ref.symbol)
          if (found === false) notes.push(refToString(ref) + ': symbol not found in that file')
        }
      } catch (error) {
        notes.push(refToString(ref) + ': cannot be checked (' + errorText(error) + ')')
      }
    }
  }
  return notes
}

async function recall(ctx, cwd, state, query) {
  const folded = foldText(query)
  const tokens = tokenize(query)
  const scored = []
  for (const skill of state.skills) {
    const result = matchSkill(folded, tokens, skill)
    if (result.score >= MIN_SCORE || result.triggerHits > 0) scored.push({ skill: skill, score: result.score })
  }
  scored.sort((a, b) => b.score - a.score)
  const hits = scored.slice(0, TOP_K)
  const pinned = state.skills.filter((skill) => skill.pinned === true).slice(0, MAX_PINNED)
  const chosen = []
  for (const skill of pinned) chosen.push({ skill: skill, score: 1, pinned: true })
  for (const entry of hits) {
    if (chosen.some((item) => item.skill.id === entry.skill.id)) continue
    chosen.push({ skill: entry.skill, score: entry.score, pinned: false })
  }
  let nonPinnedCount = 0
  for (const entry of chosen) {
    if (entry.pinned !== true) nonPinnedCount += 1
  }
  if (chosen.length === 0) return { text: '', hits: [], pinnedCount: 0, nonPinnedCount: 0 }
  for (const entry of chosen) entry.skill.uses = (entry.skill.uses || 0) + 1
  const parts = [
    '## Workspace skill memory (auto-recalled)',
    'Knowledge learned from earlier turns. Follow it unless the current request overrides it.',
  ]
  for (const entry of chosen) {
    const skill = entry.skill
    parts.push('')
    const label = entry.pinned === true ? 'pinned' : entry.score.toFixed(2)
    parts.push('### ' + skill.name + ' [' + skill.kind + ', ' + label + ']')
    if (skill.description.length > 0) parts.push('Why: ' + skill.description)
    if (skill.instructions.length > 0) parts.push(skill.instructions)
    const refLines = buildRefLines(state, cwd, skill)
    if (refLines.length > 0) {
      parts.push('Entry points:')
      for (const line of refLines) parts.push(line)
    }
  }
  let text = parts.join('\n')
  if (text.length > MAX_RECALL_CHARS) text = text.slice(0, MAX_RECALL_CHARS) + '\n...(recall truncated)'
  const serialized = []
  for (const entry of chosen) serialized.push(serializeSkill(entry.skill, entry.score))
  return { text: text, hits: serialized, pinnedCount: pinned.length, nonPinnedCount: nonPinnedCount }
}

// ------------------------------------------------------------- model calls
function resolveRoute(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions !== undefined && typeof sessionId === 'string' && sessionId.length > 0) {
    try {
      const session = sessions.get(sessionId)
      if (session !== undefined && typeof session.requestContext === 'function') {
        const info = session.requestContext()
        if (info !== null && info !== undefined && typeof info.provider === 'string' && typeof info.model === 'string') {
          return { provider: info.provider, model: info.model }
        }
      }
    } catch (error) {
      // Fall through to the default selection.
    }
  }
  const defaultModel = ctx.get('agentDefaultModel')
  if (defaultModel !== undefined) {
    try {
      const selection = defaultModel.currentSelection()
      if (selection !== null && selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch (error) {
      // No default route available.
    }
  }
  return undefined
}

async function askModel(ctx, sessionId, system, userText, maxTokens) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('llm service is unavailable')
  const route = resolveRoute(ctx, sessionId)
  if (route === undefined) throw new Error('no model route resolved for this session')
  const messages = [{
    id: uniqueId('msg'),
    role: 'user',
    content: [{ type: 'text', text: userText }],
    source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'recall' },
  }]
  let out = ''
  const blocks = []
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    system: system,
    messages: messages,
    temperature: 0,
    maxTokens: maxTokens,
    sessionId: sessionId,
  })
  for await (const chunk of stream) {
    if (chunk === null || chunk === undefined) continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    if (chunk.type === 'block-end' && chunk.block !== null && chunk.block !== undefined && chunk.block.type === 'text' && typeof chunk.block.text === 'string') blocks.push(chunk.block.text)
    if (chunk.type === 'finish' && chunk.reason !== null && chunk.reason !== undefined && chunk.reason.kind === 'error') {
      const failure = chunk.reason.failure
      const detail = failure !== null && failure !== undefined && typeof failure.message === 'string' ? failure.message : 'model call failed'
      throw new Error(detail)
    }
  }
  if (out.trim().length === 0 && blocks.length > 0) out = blocks.join('\n')
  return out
}

// End index of the array or object literal that starts at `start`, honoring
// strings and escapes. -1 when the literal never closes.
function matchBracket(text, start) {
  const open = text.charAt(start)
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const ch = text.charAt(index)
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

// The first non-empty `"skills"` array carried by a reply. A model sometimes
// emits the key twice - `{"skills":[ ...good... ],"skills":[]}` - and JSON.parse
// keeps the last one, so the good list would be dropped and the turn would look
// like it carried nothing. Recovering the first non-empty array keeps the
// extraction the reply actually made.
function firstSkillsArray(text) {
  if (typeof text !== 'string') return undefined
  const key = '"skills"'
  let index = text.indexOf(key)
  while (index >= 0) {
    const colon = text.indexOf(':', index + key.length)
    if (colon > 0) {
      let start = colon + 1
      while (start < text.length) {
        const ch = text.charAt(start)
        if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') start += 1
        else break
      }
      if (text.charAt(start) === '[') {
        const end = matchBracket(text, start)
        if (end > start) {
          try {
            const value = JSON.parse(text.slice(start, end + 1))
            if (Array.isArray(value) && value.length > 0) return value
          } catch (error) {
            // Not valid on its own; keep scanning for another occurrence.
          }
        }
      }
    }
    index = text.indexOf(key, index + key.length)
  }
  return undefined
}

function parseExtraction(raw, diag) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    if (diag !== undefined) diag.extractParseError = 'the reply was empty'
    return undefined
  }
  const cleaned = raw.replace(/```[a-zA-Z]*/g, ' ').trim()
  const firstBrace = cleaned.indexOf('{')
  const firstBracket = cleaned.indexOf('[')
  let start = -1
  if (firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)) start = firstBrace
  else if (firstBracket >= 0) start = firstBracket
  if (start < 0) {
    if (diag !== undefined) diag.extractParseError = 'no JSON value found in the reply'
    return undefined
  }
  const body = cleaned.slice(start)
  const candidates = []
  const lastBrace = body.lastIndexOf('}')
  const lastBracket = body.lastIndexOf(']')
  const end = lastBrace > lastBracket ? lastBrace : lastBracket
  if (end > 0) candidates.push(body.slice(0, end + 1))
  let opens = 0
  let closes = 0
  for (let index = 0; index < body.length; index += 1) {
    const ch = body.charAt(index)
    if (ch === '{') opens += 1
    if (ch === '}') closes += 1
  }
  if (opens > closes) {
    let repaired = body
    for (let index = 0; index < opens - closes; index += 1) repaired += '}'
    candidates.push(repaired)
  }
  let lastError = ''
  for (const candidate of candidates) {
    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch (error) {
      lastError = errorText(error)
      continue
    }
    const normalized = normalizeExtraction(parsed, candidate, diag)
    if (normalized !== undefined) {
      if (diag !== undefined) diag.extractParseError = ''
      return normalized
    }
    lastError = 'parsed JSON had no skill list'
  }
  if (diag !== undefined) diag.extractParseError = lastError.length > 0 ? lastError : 'the reply could not be parsed'
  return undefined
}

function normalizeExtraction(parsed, text, diag) {
  // Recover a non-empty `skills` list the parsed value lost, and record it: the
  // counter makes a duplicate-key reply visible in diag instead of silent.
  const recover = () => {
    const first = firstSkillsArray(text)
    if (first !== undefined && first.length > 0) {
      if (diag !== undefined) diag.extractDupRepairs += 1
      return { skills: first }
    }
    return undefined
  }
  if (Array.isArray(parsed)) return parsed.length > 0 ? { skills: parsed } : (recover() || { skills: parsed })
  if (parsed === null || typeof parsed !== 'object') return undefined
  if (Array.isArray(parsed.skills)) {
    if (parsed.skills.length > 0) return { skills: parsed.skills }
    return recover() || { skills: parsed.skills }
  }
  if (typeof parsed.name === 'string' && typeof parsed.instructions === 'string') return { skills: [parsed] }
  for (const key of Object.keys(parsed)) {
    const value = parsed[key]
    if (Array.isArray(value) && value.length > 0) return { skills: value }
    if (value !== null && typeof value === 'object' && Array.isArray(value.skills) && value.skills.length > 0) return { skills: value.skills }
  }
  return recover()
}

// ---------------------------------------------------------------- extraction
const EXTRACT_SYSTEM = [
  'You maintain a durable skill memory for ONE software workspace.',
  'You are given the workspace path, the repo roots, the skills already stored, and',
  'a finished conversation turn. Extract knowledge that makes FUTURE requests work',
  'in one shot.',
  '',
  'LANGUAGE: write name, description, instructions and triggers in the SAME',
  'language the conversation is conducted in. Never translate. In a mixed-language',
  'project, write the skill the way the people actually talked in this turn.',
  '',
  'IDENTIFIERS ARE EXACT: every function name, class name, symbol, file path and',
  'API name must be copied character for character from the source or tool output.',
  'Never fix, translate, pluralize or guess an identifier, and never copy a',
  'misspelling the user typed. If the user wrote "create rulez" but the real API is',
  'CreateRule, the skill must say CreateRule. If the correct spelling is not',
  'visible anywhere in the turn, leave that ref symbol empty instead of inventing it.',
  '',
  'REPO ROUTING: a ref names its repo. Use "self" only when the file lives under',
  'the workspace root. When the file lives in another repository listed in REPO',
  'ROOTS, use that alias as repo and give the path relative to that alias root.',
  '',
  'Extract these kinds of knowledge:',
  '- kind "api": a concrete entry point: the file, the class or function, and the',
  '  call pattern. Record it in refs.',
  '- kind "workflow": the sequence of steps or commands this project uses.',
  '- kind "gotcha": a trap, a required order of operations, or a repeat mistake.',
  '- kind "preference": how the user wants work done: language, format, style rules.',
  '- kind "note": anything durable that does not fit above.',
  '',
  'Set scope "global" ONLY for personal preferences that apply in every project',
  '(language, formatting, verbosity). Everything about this codebase is scope "workspace".',
  '',
  'refs entries look like {"repo":"self","path":"relative/path/From/That/Root.h","symbol":"Class::Method"}.',
  'Only record refs for paths and symbols that actually appeared in the turn.',
  '',
  'triggers are 3 to 8 short phrases that should load this skill later, using the',
  'words a person would naturally say when asking for it, in the conversation',
  'language. Include the exact identifier as one trigger when there is one, and',
  'include the user misspelling too so it still matches later.',
  '',
  'Set pinned true only for the one or two core entry-point maps of a workspace.',
  '',
  'Never store one-off task facts, temporary state, or secrets and credentials.',
  'If a stored skill already covers the lesson, choose action "update" with its exact target_id.',
  '',
  'Reply with STRICT JSON only. No prose, no markdown fence. Keep every string on',
  'one line: never put a raw newline inside a JSON string.',
  'Exact shape:',
  '{"skills":[{"action":"new","target_id":"","kind":"api","scope":"workspace","pinned":false,"name":"short name","description":"one line why","instructions":"imperative, self-contained rules","triggers":["phrase"],"refs":[{"repo":"self","path":"src/File.h","symbol":"Class::Method"}],"tags":["tag"],"confidence":0.0,"evidence":"short quote"}]}',
  'Return {"skills":[]} only when the turn carries nothing durable.',
].join('\n')

const REPAIR_SYSTEM = [
  'You convert text into a single valid JSON object. Reply with ONLY the JSON',
  'object, no prose and no code fence. Every string must stay on one line.',
].join('\n')

function combineInstructions(left, right) {
  const a = String(left || '').trim()
  const b = String(right || '').trim()
  if (a.length === 0) return b
  if (b.length === 0) return a
  if (a.indexOf(b) >= 0) return a
  if (b.indexOf(a) >= 0) return b
  if (wordOverlap(a, b) >= SIMILARITY_KEEP) return a.length >= b.length ? a : b
  return a + '\n' + b
}

function mergeSkill(existing, candidate) {
  const refKeys = new Set()
  const refs = []
  for (const ref of (existing.refs || []).concat(candidate.refs || [])) {
    const key = refKey(ref)
    if (refKeys.has(key)) continue
    refKeys.add(key)
    refs.push(ref)
  }
  const evidence = cleanEvidence(existing.evidence).concat(cleanEvidence(candidate.evidence))
  return {
    id: existing.id,
    workspace: existing.workspace,
    scope: existing.scope === 'global' || candidate.scope === 'global' ? 'global' : 'workspace',
    kind: candidate.kind === 'note' && existing.kind !== 'note' ? existing.kind : candidate.kind,
    name: candidate.name.length > 0 ? candidate.name : existing.name,
    description: candidate.description.length > 0 ? candidate.description : existing.description,
    instructions: combineInstructions(existing.instructions, candidate.instructions),
    triggers: cleanStrings((existing.triggers || []).concat(candidate.triggers || []), 10),
    refs: refs.slice(0, 8),
    tags: cleanStrings((existing.tags || []).concat(candidate.tags || []), 12),
    pinned: existing.pinned === true || candidate.pinned === true,
    source: existing.source === 'manual' ? 'manual' : 'auto',
    confidence: Math.max(existing.confidence || 0, candidate.confidence || 0),
    version: (existing.version || 1) + 1,
    uses: existing.uses || 0,
    created_at: existing.created_at,
    updated_at: Date.now(),
    evidence: cleanEvidence(evidence).slice(-3),
  }
}

function buildDigest(messages) {
  const lines = []
  for (const message of messages.slice(-DIGEST_MESSAGES)) {
    if (message.text.trim().length === 0) continue
    const role = message.role === 'assistant' ? 'ASSISTANT' : 'USER'
    lines.push(role + ': ' + clip(message.text, DIGEST_CHARS))
  }
  return lines.join('\n\n')
}

async function analyzeTurn(ctx, sessionId, cwd, digest, diag) {
  const state = await loadState(ctx, cwd)
  const existing = state.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    kind: skill.kind,
    description: skill.description,
    instructions: clip(skill.instructions, 400),
  }))
  const userText = [
    'WORKSPACE: ' + cwd,
    '',
    'REPO ROOTS (a path belongs to the alias whose root contains it):',
    describeRepoRoots(state.config, cwd),
    '',
    'EXISTING SKILLS (JSON):',
    JSON.stringify(existing),
    '',
    'FINISHED TURN:',
    digest,
  ].join('\n')
  let raw = await askModel(ctx, sessionId, EXTRACT_SYSTEM, userText, EXTRACT_MAX_TOKENS)
  diag.extractChars = raw.length
  diag.lastRaw = clip(raw, RAW_CLIP)
  let parsed = parseExtraction(raw, diag)
  if (parsed === undefined) {
    diag.extractRetries += 1
    try {
      const repairText = 'Convert this into one valid JSON object keeping every field:\n\n' + clip(raw, RAW_CLIP)
      const repaired = await askModel(ctx, sessionId, REPAIR_SYSTEM, repairText, EXTRACT_MAX_TOKENS)
      if (repaired.length > 0) {
        const second = parseExtraction(repaired, diag)
        if (second !== undefined) {
          parsed = second
          raw = repaired
          diag.lastRaw = clip(repaired, RAW_CLIP)
        }
      }
    } catch (error) {
      diag.extractParseError = diag.extractParseError.length > 0 ? diag.extractParseError : errorText(error)
    }
  }
  if (parsed === undefined) {
    diag.extractError = 'usable JSON not obtained: ' + (diag.extractParseError.length > 0 ? diag.extractParseError : 'unknown reason')
    console.log('[' + PLUGIN_NAME + '] extraction failed: ' + diag.extractError)
    return []
  }
  const applied = []
  for (const item of parsed.skills) {
    if (item === null || typeof item !== 'object') continue
    const refs = []
    if (Array.isArray(item.refs)) {
      for (const entry of item.refs) {
        const ref = normalizeRef(entry)
        if (ref !== undefined) refs.push(ref)
      }
    }
    const candidate = makeSkill({
      kind: typeof item.kind === 'string' ? item.kind : 'note',
      scope: item.scope === 'global' ? 'global' : 'workspace',
      pinned: item.pinned === true,
      name: typeof item.name === 'string' ? item.name : '',
      description: typeof item.description === 'string' ? item.description : '',
      instructions: typeof item.instructions === 'string' ? item.instructions : '',
      triggers: Array.isArray(item.triggers) ? item.triggers : [],
      refs: refs,
      tags: Array.isArray(item.tags) ? item.tags : [],
      confidence: typeof item.confidence === 'number' ? item.confidence : 0,
      evidence: typeof item.evidence === 'string' && item.evidence.length > 0 ? [item.evidence] : [],
      source: 'auto',
    }, cwd)
    if (candidate.name.length === 0 || candidate.instructions.trim().length === 0) continue
    if (candidate.confidence < MIN_CONFIDENCE) continue
    const targetId = typeof item.target_id === 'string' ? item.target_id : ''
    let index = -1
    if (item.action === 'update' && targetId.length > 0) index = state.skills.findIndex((skill) => skill.id === targetId)
    if (index < 0) {
      const lowerName = candidate.name.toLowerCase()
      index = state.skills.findIndex((skill) => skill.name.toLowerCase() === lowerName)
    }
    if (index >= 0) {
      const merged = mergeSkill(state.skills[index], candidate)
      state.skills[index] = merged
      applied.push({ action: 'update', id: merged.id, name: merged.name, version: merged.version })
    } else {
      state.skills.push(candidate)
      applied.push({ action: 'new', id: candidate.id, name: candidate.name, version: candidate.version })
    }
  }
  if (applied.length > 0) await persistState(ctx, cwd, state, diag)
  return applied
}

// ------------------------------------------------------------------- plugin
export default {
  inject: ['tools'],
  apply(ctx) {
    // Settings namespace. The Plugins settings section renders one card per
    // namespace the Host serves, so registering this namespace is what makes the
    // plugin appear there; the browser half registers the matching card under the
    // same key. `applies: 'live'` means a toggle takes effect without a restart.
    let settingsService
    let settingsRegistered = false
    let settingsError = ''
    let settingsPath = ''
    const registerNamespace = (candidate) => {
      if (candidate === undefined || candidate === null) return false
      if (typeof candidate.register !== 'function') {
        settingsPath = 'service found but register is ' + typeof candidate.register
        return false
      }
      candidate.register('skill-memory', z.object({
        enabled: z.boolean().default(true),
        recall: z.boolean().default(true),
        learn: z.boolean().default(true),
      }), { applies: 'live' })
      settingsService = candidate
      settingsRegistered = true
      return true
    }
    try {
      const direct = ctx.get('settings')
      if (registerNamespace(direct)) {
        settingsPath = 'direct at apply time'
      } else {
        settingsPath = 'direct read returned ' + String(direct === undefined ? 'undefined' : typeof direct)
        // The provider may not be visible from this fiber yet; wait for it instead
        // of giving up, which is what a missing registration looked like.
        if (typeof ctx.inject === 'function') {
          ctx.inject(['settings'], (scoped) => {
            try {
              if (registerNamespace(scoped.get('settings'))) settingsPath = 'deferred via ctx.inject'
            } catch (error) {
              settingsError = errorText(error)
            }
          })
        } else {
          settingsPath += ' and ctx.inject is ' + typeof ctx.inject
        }
      }
    } catch (error) {
      settingsError = errorText(error)
      console.log('[' + PLUGIN_NAME + '] settings registration failed: ' + settingsError)
    }

    // Resolved settings, re-read on every use so a live toggle needs no cache
    // invalidation. `enabled` is the master switch; `recall` and `learn` gate the
    // two automatic halves independently.
    function flags() {
      const fallback = { enabled: true, recall: true, learn: true }
      if (settingsService === undefined) return fallback
      let value
      try {
        value = settingsService.get('skill-memory')
      } catch (error) {
        return fallback
      }
      if (value === null || typeof value !== 'object') return fallback
      return {
        enabled: value.enabled !== false,
        recall: value.recall !== false,
        learn: value.learn !== false,
      }
    }

    const buffers = new Map()
    const lastQuery = new Map()
    const jobs = { pending: 0, chain: Promise.resolve() }
    const diag = {
      preStep: 0, injected: 0, noQuery: 0, noWorkspace: 0, noHits: 0, preStepError: '',
      sessionEvents: 0, userMessages: 0, assistantMessages: 0, turnsCompleted: 0,
      extractRuns: 0, extractApplied: 0, extractChars: 0, extractError: '', lastRaw: '',
      extractParseError: '', extractRetries: 0, extractDupRepairs: 0,
      lastEnteringKinds: '', lastQueryText: '', lastRecallScores: '',
      refStats: 0, refStatErrors: 0, refStatError: '',
      refRepoRepairs: 0, refRepoRepairList: [],
      symbolVerified: 0, symbolMissing: 0, symbolMissingList: [],
      skippedDisabled: 0, learnSkipped: 0,
    }

    async function workspaceFor(sessionId) {
      const sessions = ctx.get('sessions')
      if (sessions !== undefined && typeof sessionId === 'string' && sessionId.length > 0) {
        try {
          const session = sessions.get(sessionId)
          const header = session === undefined ? undefined : session.header
          if (header !== null && header !== undefined && typeof header.cwd === 'string' && header.cwd.length > 0) return header.cwd
        } catch (error) {
          // Fall through to the process working directory.
        }
      }
      const fs = ctx.get('fs')
      if (fs !== undefined) {
        try {
          const target = await fs.resolve('.', {})
          const path = fs.processPath(target)
          if (typeof path === 'string' && path.length > 0) return path
        } catch (error) {
          // No fallback available.
        }
      }
      return ''
    }

    function enqueueJob(label, run) {
      if (jobs.pending >= MAX_PENDING_JOBS) {
        console.log('[' + PLUGIN_NAME + '] dropping ' + label + ', ' + jobs.pending + ' background jobs already queued')
        return
      }
      jobs.pending += 1
      jobs.chain = jobs.chain
        .then(run)
        .catch((error) => {
          diag.extractError = errorText(error)
          console.log('[' + PLUGIN_NAME + '] ' + label + ' failed: ' + diag.extractError)
        })
        .then(() => { jobs.pending -= 1 })
    }

    ctx.on('session/event', (session, event) => {
      try {
        if (session === undefined || session === null || event === undefined || event === null) return
        const sessionId = typeof session.id === 'string' ? session.id : ''
        if (sessionId.length === 0) return
        const header = session.header
        const cwd = header !== null && header !== undefined && typeof header.cwd === 'string' ? header.cwd : ''
        if (cwd.length === 0) return
        diag.sessionEvents += 1
        let buffer = buffers.get(sessionId)
        if (buffer === undefined) {
          buffer = { cwd: cwd, messages: [] }
          buffers.set(sessionId, buffer)
        }
        buffer.cwd = cwd
        const push = (role, text) => {
          if (text.length === 0) return
          buffer.messages.push({ role: role, text: clip(text, DIGEST_CHARS) })
          if (buffer.messages.length > DIGEST_MESSAGES) buffer.messages.splice(0, buffer.messages.length - DIGEST_MESSAGES)
        }
        if (event.type === 'user/message') {
          if (sourceKind(event.data) === 'tool') return
          diag.userMessages += 1
          push('user', messageText(event.data))
          return
        }
        if (event.type === 'assistant/message') {
          const data = event.data
          const message = data !== null && typeof data === 'object' ? data.message : undefined
          diag.assistantMessages += 1
          push('assistant', messageText(message))
          return
        }
        if (event.type !== 'turn/end') return
        const data = event.data
        const reason = data !== null && typeof data === 'object' ? data.reason : undefined
        const completed = reason !== null && reason !== undefined && reason.kind === 'completed'
        const messages = buffer.messages.slice()
        buffer.messages = []
        lastQuery.delete(sessionId)
        if (!completed) return
        diag.turnsCompleted += 1
        const hasUser = messages.some((message) => message.role === 'user')
        const hasAssistant = messages.some((message) => message.role === 'assistant')
        if (!hasUser || !hasAssistant) return
        const digest = buildDigest(messages)
        if (digest.length < 80) return
        const workspace = buffer.cwd
        const learnFlags = flags()
        if (!learnFlags.enabled || !learnFlags.learn) {
          diag.learnSkipped += 1
          return
        }
        enqueueJob('skill extraction', async () => {
          diag.extractRuns += 1
          const applied = await analyzeTurn(ctx, sessionId, workspace, digest, diag)
          diag.extractApplied += applied.length
          if (applied.length > 0) {
            const summary = applied.map((entry) => entry.action + ':' + entry.name + ' v' + entry.version).join(', ')
            console.log('[' + PLUGIN_NAME + '] learned ' + applied.length + ' skill(s) in ' + workspace + ' -> ' + summary)
          }
        })
      } catch (error) {
        diag.extractError = errorText(error)
        console.log('[' + PLUGIN_NAME + '] session/event observer failed: ' + diag.extractError)
      }
    })

    ctx.on('agent/pre-step', async (payload, next) => {
      diag.preStep += 1
      const decision = await next()
      const liveFlags = flags()
      if (!liveFlags.enabled || !liveFlags.recall) {
        diag.skippedDisabled += 1
        return decision
      }
      try {
        if (decision === undefined || decision === null || decision.kind !== 'enter') return decision
        const proposed = Array.isArray(decision.messages) ? decision.messages : (payload !== undefined && payload !== null && Array.isArray(payload.messages) ? payload.messages : [])
        const agent = payload === undefined || payload === null ? undefined : payload.agent
        const sessionId = agent !== null && agent !== undefined && typeof agent.id === 'string' ? agent.id : ''
        const kinds = []
        for (const message of proposed) kinds.push(sourceKind(message))
        diag.lastEnteringKinds = kinds.join(',')
        let query = ''
        for (let index = proposed.length - 1; index >= 0; index -= 1) {
          if (sourceKind(proposed[index]) === 'tool') continue
          const text = messageText(proposed[index])
          if (text.length >= 4) {
            query = text
            break
          }
        }
        if (query.length >= 4) {
          lastQuery.set(sessionId, query)
        } else {
          const remembered = lastQuery.get(sessionId)
          if (typeof remembered === 'string') query = remembered
        }
        if (query.length < 4) {
          diag.noQuery += 1
          return decision
        }
        diag.lastQueryText = clip(query, 120)
        const cwd = await workspaceFor(sessionId)
        if (cwd.length === 0) {
          diag.noWorkspace += 1
          return decision
        }
        const state = await loadState(ctx, cwd)
        const recalled = await recall(ctx, cwd, state, query)
        const scores = []
        for (const hit of recalled.hits) scores.push(hit.name + '=' + hit.score.toFixed(2))
        diag.lastRecallScores = scores.join(', ')
        if (recalled.text.length === 0) {
          diag.noHits += 1
          return decision
        }
        const recallMessage = {
          id: uniqueId('msg'),
          role: 'user',
          content: [{ type: 'text', text: recalled.text }],
          source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'recall' },
        }
        diag.injected += 1
        console.log('[' + PLUGIN_NAME + '] recalled ' + recalled.hits.length + ' skill(s) for ' + cwd)
        return { kind: 'enter', messages: proposed.concat([recallMessage]) }
      } catch (error) {
        diag.preStepError = errorText(error)
        console.log('[' + PLUGIN_NAME + '] pre-step recall failed: ' + diag.preStepError)
        return decision
      }
    })

    const tool = {
      name: 'skill_memory',
      description: 'Inspect or edit the automatic workspace skill memory. Actions: list, search a query, recall (preview the exact injected block), check (verify entry points resolve and their symbols exist), probe (run one extraction model call on supplied conversation text), add, forget, pin (set the pinned flag), stats, diag (hook counters, config source and store status).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'search', 'recall', 'check', 'probe', 'add', 'forget', 'pin', 'stats', 'diag'], description: 'Operation to perform.' },
          query: { type: 'string', description: 'Query for search/recall; conversation text for probe.' },
          name: { type: 'string', description: 'Skill name for add.' },
          description: { type: 'string', description: 'One-line reason for add.' },
          instructions: { type: 'string', description: 'Imperative instructions for add.' },
          kind: { type: 'string', enum: ['api', 'workflow', 'gotcha', 'preference', 'note'], description: 'Knowledge kind for add.' },
          scope: { type: 'string', enum: ['workspace', 'global'], description: 'workspace for project knowledge, global for personal preferences.' },
          triggers: { type: 'array', items: { type: 'string' }, description: 'Phrases that should load this skill, in the language you actually speak.' },
          refs: { type: 'array', items: { type: 'string' }, description: 'Entry points as repo:relative/path.h :: Class::Method, where repo is self or a configured alias.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for add.' },
          id: { type: 'string', description: 'Skill id for forget or pin.' },
          pinned: { type: 'boolean', description: 'Pinned value for action=pin.' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            action: { type: 'string' },
            workspace: { type: 'string' },
            store: { type: 'string' },
            total: { type: 'integer' },
            count: { type: 'integer' },
            message: { type: 'string' },
            preview: { type: 'string' },
            skills: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  kind: { type: 'string' },
                  scope: { type: 'string' },
                  pinned: { type: 'boolean' },
                  description: { type: 'string' },
                  instructions: { type: 'string' },
                  triggers: { type: 'array', items: { type: 'string' } },
                  refs: { type: 'array', items: { type: 'string' } },
                  tags: { type: 'array', items: { type: 'string' } },
                  source: { type: 'string' },
                  confidence: { type: 'number' },
                  version: { type: 'integer' },
                  uses: { type: 'integer' },
                  score: { type: 'number' },
                },
              },
            },
          },
        },
        render: (args, value) => {
          const lines = []
          lines.push('skill_memory ' + value.action + ': ' + value.message)
          lines.push('workspace: ' + value.workspace)
          lines.push('store: ' + value.store + ' (' + value.total + ' stored, ' + value.count + ' shown)')
          for (const skill of value.skills) {
            lines.push('')
            const score = skill.score > 0 ? ', score ' + skill.score.toFixed(2) : ''
            const pinned = skill.pinned ? ', pinned' : ''
            lines.push('- ' + skill.name + ' [' + skill.kind + '/' + skill.scope + '/' + skill.source + ' v' + skill.version + pinned + score + ']')
            if (skill.id.length > 0) lines.push('  id: ' + skill.id)
            if (skill.description.length > 0) lines.push('  why: ' + skill.description)
            if (skill.triggers.length > 0) lines.push('  triggers: ' + skill.triggers.join(' | '))
            for (const ref of skill.refs) lines.push('  ref: ' + ref)
            if (skill.instructions.length > 0) lines.push('  how: ' + clip(skill.instructions, 600))
          }
          if (value.preview.length > 0) {
            lines.push('')
            lines.push('preview:')
            lines.push(value.preview)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      timeoutMs: 60000,
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        const agent = exec === null || exec === undefined ? undefined : exec.agent
        const sessionId = agent !== null && agent !== undefined && typeof agent.id === 'string' ? agent.id : ''
        const cwd = await workspaceFor(sessionId)
        const state = await loadState(ctx, cwd)
        const path = joinPath(cwd, LOCAL_FILE)
        const total = state.skills.length
        if (args.action === 'diag') {
          const aliasNames = Object.keys(state.config.aliases)
          const summary = [
            'pre-step calls ' + diag.preStep + ' (injected ' + diag.injected + ', no query ' + diag.noQuery + ', no workspace ' + diag.noWorkspace + ', no hits ' + diag.noHits + ')',
            'pre-step error: ' + (diag.preStepError.length > 0 ? diag.preStepError : 'none'),
            'entering kinds: ' + (diag.lastEnteringKinds.length > 0 ? diag.lastEnteringKinds : 'n/a'),
            'last query: ' + (diag.lastQueryText.length > 0 ? diag.lastQueryText : 'n/a'),
            'last scores: ' + (diag.lastRecallScores.length > 0 ? diag.lastRecallScores : 'n/a'),
            'session events ' + diag.sessionEvents + ' (human ' + diag.userMessages + ', assistant ' + diag.assistantMessages + ')',
            'completed turns ' + diag.turnsCompleted,
            'extraction runs ' + diag.extractRuns + ', applied ' + diag.extractApplied + ', last reply chars ' + diag.extractChars + ', repair retries ' + diag.extractRetries + ', duplicate-key repairs ' + diag.extractDupRepairs,
            'parse error: ' + (diag.extractParseError.length > 0 ? diag.extractParseError : 'none') + ', extraction error: ' + (diag.extractError.length > 0 ? diag.extractError : 'none'),
            'refs captured ' + diag.refStats + ', stat errors ' + diag.refStatErrors + (diag.refStatError.length > 0 ? ' (' + diag.refStatError + ')' : ''),
            'repo repairs ' + diag.refRepoRepairs + (diag.refRepoRepairList.length > 0 ? ' -> ' + diag.refRepoRepairList.join(' ; ') : ''),
            'symbols verified ' + diag.symbolVerified + ', not found ' + diag.symbolMissing + (diag.symbolMissingList.length > 0 ? ' -> ' + diag.symbolMissingList.join(' ; ') : ''),
            'settings namespace: ' + (settingsRegistered ? 'skill-memory registered via ' + (settingsPath.length > 0 ? settingsPath : 'unknown path') : 'not registered (' + settingsPath + ')' + (settingsError.length > 0 ? ' error=' + settingsError : '')) + ', flags: ' + (function () { const f = flags(); return 'enabled=' + f.enabled + ' recall=' + f.recall + ' learn=' + f.learn })(),
            'gated off: recall skipped ' + diag.skippedDisabled + ', learning skipped ' + diag.learnSkipped,
            'config file: ' + (state.config.configRead ? state.config.configFile : 'none'),
            'aliases: ' + (aliasNames.length > 0 ? aliasNames.join(', ') : 'none'),
            'global store: ' + (state.globalResolved.length > 0 ? state.globalResolved : 'disabled') + ' (source: ' + (state.config.globalSource.length > 0 ? state.config.globalSource : 'not configured') + ') readable=' + state.globalRead + ' writable=' + state.globalWritable + (state.globalError.length > 0 ? ' error=' + state.globalError : ''),
          ].join(' | ')
          return { ok: true, action: 'diag', workspace: cwd, store: path, total: total, count: 0, message: summary, preview: diag.lastRaw.length > 0 ? 'last extractor reply:\n' + diag.lastRaw : '', skills: [] }
        }
        if (args.action === 'list') {
          return { ok: true, action: 'list', workspace: cwd, store: path, total: total, count: total, message: 'stored skills', preview: '', skills: state.skills.map((skill) => serializeSkill(skill, 0)) }
        }
        if (args.action === 'check') {
          const notes = await checkRefs(ctx, cwd, state)
          return {
            ok: true, action: 'check', workspace: cwd, store: path, total: total, count: notes.length,
            message: notes.length === 0 ? 'all entry points resolve, are unchanged, and their symbols exist' : notes.length + ' note(s)',
            preview: notes.join('\n'), skills: [],
          }
        }
        if (args.action === 'stats') {
          let auto = 0
          let pinned = 0
          for (const skill of state.skills) {
            if (skill.source === 'auto') auto += 1
            if (skill.pinned) pinned += 1
          }
          const top = state.skills.slice().sort((a, b) => (b.uses || 0) - (a.uses || 0)).slice(0, 5)
          return {
            ok: true, action: 'stats', workspace: cwd, store: path, total: total, count: top.length,
            message: auto + ' learned automatically, ' + (total - auto) + ' manual, ' + pinned + ' pinned',
            preview: '', skills: top.map((skill) => serializeSkill(skill, 0)),
          }
        }
        if (args.action === 'search' || args.action === 'recall') {
          const query = typeof args.query === 'string' ? args.query : ''
          if (query.trim().length === 0) {
            return { ok: false, action: args.action, workspace: cwd, store: path, total: total, count: 0, message: 'query is required', preview: '', skills: [] }
          }
          const recalled = await recall(ctx, cwd, state, query)
          return {
            ok: true, action: args.action, workspace: cwd, store: path, total: total, count: recalled.hits.length,
            message: recalled.hits.length + ' skill(s): ' + recalled.nonPinnedCount + ' matched, ' + recalled.pinnedCount + ' pinned',
            preview: recalled.text, skills: recalled.hits,
          }
        }
        if (args.action === 'probe') {
          const digest = typeof args.query === 'string' ? args.query : ''
          if (digest.trim().length < 20) {
            return { ok: false, action: 'probe', workspace: cwd, store: path, total: total, count: 0, message: 'pass the conversation text to analyze in query (at least 20 chars)', preview: '', skills: [] }
          }
          diag.extractRuns += 1
          const applied = await analyzeTurn(ctx, sessionId, cwd, digest, diag)
          diag.extractApplied += applied.length
          const names = applied.map((entry) => entry.action + ':' + entry.name + ' v' + entry.version).join(', ')
          const message = 'model reply ' + diag.extractChars + ' chars, applied ' + applied.length + (names.length > 0 ? ' -> ' + names : '') + (diag.extractError.length > 0 ? ', error: ' + diag.extractError : '')
          const shown = []
          for (const skill of state.skills) {
            if (applied.some((entry) => entry.id === skill.id)) shown.push(serializeSkill(skill, 0))
          }
          return { ok: true, action: 'probe', workspace: cwd, store: path, total: state.skills.length, count: applied.length, message: message, preview: diag.lastRaw, skills: shown }
        }
        if (args.action === 'add') {
          const name = typeof args.name === 'string' ? args.name.trim() : ''
          const instructions = typeof args.instructions === 'string' ? args.instructions.trim() : ''
          if (name.length === 0 || instructions.length === 0) {
            return { ok: false, action: 'add', workspace: cwd, store: path, total: total, count: 0, message: 'name and instructions are required for add', preview: '', skills: [] }
          }
          const refs = []
          for (const text of Array.isArray(args.refs) ? args.refs : []) {
            const ref = parseRefString(text)
            if (ref !== undefined) refs.push(ref)
          }
          const skill = makeSkill({
            kind: typeof args.kind === 'string' ? args.kind : 'note',
            scope: args.scope === 'global' ? 'global' : 'workspace',
            name: name,
            description: typeof args.description === 'string' ? args.description : '',
            instructions: instructions,
            triggers: Array.isArray(args.triggers) ? args.triggers : [],
            refs: refs,
            tags: Array.isArray(args.tags) ? args.tags : [],
            pinned: args.pinned === true,
            confidence: 1,
            source: 'manual',
          }, cwd)
          const lowerName = name.toLowerCase()
          const index = state.skills.findIndex((entry) => entry.name.toLowerCase() === lowerName)
          if (index >= 0) {
            const merged = mergeSkill(state.skills[index], skill)
            state.skills[index] = merged
            await persistState(ctx, cwd, state, diag)
            return { ok: true, action: 'add', workspace: cwd, store: path, total: state.skills.length, count: 1, message: 'merged into the existing skill ' + name, preview: '', skills: [serializeSkill(merged, 0)] }
          }
          state.skills.push(skill)
          await persistState(ctx, cwd, state, diag)
          return { ok: true, action: 'add', workspace: cwd, store: path, total: state.skills.length, count: 1, message: 'stored ' + name, preview: '', skills: [serializeSkill(skill, 0)] }
        }
        if (args.action === 'pin') {
          const id = typeof args.id === 'string' ? args.id : ''
          const index = state.skills.findIndex((skill) => skill.id === id)
          if (index < 0) {
            return { ok: false, action: 'pin', workspace: cwd, store: path, total: total, count: 0, message: 'no skill with id ' + id, preview: '', skills: [] }
          }
          state.skills[index].pinned = args.pinned !== false
          state.skills[index].updated_at = Date.now()
          await persistState(ctx, cwd, state, diag)
          const verb = state.skills[index].pinned ? 'pinned' : 'unpinned'
          return { ok: true, action: 'pin', workspace: cwd, store: path, total: state.skills.length, count: 1, message: verb + ' ' + state.skills[index].name, preview: '', skills: [serializeSkill(state.skills[index], 0)] }
        }
        if (args.action === 'forget') {
          const id = typeof args.id === 'string' ? args.id : ''
          const before = state.skills.length
          state.skills = state.skills.filter((skill) => skill.id !== id)
          if (state.skills.length === before) {
            return { ok: false, action: 'forget', workspace: cwd, store: path, total: before, count: 0, message: 'no skill with id ' + id, preview: '', skills: [] }
          }
          await persistState(ctx, cwd, state, diag)
          return { ok: true, action: 'forget', workspace: cwd, store: path, total: state.skills.length, count: 0, message: 'removed ' + id, preview: '', skills: [] }
        }
        return { ok: false, action: String(args.action), workspace: cwd, store: path, total: total, count: 0, message: 'unsupported action', preview: '', skills: [] }
      },
    }
    ctx.effect(() => ctx.tools.register(tool), PLUGIN_NAME + ' skill_memory tool')

    console.log('[' + PLUGIN_NAME + '] active, workspace store=' + LOCAL_FILE + ', config=' + CONFIG_FILE)
  },
}
