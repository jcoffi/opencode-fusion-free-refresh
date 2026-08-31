import type { Plugin } from "@opencode-ai/plugin"
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Keeps the model pins inside the openrouter/fusion "free" and "free-fast"
// variants current. Two TTLs:
//
//   FETCH (MEM_TTL_MS): live data is fetched at most every 6h; between
//   fetches the cached ranking is used.
//
//   FILE (every startup): the current selection is written to
//   ~/.config/opencode/opencode.json whenever it differs from what the file
//   holds. The running process already loaded its config - the write is for
//   the NEXT launch and for independent agents that read the file directly.
//   Delisted pins are detected and reported in the status, but any selection
//   drift (ranking changes included) syncs the file.
//
// Eligibility is catalog membership ONLY. A temporarily-down model stays
// eligible everywhere, analyst included - OpenRouter recovers; we do not
// health-probe and downtime never triggers anything.
//
// Selection: live catalog :free models (tool-capable, >=64k context) ranked by
// the previous day's token volume from /api/v1/datasets/rankings-daily.
// Rank #1 -> analyst (`model`); next ranks -> `analysis_models` (3 free, 2 free-fast).
//
// Write strategy: surgical text replacement of only the two analysis_models
// arrays and model values, located by brace-matching the variant block. The
// rest of opencode.json stays byte-identical. Every anchor is occurrence-
// asserted (exactly 1) and any mismatch aborts the whole write. A .bak is
// written before each change; the write is atomic (tmp+rename).
//
// Failure policy: any error leaves both file and config untouched.

const MEM_TTL_MS = 6 * 60 * 60 * 1000 // in-memory refresh: fetch at most every 6h
const FETCH_TIMEOUT_MS = 8000
const MIN_MODELS = 4
const MIN_CONTEXT = 65536
const PANEL = { free: 3, "free-fast": 2 } as const

type Cache = {
  ts: number
  models: string[] // ranked catalog ids, best first
  catalog: string[] // ALL live :free ids at fetch time (delisting check on cache hits)
  last_error?: string
  applied?: { analyst: string; free: string[]; freeFast: string[] }
  file?: string // stable | written(...) | failed: ...
}

const configPath = () =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "opencode.json")

const cacheFile = () =>
  join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode", "fusion-free-refresh.json")

function readCache(): Cache | undefined {
  try {
    if (!existsSync(cacheFile())) return undefined
    const raw = JSON.parse(readFileSync(cacheFile(), "utf8")) as Cache
    if (
      Array.isArray(raw.models) &&
      raw.models.every((m) => typeof m === "string") &&
      Array.isArray(raw.catalog) &&
      raw.catalog.every((m) => typeof m === "string")
    )
      return raw
  } catch {}
  return undefined
}

function writeCache(cache: Cache) {
  try {
    mkdirSync(join(cacheFile(), ".."), { recursive: true })
    writeFileSync(cacheFile(), JSON.stringify(cache, null, 2))
  } catch {}
}

function apiKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY
  try {
    const auth = JSON.parse(
      readFileSync(
        join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "auth.json"),
        "utf8",
      ),
    ) as { openrouter?: { key?: unknown } }
    if (typeof auth.openrouter?.key === "string") return auth.openrouter.key
  } catch {}
  return undefined
}

async function getJSON(url: string, token?: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res.json()
}

