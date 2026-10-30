// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

// Tests for config.json checking, the helper's lock file, and the agent
// descriptions registry.ts writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { configKey, ensureRunDir, loadConfig, runDirTrusted, takeLock, validateConfig } from '../config.ts'
import { buildAgents, describe } from '../registry.ts'
import { pendingFeatures } from '../features.ts'
const demos = pendingFeatures({ handback: {} }).map((f) => f.id)

const KNOWN = ['codex', 'zcode', 'opencode']

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitfrost-config-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a well-formed config has no errors or warnings', () => {
  const cfg = {
    allowedProfiles: ['~/.claude'],
    providers: { codex: { bin: '/usr/bin/codex', enabled: true }, zcode: { dir: '/opt/ZCode' }, opencode: { enabled: true, models: ['deepseek/*'] } },
  }
  assert.deepStrictEqual(validateConfig(cfg, KNOWN), { errors: [], warnings: [] })
  assert.deepStrictEqual(validateConfig({}, KNOWN), { errors: [], warnings: [] })
})

test('each wrong shape is an error', () => {
  const cases: [unknown, RegExp][] = [
    [[], /JSON object/],
    [null, /JSON object/],
    [{ allowedProfiles: '~/.claude' }, /allowedProfiles must be a list of strings/],
    [{ allowedProfiles: [1] }, /allowedProfiles must be a list of strings/],
    [{ providers: [] }, /providers must be an object/],
    [{ providers: { codex: true } }, /providers\.codex must be an object/],
    [{ providers: { codex: { enabled: 'yes' } } }, /providers\.codex\.enabled must be true or false/],
    [{ providers: { opencode: { models: 'deepseek/*' } } }, /providers\.opencode\.models must be a list of strings/],
    [{ providers: { codex: { bin: 42 } } }, /providers\.codex\.bin must be a string/],
    [{ providers: { zcode: { dir: ['/opt'] } } }, /providers\.zcode\.dir must be a string/],
    [{ codexBin: false }, /codexBin must be a string/],
    [{ settingsUpToDate: 'yes' }, /settingsUpToDate must be a boolean/],
  ]
  for (const [cfg, expected] of cases) {
    const { errors } = validateConfig(cfg, KNOWN)
    assert.strictEqual(errors.length, 1, JSON.stringify(cfg))
    assert.match(errors[0], expected)
  }
})

test('unknown provider ids and keys are warnings, not errors', () => {
  const r = validateConfig({ allowedProfile: [], providers: { opencod: { enabled: true } } }, KNOWN)
  assert.deepStrictEqual(r.errors, [])
  assert.strictEqual(r.warnings.length, 2)
  assert.match(r.warnings.join('\n'), /unknown key allowedProfile/)
  assert.match(r.warnings.join('\n'), /unknown provider opencod/)
})

test('loadConfig: a missing file is the defaults, a broken one an error naming the file', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'config.json')

  const missing = loadConfig(file)
  assert.strictEqual(missing.error, null)
  assert.deepStrictEqual(missing.providers, {})
  assert.strictEqual(missing.allowedProfiles.length, 1)

  fs.writeFileSync(file, '{"providers": ')
  const broken = loadConfig(file)
  assert.ok(broken.error?.startsWith(`${file} is invalid: `), broken.error ?? '')
  assert.deepStrictEqual(broken.providers, {})

  fs.writeFileSync(file, JSON.stringify({ providers: { codex: { enabled: 'no' } } }))
  assert.match(loadConfig(file).error ?? '', /providers\.codex\.enabled must be true or false/)

  fs.writeFileSync(file, JSON.stringify({ allowedProfiles: [dir], providers: { codex: { bin: '/x' } }, codexBin: '/old' }))
  const good = loadConfig(file)
  assert.strictEqual(good.error, null)
  assert.deepStrictEqual(good.allowedProfiles, [fs.realpathSync(dir)])
  assert.deepStrictEqual(good.providers.codex, { bin: '/x' }) // the newer key wins
})

test('configKey follows the providers part of the config only', () => {
  const base = { allowedProfiles: [], providers: { codex: { enabled: true } }, error: null, warnings: [] }
  assert.strictEqual(configKey(base), configKey({ ...base, allowedProfiles: ['/elsewhere'] }))
  assert.notStrictEqual(configKey(base), configKey({ ...base, providers: { codex: { enabled: true, models: ['gpt-*'] } } }))
})

