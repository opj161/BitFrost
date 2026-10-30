// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { ProviderEnv } from './provider.ts'
import { PROVIDERS } from './providers/index.ts'
import { startTimeOf } from './process.ts'
import { FEATURES, EFFORTS, claudeModelId, pendingFeatures } from './features.ts'
export { VERSION } from './version.ts'

const HOME = os.homedir()
export const RUN_DIR = process.env.BITFROST_RUNTIME_DIR || path.join(process.env.XDG_RUNTIME_DIR || `/tmp/bitfrost-${process.getuid!()}`, 'bitfrost')
export const DATA_DIR = process.env.BITFROST_DATA_DIR || (process.platform === 'darwin'
  ? path.join(HOME, 'Library', 'Application Support', 'BitFrost')
  : path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'bitfrost'))
export const SOCKET = path.join(RUN_DIR, 'bitfrostd.sock')
export const LOG = path.join(RUN_DIR, 'bitfrostd.log')
export const LOCK = path.join(RUN_DIR, 'bitfrostd.lock')
export const DATA_LOCK = path.join(DATA_DIR, 'daemon.lock')
export const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'bitfrost', 'agents.json')
export const CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'bitfrost', 'config.json')

// Every client trusts whatever answers on the socket in this directory, so it must be ours alone. Under /tmp
// (the fallback, and the only choice on macOS) another user could have made it first, or swapped in a link.
export function runDirTrusted(dir = RUN_DIR): boolean {
  try {
    const st = fs.lstatSync(dir)
    return st.isDirectory() && st.uid === process.getuid!() && (st.mode & 0o022) === 0
  } catch {
    return false
  }
}

export function ensureRunDir(dir = RUN_DIR) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!runDirTrusted(dir)) throw new Error(`${dir} is not a real directory of yours that only you can write; not using it`)
  fs.chmodSync(dir, 0o700)
}