async function fetchLive(): Promise<{ models: string[]; catalog: string[] }> {
  const key = apiKey()
  if (!key) throw new Error("no OpenRouter API key in env or auth.json")

  const [catalogRaw, rankingsRaw] = await Promise.all([
    getJSON("https://openrouter.ai/api/v1/models"),
    getJSON("https://openrouter.ai/api/v1/datasets/rankings-daily", key),
  ])

  // rankings use dated permaslugs: catalog canonical_slug + ":free"
  const catalog: string[] = []
  const byPermaslug = new Map<string, { id: string; ctx: number }>()
  for (const entry of (catalogRaw as { data?: unknown[] }).data ?? []) {
    const m = entry as {
      id?: string
      canonical_slug?: string
      context_length?: number
      supported_parameters?: string[]
    }
    if (!m.id?.endsWith(":free")) continue
    catalog.push(m.id)
    if (!m.canonical_slug) continue
    if (!m.supported_parameters?.includes("tools")) continue
    if ((m.context_length ?? 0) < MIN_CONTEXT) continue
    byPermaslug.set(`${m.canonical_slug}:free`, { id: m.id, ctx: m.context_length ?? 0 })
  }

  const rows = (rankingsRaw as { data?: unknown[] }).data ?? []
  let latest = ""
  for (const r of rows) {
    const d = (r as { date?: string }).date
    if (d && d > latest) latest = d
  }
  const tokens = new Map<string, number>()
  for (const r of rows) {
    const row = r as { date?: string; model_permaslug?: string; total_tokens?: string }
    if (row.date !== latest || !row.model_permaslug?.endsWith(":free")) continue
    tokens.set(row.model_permaslug, Number(row.total_tokens ?? 0))
  }

  const models = [...byPermaslug.entries()]
    .map(([permaslug, m]) => ({ ...m, tokens: tokens.get(permaslug) ?? 0 }))
    .sort((a, b) => b.tokens - a.tokens || b.ctx - a.ctx)
    .map((m) => m.id)

  if (models.length < MIN_MODELS) throw new Error(`only ${models.length} eligible free models`)
  return { models, catalog }
}

async function getSelection(): Promise<Cache | undefined> {
  const cached = readCache()
  if (cached && Date.now() - cached.ts < MEM_TTL_MS && cached.models.length >= MIN_MODELS) {
    return cached
  }
  try {
    const live = await fetchLive()
    return { ts: Date.now(), models: live.models, catalog: live.catalog }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (cached && cached.models.length >= MIN_MODELS) {
      return { ...cached, last_error: `stale cache used: ${message}` }
    }
    writeCache({ ts: Date.now(), models: [], catalog: [], last_error: message })
    return undefined
  }
}

// --- surgical file edit -------------------------------------------------

function countOf(text: string, needle: string) {
  return text.split(needle).length - 1
}

// index of the "}" closing the object whose "{" is at or after `from`
function blockEnd(text: string, from: number): number {
  let depth = 0
  let inStr = false
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (c === "\\") i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === "{") depth++
    else if (c === "}" && --depth === 0) return i
  }
  return -1
}

function replacePins(text: string, variant: string, analyst: string, panel: string[]): string {
  const anchor = `"${variant}": {`
  const hits = countOf(text, anchor)
  if (hits !== 1) throw new Error(`anchor ${anchor} matched ${hits}x, expected 1`)

  const keyIdx = text.indexOf(anchor)
  const end = blockEnd(text, keyIdx + anchor.length - 1)
  if (end === -1) throw new Error(`unbalanced braces for ${variant}`)
  const block = text.slice(keyIdx, end)

  if (countOf(block, '"analysis_models"') !== 1) throw new Error(`${variant}: analysis_models not 1x`)
  if (countOf(block, '"model":') !== 1) throw new Error(`${variant}: model not 1x`)

  const amIdx = text.indexOf('"analysis_models"', keyIdx)
  const arrOpen = text.indexOf("[", amIdx)
  const arrClose = text.indexOf("]", arrOpen)
  const modKey = '"model": "'
  const modIdx = text.indexOf(modKey, arrClose)
  if (arrOpen === -1 || arrClose === -1 || modIdx === -1 || modIdx > end)
    throw new Error(`${variant}: could not locate pins`)
  const modStart = modIdx + modKey.length
  const modEnd = text.indexOf('"', modStart)

  const indent = text.slice(text.lastIndexOf("\n", amIdx) + 1, amIdx)
  const arr = `[\n${panel.map((m) => `${indent}  "${m}"`).join(",\n")}\n${indent}]`

  return (
    text.slice(0, arrOpen) +
    arr +
    text.slice(arrClose + 1, modStart) +
    analyst +
    text.slice(modEnd)
  )
}

