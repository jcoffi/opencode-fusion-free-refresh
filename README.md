# opencode-fusion-free-refresh

An [opencode](https://opencode.ai) plugin that keeps the model pins inside the
OpenRouter `openrouter/fusion` `free` and `free-fast` variants current, and
persists them to `~/.config/opencode/opencode.json`.

## Why

OpenRouter's free tier rotates: free models get delisted within days to weeks.
Fusion panels **fail open** — a delisted panel member is silently dropped, so a
"deliberation" quietly degrades toward a single-model answer with no error. A
delisted **analyst** (`model` field) hard-errors the whole variant.

This plugin re-selects pins from live data and heals the config file, which is
also read directly by independent agents.

## How it works

Two TTLs:

- **Fetch (6h):** live data is fetched at most every 6 hours, cached in
  `~/.cache/opencode/fusion-free-refresh.json`.
- **File (every startup):** the current selection is written to
  `opencode.json` whenever it differs from the file (ranking drift or
  delisting). The running process already loaded its config — the write serves
  the next launch and external readers.

Selection: live catalog `:free` models (tool-capable, ≥64k context) ranked by
the previous day's token volume from `/api/v1/datasets/rankings-daily`.
Rank #1 becomes the analyst; the next ranks fill the panels (3 for `free`,
2 for `free-fast`).

Eligibility is **catalog membership only**. A temporarily-down model stays
eligible everywhere, analyst included — OpenRouter recovers; downtime never
triggers anything. Only delisting matters.

File writes are surgical: anchor + brace-matched location of the two pin
blocks, occurrence-asserted (any mismatch aborts the whole write), the rest of
the file stays byte-identical, `.bak` before each write, atomic tmp+rename,
JSON-validated before commit. Any error leaves file and config untouched.

## Requirements

- An `openrouter/fusion` entry in `opencode.json` with `free` and `free-fast`
  variants carrying a `{ "id": "fusion" }` plugin entry (the plugin edits
  those pins in place; it never creates structure).
- An OpenRouter API key: `OPENROUTER_API_KEY` in the environment, or an
  `openrouter` entry in opencode's `auth.json` (used for the rankings
  endpoint; the model catalog needs no auth).

## Install

```json
{
  "plugin": ["opencode-fusion-free-refresh"]
}
```

Note: opencode skips external plugins under `--pure`; such instances still
read the last-synced pins from the config file.

## Status

Inspect `~/.cache/opencode/fusion-free-refresh.json`:

- `file`: `stable` | `written(ranking drift)` | `written(delisted: ...)` | `failed: ...`
- `applied`: the analyst and panels applied to the session config
- `last_error`: fetch failures (stale cache is used when available)