export function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}\n`
  if (process.stderr.isTTY) process.stderr.write(line)
  // A log that can't be written must never stop the helper, or its shutdown.
  try { fs.appendFileSync(LOG, line) } catch {}
}

const expandHome = (p: string) => (p.startsWith('~') ? path.join(HOME, p.slice(1)) : p)
export const canonical = (p: string) => {
  const abs = path.resolve(expandHome(p))
  try {
    return fs.realpathSync(abs)
  } catch {
    return abs
  }
}

// Invalid config falls back to defaults and blocks new leases.
export type Config = {
  allowedProfiles: string[]
  providers: Record<string, any>
  error: string | null
  warnings: string[]
  retention?: { eventsDays: number; messagesDays: number }
  // The Claude model that writes the handback step, or null when it's off.
  handback?: { model: string; effort: string | null } | null
  // Features still to be asked about (bitfrost setup).
  newSettings?: string[]
  settingsUpToDate?: boolean
}

export function loadConfig(file = CONFIG): Config {
  let cfg: any = {}
  let problems: string[] = []
  let warnings: string[] = []
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    const checked = validateConfig(cfg)
    problems = checked.errors
    warnings = checked.warnings
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') problems = [(e as Error).message]
  }
  if (problems.length) cfg = {}
  const providers = { ...(cfg.providers ?? {}) }
  if (cfg.codexBin) providers.codex = { bin: cfg.codexBin, ...providers.codex }
  if (cfg.zcodeDir) providers.zcode = { dir: cfg.zcodeDir, ...providers.zcode }
  const newSettings = problems.length ? [] : pendingFeatures(cfg).map((f) => f.id)
  return {
    allowedProfiles: (cfg.allowedProfiles ?? ['~/.claude']).map(canonical),
    providers,
    retention: { eventsDays: cfg.retention?.eventsDays ?? 30, messagesDays: cfg.retention?.messagesDays ?? 180 },
    handback: cfg.handback?.enabled === true && cfg.handback.model ? { model: claudeModelId(cfg.handback.model), effort: cfg.handback.effort ?? null } : null,
    // An invalid config is reported on its own, so it asks nothing.
    newSettings,
    settingsUpToDate: newSettings.length === 0,
    error: problems.length ? `${file} is invalid: ${problems.join('; ')}` : null,
    warnings: warnings.map((w) => `${file}: ${w}`),
  }
}

const TOP_KEYS = new Set(['allowedProfiles', 'providers', 'codexBin', 'zcodeDir', 'retention', 'settingsUpToDate', ...FEATURES.map((f) => f.key)])
const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string')

export function validateConfig(cfg: unknown, known: string[] = PROVIDERS.map((p) => p.id)): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isObject(cfg)) return { errors: ['it must be a JSON object'], warnings }
  const c = cfg as Record<string, any>
  if ('settingsUpToDate' in c && typeof c.settingsUpToDate !== 'boolean') errors.push('settingsUpToDate must be a boolean')
  for (const key of Object.keys(c)) if (!TOP_KEYS.has(key)) warnings.push(`unknown key ${key}`)
  if ('allowedProfiles' in c && !isStrings(c.allowedProfiles)) errors.push('allowedProfiles must be a list of strings')
  for (const key of ['codexBin', 'zcodeDir']) if (key in c && typeof c[key] !== 'string') errors.push(`${key} must be a string`)
  if ('retention' in c) {
    if (!isObject(c.retention)) errors.push('retention must be an object')
    else for (const key of ['eventsDays', 'messagesDays']) {
      if (key in c.retention && (!Number.isFinite(c.retention[key]) || c.retention[key] < 0)) errors.push(`retention.${key} must be a non-negative number`)
    }
  }
  if ('handback' in c) {
    const h = c.handback
    if (!isObject(h)) errors.push('handback must be an object')
    else {
      if ('enabled' in h && typeof h.enabled !== 'boolean') errors.push('handback.enabled must be true or false')
      if ('model' in h && (typeof h.model !== 'string' || !h.model)) errors.push('handback.model must be a model name')
      if (h.enabled === true && !h.model) errors.push('handback.model is needed when handback.enabled is true')
      if ('effort' in h && h.effort !== null && !EFFORTS.includes(h.effort)) errors.push(`handback.effort must be one of ${EFFORTS.join(', ')}`)
    }
  }
  if ('providers' in c && !isObject(c.providers)) errors.push('providers must be an object')
  else {
    for (const [id, entry] of Object.entries<any>(c.providers ?? {})) {
      if (!known.includes(id)) warnings.push(`unknown provider ${id} (known: ${known.join(', ')})`)
      if (!isObject(entry)) {
        errors.push(`providers.${id} must be an object`)
        continue
      }
      if ('enabled' in entry && typeof entry.enabled !== 'boolean') errors.push(`providers.${id}.enabled must be true or false`)
      for (const key of ['models', 'disabled']) if (key in entry && !isStrings(entry[key])) errors.push(`providers.${id}.${key} must be a list of strings`)
      for (const key of ['bin', 'dir']) if (key in entry && typeof entry[key] !== 'string') errors.push(`providers.${id}.${key} must be a string`)
    }
  }
  return { errors, warnings }
}

export const configKey = (config: Config) => createHash('sha256').update(JSON.stringify(config.providers)).digest('hex').slice(0, 16)

export function providerEnv(config: Config, id: string): ProviderEnv {
  const recordDir = process.env.BITFROST_RECORD_DIR
  return {
    runDir: RUN_DIR,
    dataDir: DATA_DIR,
    socket: SOCKET,
    log,
    config: config.providers[id] ?? {},
    resolveBinary,
    recorder: (name) => {
      if (!recordDir) return null
      fs.mkdirSync(recordDir, { recursive: true })
      const file = path.join(recordDir, `${name.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`)
      return (line) => fs.appendFileSync(file, line + '\n')
    },
  }
}

export function pathLookup(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = path.join(dir, name)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {}
  }
  return null
}

const shellAnswer = (out: string | null | undefined) => {
  const found = (out ?? '').trim().split('\n').pop()
  return found && found.startsWith('/') ? found : null
}

// Try the login shell too, since tools may only be on its PATH.
export function resolveBinary(name: string): string | null {
  const found = pathLookup(name)
  if (found) return found
  const r = spawnSync(process.env.SHELL ?? '/bin/sh', ['-lic', `command -v ${name}`], { encoding: 'utf8', timeout: 5000 })
  return shellAnswer(r.stdout)
}

// The same login shell lookup, without blocking the helper.
export function loginShellLookup(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(process.env.SHELL ?? '/bin/sh', ['-lic', `command -v ${name}`], { encoding: 'utf8', timeout: 5000 }, (_e, stdout) => resolve(shellAnswer(stdout)))
  })
}

// A lock holds the owner's pid, then the time that process started: the lock outlives a reboot, and a pid
// can come back as some other process. The migrator and installer read the pid alone, and write only that.
// Link a file containing it into place so concurrent starts cannot see an empty lock.
function linkPid(file: string): boolean {
  const mine = `${file}.${process.pid}`
  fs.writeFileSync(mine, [process.pid, startTimeOf(process.pid)].filter((x) => x != null).join(' '))
  try {
    fs.linkSync(mine, file)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    return false
  } finally {
    fs.rmSync(mine, { force: true })
  }
}

const holderOf = (file: string): number => {
  try {
    return Number.parseInt(fs.readFileSync(file, 'utf8'), 10)
  } catch {
    return NaN
  }
}

// Whether `pid` holds the lock, whatever follows its pid in the file.
export const holdsLock = (file: string, pid: number): boolean => holderOf(file) === pid

// The holder is running, and is the process that took the lock rather than a later one with its pid.
function holderLives(file: string): boolean {
  const pid = holderOf(file)
  if (!alive(pid)) return false
  let started: string | undefined
  try {
    started = fs.readFileSync(file, 'utf8').trim().split(/\s+/).slice(1).join(' ') || undefined
  } catch {}
  const now = started ? startTimeOf(pid) : null
  return !(started && now != null && now !== started)
}

export function takeLock(lock = LOCK): boolean {
  if (linkPid(lock)) return true
  if (holderOf(lock) === process.pid) return true
  if (holderLives(lock)) return false
  // The holder is gone. Removing its lock and linking ours is not atomic, so two starters that both saw the
  // dead holder could each remove the other's fresh lock and both win. Only one starter at a time takes over,
  // and it looks at the lock again once it has the turn.
  const turn = `${lock}.takeover`
  if (!linkPid(turn)) {
    const other = holderOf(turn)
    if (other > 0 && other !== process.pid && alive(other)) return false
    // A starter that died mid-takeover left its turn behind.
    fs.rmSync(turn, { force: true })
    return takeLock(lock)
  }
  try {
    const holder = holderOf(lock)
    if (holder === process.pid) return true
    if (holderLives(lock)) return false
    fs.rmSync(lock, { force: true })
    return linkPid(lock)
  } finally {
    if (holderOf(turn) === process.pid) fs.rmSync(turn, { force: true })
  }
}

// kill(0, 0) and kill(-1, 0) would signal our own group, so only a real pid counts.
function alive(pid: number): boolean {
  if (!(pid > 0)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