type FusionEntry = { id?: string; analysis_models?: string[]; model?: string }

function fusionEntry(variant: unknown): FusionEntry | undefined {
  const plugins = (variant as { plugins?: unknown[] })?.plugins
  if (!Array.isArray(plugins)) return undefined
  return plugins.find((p) => (p as FusionEntry)?.id === "fusion") as FusionEntry | undefined
}

// Optional standalone alias model whose options carry the same free fusion
// config, so the free panel is selectable directly from the model list
// (opencode does not surface variants as selectable models).
const ALIAS = "openrouter/fusion-free"

// pins currently in the FILE (not the session config, which we may have mutated)
function filePins(raw: string): string[] {
  const parsed = JSON.parse(raw) as {
    provider?: {
      openrouter?: {
        models?: Record<string, { variants?: Record<string, unknown>; options?: unknown }>
      }
    }
  }
  const models = parsed.provider?.openrouter?.models
  const variants = models?.["openrouter/fusion"]?.variants
  const pins: string[] = []
  const collect = (entry: FusionEntry | undefined) => {
    if (entry?.model) pins.push(entry.model)
    for (const m of entry?.analysis_models ?? []) pins.push(m)
  }
  for (const name of ["free", "free-fast"]) collect(fusionEntry(variants?.[name]))
  collect(fusionEntry(models?.[ALIAS]?.options))
  return [...new Set(pins)]
}

function hasAlias(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as {
      provider?: { openrouter?: { models?: Record<string, { options?: unknown }> } }
    }
    return Boolean(fusionEntry(parsed.provider?.openrouter?.models?.[ALIAS]?.options))
  } catch {
    return false
  }
}

// Sync the file to the current selection; write only when content differs.
function persistSelection(catalog: string[], analyst: string, free: string[], freeFast: string[]): string {
  const path = configPath()
  const original = readFileSync(path, "utf8")

  const live = new Set(catalog)
  const delisted = filePins(original).filter((pin) => !live.has(pin))

  let next = replacePins(original, "free", analyst, free)
  next = replacePins(next, "free-fast", analyst, freeFast)
  if (hasAlias(original)) next = replacePins(next, ALIAS, analyst, free)
  if (next === original) return "stable"

  JSON.parse(next) // never write invalid JSON

  copyFileSync(path, `${path}.bak`)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, next)
  renameSync(tmp, path) // atomic
  return delisted.length > 0 ? `written(delisted: ${delisted.join(", ")})` : "written(ranking drift)"
}

// --- plugin -------------------------------------------------------------

export default (async () => {
  return {
    config: async (cfg) => {
      try {
        const variants = (
          cfg as {
            provider?: {
              openrouter?: { models?: Record<string, { variants?: Record<string, unknown> }> }
            }
          }
        ).provider?.openrouter?.models?.["openrouter/fusion"]?.variants
        if (!variants) return

        const free = fusionEntry(variants["free"])
        const freeFast = fusionEntry(variants["free-fast"])
        if (!free || !freeFast) return

        const cache = await getSelection()
        if (!cache) return

        const [analyst, ...rest] = cache.models
        const freePanel = rest.slice(0, PANEL.free)
        const fastPanel = rest.slice(0, PANEL["free-fast"])
        if (freePanel.length < PANEL.free || fastPanel.length < PANEL["free-fast"]) return

        // tier 1: in-memory, every startup
        free.model = analyst
        free.analysis_models = freePanel
        freeFast.model = analyst
        freeFast.analysis_models = fastPanel

        // tier 2: file, synced every startup (write only if content differs)
        let file: string
        try {
          file = persistSelection(cache.catalog, analyst, freePanel, fastPanel)
        } catch (error) {
          file = `failed: ${error instanceof Error ? error.message : String(error)}`
        }

        cache.applied = { analyst, free: freePanel, freeFast: fastPanel }
        cache.file = file
        writeCache(cache)
      } catch {
        // Refresh must never disrupt startup.
      }
    },
  }
}) satisfies Plugin