test('takeLock: one holder at a time, and a lock left empty or by a dead helper is taken over', (t) => {
  const dir = tempDir(t)
  const lock = path.join(dir, 'bitfrostd.lock')

  assert.strictEqual(takeLock(lock), true)
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.pid))
  assert.strictEqual(takeLock(lock), true) // already ours
  assert.deepStrictEqual(fs.readdirSync(dir), ['bitfrostd.lock']) // no temp file left behind

  fs.writeFileSync(lock, String(process.ppid))
  assert.strictEqual(takeLock(lock), false)
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.ppid))

  // Empty, garbage, 0, -1 and a dead pid are all stale; kill(0, 0) would signal our own group.
  const dead = spawnSync(process.execPath, ['-e', '']).pid!
  for (const left of ['', 'garbage', '0', '-1', String(dead)]) {
    fs.writeFileSync(lock, left)
    assert.strictEqual(takeLock(lock), true, `lock holding ${JSON.stringify(left)}`)
    assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.pid))
  }
})

test('describe leaves out the alias sentence when a model has no aliases', () => {
  const [agent] = buildAgents([
    { harness: 'codex', harnessName: 'Codex', provider: 'OpenAI', model: 'gpt-x', displayName: 'GPT-X', description: 'A model.', efforts: [], defaultEffort: null, isDefault: true },
  ])
  assert.ok(agent.aliases.length > 0)
  assert.match(describe(agent, [agent]), /Users may call it "/)

  const bare = { ...agent, aliases: [] }
  const text = describe(bare, [bare])
  assert.doesNotMatch(text, /Users may call it/)
  assert.doesNotMatch(text, /\s\./)
  assert.strictEqual(text, "GPT-X, OpenAI's model gpt-x, running in the real Codex app on this machine. A model. Works in the task's directory and can read, edit and run commands there.")
})


test('a model through another app is offered, but its own app keeps the name and aliases', () => {
  const m = (harness: string, provider: string, model: string, displayName: string) => ({ harness, harnessName: harness, provider, model, displayName, description: '', efforts: [], defaultEffort: null, isDefault: false })
  const own = new Map([['zcode', 'Z.ai'], ['gemini', 'Google']])
  // Listed first, as opencode and Oh My Pi come before Gemini CLI.
  const agents = buildAgents([
    m('opencode', 'Z.ai', 'opencode-go/glm-5.3', 'GLM-5.3'),
    m('omp', 'Google', 'gemini-3-pro', 'Gemini 3 Pro'),
    m('zcode', 'Z.ai', 'GLM-5.3', 'GLM-5.3'),
    m('gemini', 'Google', 'gemini-3-pro', 'Gemini 3 Pro'),
  ], own)
  const [viaOpencode, viaOmp, zcode, gemini] = agents
  assert.deepStrictEqual([viaOpencode.name, viaOmp.name, zcode.name, gemini.name], ['glm-opencode', 'gemini-omp', 'glm', 'gemini'])
  assert.ok(zcode.aliases.includes('glm') && zcode.aliases.includes('glm5.3'), zcode.aliases.join())
  assert.ok(gemini.aliases.includes('gemini pro') && gemini.aliases.includes('gemini3 pro'), gemini.aliases.join())
  assert.deepStrictEqual([viaOpencode.aliases, viaOmp.aliases], [[], []])
  const all = agents.flatMap((a) => a.aliases)
  assert.strictEqual(new Set(all).size, all.length, 'no alias names two models')
})

test('retention defaults, overrides and invalid shapes are checked', (t) => {
  const file = path.join(tempDir(t),'config.json')
  assert.deepEqual(loadConfig(file).retention,{ eventsDays:30,messagesDays:180 })
  fs.writeFileSync(file,JSON.stringify({ retention:{ eventsDays:2,messagesDays:10 } }))
  assert.deepEqual(loadConfig(file).retention,{ eventsDays:2,messagesDays:10 })
  for (const value of [[],{ eventsDays:-1 },{ messagesDays:'forever' }]) assert.ok(validateConfig({ retention:value }).errors.length)
  assert.deepEqual(validateConfig({ retention:{ eventsDays:0,messagesDays:180 } }).warnings,[])
})

test('handback accepts off/on settings, custom models, every effort and null without warnings', () => {
  const settings: Record<string, unknown>[] = [{}, { enabled: false }, { enabled: true, model: 'sonnet' }, { enabled: true, model: 'custom-model-id' }]
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', null]) settings.push({ enabled: true, model: 'opus', effort })
  for (const handback of settings) {
    assert.deepEqual(validateConfig({ handback }, KNOWN), { errors: [], warnings: [] }, JSON.stringify(handback))
  }
  assert.deepEqual(validateConfig({ handback: { enabled: false }, typo: true }, KNOWN), { errors: [], warnings: ['unknown key typo'] })
})

test('handback rejects invalid objects, enabled/model types, missing enabled models and efforts', () => {
  const cases: [unknown, RegExp][] = [
    [null, /handback must be an object/], [[], /handback must be an object/], [true, /handback must be an object/],
    [{ enabled: 'yes' }, /handback\.enabled must be true or false/], [{ enabled: null }, /handback\.enabled must be true or false/],
    [{ model: '' }, /handback\.model must be a model name/], [{ model: 42 }, /handback\.model must be a model name/],
    [{ model: null }, /handback\.model must be a model name/], [{ enabled: true }, /handback\.model is needed/],
    [{ enabled: true, model: '' }, /handback\.model is needed/],
    [{ effort: 'auto' }, /handback\.effort must be one of low, medium, high, xhigh, max/],
    [{ effort: 1 }, /handback\.effort must be one of/], [{ effort: false }, /handback\.effort must be one of/],
  ]
  for (const [handback, expected] of cases) {
    const checked = validateConfig({ handback }, KNOWN)
    assert.match(checked.errors.join('; '), expected, JSON.stringify(handback))
    assert.deepEqual(checked.warnings, [])
  }
})

test('loadConfig resolves each handback family, passes custom ids through, and normalizes effort', (t) => {
  const file = path.join(tempDir(t), 'config.json')
  const models = [
    ['haiku', 'claude-haiku-4-5-20251001'], ['sonnet', 'claude-sonnet-5-5'],
    ['opus', 'claude-opus-5-5'], ['fable', 'claude-fable-5-1'],
    ['custom-model-id', 'custom-model-id'], ['claude-sonnet-5-5', 'claude-sonnet-5-5'],
  ]
  for (const [model, resolved] of models) {
    fs.writeFileSync(file, JSON.stringify({ handback: { enabled: true, model, effort: 'low' } }))
    const cfg = loadConfig(file)
    assert.equal(cfg.error, null)
    assert.deepEqual(cfg.warnings, [])
    assert.deepEqual(cfg.handback, { model: resolved, effort: 'low' })
    assert.deepEqual(cfg.newSettings, demos)
  }
  for (const effort of [undefined, null, 'medium', 'high', 'xhigh', 'max']) {
    fs.writeFileSync(file, JSON.stringify({ handback: { enabled: true, model: 'sonnet', effort } }))
    assert.deepEqual(loadConfig(file).handback, { model: 'claude-sonnet-5-5', effort: effort ?? null })
  }
})

test('loadConfig reports pending handback only when its key is missing and config is valid', (t) => {
  const file = path.join(tempDir(t), 'config.json')
  assert.deepEqual(loadConfig(file).newSettings, ['handback', ...demos])
  assert.equal(loadConfig(file).handback, null)
  for (const handback of [undefined, {}, { enabled: false }, { enabled: false, model: 'opus', effort: 'max' }]) {
    fs.writeFileSync(file, JSON.stringify({ handback }))
    const cfg = loadConfig(file)
    assert.equal(cfg.error, null)
    assert.equal(cfg.handback, null)
    assert.deepEqual(cfg.newSettings, handback === undefined ? ['handback', ...demos] : demos)
  }
  for (const invalid of ['{"handback":', '{"handback":{"enabled":true}}', '{"providers":{"codex":{"enabled":"no"}}}']) {
    fs.writeFileSync(file, invalid)
    const cfg = loadConfig(file)
    assert.ok(cfg.error?.startsWith(`${file} is invalid:`))
    assert.equal(cfg.handback, null)
    assert.deepEqual(cfg.newSettings, [])
  }
  fs.writeFileSync(file, '{"typo":true}')
  const warned = loadConfig(file)
  assert.equal(warned.error, null)
  assert.deepEqual(warned.warnings, [`${file}: unknown key typo`])
  assert.deepEqual(warned.newSettings, ['handback', ...demos])
})

test('agent names are short: the newest of a family takes the bare name, older and tiered ones add what tells them apart', () => {
  const m = (harness: string, provider: string, model: string, displayName: string) => ({ harness, harnessName: harness, provider, model, displayName, description: '', efforts: [], defaultEffort: null, isDefault: false })
  const own = new Map([['codex', 'OpenAI'], ['grok', 'xAI']])
  const agents = buildAgents([
    m('codex', 'OpenAI', 'gpt-6.1-sol', 'GPT-6.1-Sol'), m('codex', 'OpenAI', 'gpt-6-sol', 'GPT-6-Sol'), m('codex', 'OpenAI', 'gpt-5.6-sol', 'GPT-5.6-Sol'),
    m('codex', 'OpenAI', 'gpt-6-luna', 'GPT-6-Luna'), m('grok', 'xAI', 'grok-4.7', 'Grok 4.7'), m('grok', 'xAI', 'grok-4.7-build-fast', 'Grok 4.7 Fast'),
    m('opencode', 'opencode-go', 'opencode-go/beam-free', 'Beam Free'), m('opencode', 'DeepSeek', 'opencode-go/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'),
    m('opencode', 'opencode-go', 'opencode-go/muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor'),
  ], own)
  assert.deepStrictEqual(agents.map((a) => a.name), ['sol', 'sol6', 'sol5-6', 'luna', 'grok', 'grok-fast', 'beam', 'deepseek', 'muse-spark'])
  assert.strictEqual(new Set(agents.map((a) => a.name)).size, agents.length)
  // The names these agents had before still find them, for saved and resumed subagents.
  assert.deepStrictEqual(agents.map((a) => a.legacy![0]).slice(0, 2), ['gpt-6-1-sol', 'gpt-6-sol'])
  assert.ok(agents.every((a) => /^[a-z0-9][a-z0-9_-]*$/.test(a.name) && a.name.length <= 64))
})

test('takeLock: starters that all find the same dead holder produce exactly one winner', async (t) => {
  const dir = tempDir(t)
  const lock = path.join(dir, 'bitfrostd.lock')
  const configUrl = new URL('../config.ts', import.meta.url).href
  // Each starter loads, says ready, and takes the lock on "go", so they race as closely as processes can.
  // It then stays alive, so a winner is a live holder for the others.
  const starter = `import(${JSON.stringify(configUrl)}).then(({ takeLock }) => {
    process.stdout.write('ready\\n')
    process.stdin.once('data', () => { process.stdout.write(String(takeLock(${JSON.stringify(lock)})) + '\\n') })
  })`
  const next = (c: ReturnType<typeof spawn>) => new Promise<string>((resolve) => c.stdout!.once('data', (d) => resolve(String(d).trim())))
  for (let round = 0; round < 25; round++) {
    fs.writeFileSync(lock, String(spawnSync(process.execPath, ['-e', '']).pid!))
    const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', starter], { stdio: ['pipe', 'pipe', 'inherit'] }))
    await Promise.all(children.map(next))
    const answers = Promise.all(children.map(next))
    for (const c of children) c.stdin!.write('go\n')
    const got = await answers
    for (const c of children) c.kill()
    await Promise.all(children.map((c) => new Promise((resolve) => c.once('close', resolve))))
    assert.strictEqual(got.filter((a) => a === 'true').length, 1, `round ${round}: ${got}`)
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f !== 'bitfrostd.lock'), [], `round ${round} left files behind`)
    fs.rmSync(lock, { force: true })
  }
})

test('the runtime directory is used only when it is a real directory that nobody else can write', (t) => {
  const base = tempDir(t)
  const mine = path.join(base, 'mine')
  ensureRunDir(mine)
  assert.strictEqual(fs.statSync(mine).mode & 0o777, 0o700)
  assert.strictEqual(runDirTrusted(mine), true)
  ensureRunDir(mine) // again is fine

  const open = path.join(base, 'open')
  fs.mkdirSync(open, { mode: 0o777 })
  fs.chmodSync(open, 0o777)
  assert.strictEqual(runDirTrusted(open), false)
  assert.throws(() => ensureRunDir(open), /not using it/)

  const link = path.join(base, 'link')
  fs.symlinkSync(mine, link)
  assert.strictEqual(runDirTrusted(link), false)
  assert.throws(() => ensureRunDir(link), /not using it/)
  assert.strictEqual(runDirTrusted(path.join(base, 'missing')), false)
})
