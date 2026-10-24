// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import type { HarnessModel } from './provider.ts'

export type { HarnessModel }

export type AgentDef = HarnessModel & {
  name: string
  // Names this agent had before names were shortened, so saved and resumed subagents still find it.
  legacy?: string[]
  aliases: string[]
  family: string
  harnessName: string
}

const vendorKey = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '')

export type Offer = null | 'anthropic' | 'disabled' | 'not_listed'

// Exclude Anthropic only. Apps serving many companies need a model list to keep host context small.
// Returns why a model isn't offered, or null when it is.
export function whyNot(m: HarnessModel, ownVendors: Map<string, string>, allow: Map<string, string[]>, deny: Map<string, string[]> = new Map()): Offer {
  if (vendorKey(m.provider).startsWith('anthropic')) return 'anthropic'
  if (deny.get(m.harness)?.some((pattern) => globMatch(pattern, m.model))) return 'disabled'
  const list = allow.get(m.harness)
  if (!list) return ownVendors.has(m.harness) ? null : 'not_listed'
  return list.some((pattern) => globMatch(pattern, m.model)) ? null : 'not_listed'
}

export function selectModels(found: HarnessModel[], ownVendors: Map<string, string>, allow: Map<string, string[]>, deny?: Map<string, string[]>): HarnessModel[] {
  return found.filter((m) => whyNot(m, ownVendors, allow, deny) === null)
}

export function globMatch(pattern: string, value: string): boolean {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${re}$`, 'i').test(value)
}

// Words that name a tier of a model rather than the model itself ("Flash", "Fast", "Free").
const TIERS = new Set(['flash', 'fast', 'free', 'mini', 'pro', 'lite', 'max', 'turbo', 'preview', 'plus', 'nano', 'contributor', 'instant'])
// A company prefix that every model of an app shares ("GPT-6.1-Sol" is Sol).
const COMPANY_PREFIXES = new Set(['gpt'])
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// The words of a display name that make a short agent name: no version, no trailing tier, no company prefix.
function shortWords(displayName: string): { words: string[]; tier: string[] } {
  const words = displayName
    .replace(/\(.*?\)/g, ' ')
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .filter((w) => !/^v?\d+(\.\d+)*$/.test(w))
  const tier: string[] = []
  while (words.length > 1 && TIERS.has(words[words.length - 1])) tier.unshift(words.pop()!)
  if (words.length > 1 && COMPANY_PREFIXES.has(words[0])) words.shift()
  return { words, tier }
}

export function agentName(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64)
}

function familyOf(displayName: string): { family: string; vendor: string | null; version: string | null } {
  const tokens = displayName.replace(/\(.*?\)/g, ' ').split(/[-\s]+/).filter(Boolean)
  const v = tokens.findIndex((t) => /^\d+(\.\d+)*$/.test(t))
  if (v < 0) return { family: tokens.join(' ').toLowerCase(), vendor: null, version: null }
  const before = tokens.slice(0, v).join(' ').toLowerCase()
  const after = tokens.slice(v + 1).join(' ').toLowerCase()
  if (!after) return { family: before || tokens[v], vendor: null, version: tokens[v] }
  return { family: after, vendor: before || null, version: tokens[v] }
}

function newer(a: string | null, b: string | null): boolean {
  const pa = (a ?? '0').split('.').map(Number)
  const pb = (b ?? '0').split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}

// Build versioned aliases; bare names select the newest model in each family. A model run by its
// company's own app claims its name and aliases before the same model through another app.
export function buildAgents(models: HarnessModel[], ownVendors: Map<string, string> = new Map()): AgentDef[] {
  const facts = new Map(models.map((m) => [m, familyOf(m.displayName)]))
  const own = (m: HarnessModel) => {
    const v = ownVendors.get(m.harness)
    return !!v && vendorKey(m.provider).startsWith(vendorKey(v))
  }
  const ranked = [...models].sort((a, b) => Number(own(b)) - Number(own(a)))
  const bareNames = (m: HarnessModel) => {
    const f = facts.get(m)!
    return f.vendor ? [f.family, `${f.vendor} ${f.family}`] : [f.family]
  }
  const newest = new Map<string, HarnessModel>()
  for (const m of ranked) {
    for (const bare of bareNames(m)) {
      const cur = newest.get(bare)
      if (!cur || newer(facts.get(m)!.version, facts.get(cur)!.version)) newest.set(bare, m)
    }
  }
  const taken = new Set<string>()
  const claimed = new Set<string>()
  const defs = new Map<HarnessModel, AgentDef>()
  for (const m of ranked) {
    const { family, vendor, version } = facts.get(m)!
    const aliases = new Set<string>()
    const claim = (alias: string) => { if (!claimed.has(alias)) { claimed.add(alias); aliases.add(alias) } }
    if (version) {
      claim(`${family.replace(/\s+/g, '')}${version}`)
      claim(`${family} ${version}`)
      if (vendor) claim(`${vendor}${version} ${family}`)
    }
    for (const bare of bareNames(m)) if (newest.get(bare) === m) claim(bare)
    // The shortest name that is free: "sol" for the newest Sol, "sol6" for an older one, "glm-opencode" for
    // the same model through another app, and the full model id as the last resort.
    const long = agentName(m.model)
    const { words, tier } = shortWords(m.displayName)
    const base = slug(words.join(' '))
    const full = slug([...words, ...tier].join(' '))
    const ver = version ? slug(version) : ''
    const owns = bareNames(m).some((b) => newest.get(b) === m)
    const again = models.some((o) => o !== m && o.displayName === m.displayName)
    const tries = [
      ...(owns ? [base] : again ? [`${base}-${m.harness}`] : []),
      ...(tier.length ? [full] : []), // "grok-fast" beside "grok"
      ...(ver ? [`${base}${ver}`] : []),
      full,
      ...(ver ? [`${full}${ver}`] : []),
      `${base}-${m.harness}`,
      long,
    ].filter((n) => n && n.length <= 64)
    let name = tries.find((n) => !taken.has(n)) ?? long
    while (taken.has(name)) name = `${name}-${m.harness}`
    taken.add(name)
    const legacy = [long, `${long}-${m.harness}`].filter((n) => n !== name)
    defs.set(m, { ...m, name, legacy, aliases: [...aliases], family, harnessName: m.harnessName ?? m.harness })
  }
  return models.map((m) => defs.get(m)!)
}

export function describe(a: AgentDef, all: AgentDef[]): string {
  const efforts = a.efforts.length
    ? ` Reasoning effort: ${a.efforts.join(' | ')} (default ${a.defaultEffort ?? 'set by the app'}); to choose one, make the prompt's first line "effort: <level>".`
    : ''
  const siblings = all.filter((o) => o !== a && o.family === a.family && o.harness === a.harness)
  const others = siblings.length
    ? ` Not to be confused with ${siblings.map((o) => `${o.displayName} (bitfrost:${o.name}${o.aliases.length ? `, "${o.aliases[0]}"` : ''})`).join(', ')}.`
    : ''
  const names = a.aliases.length ? ` Users may call it ${a.aliases.map((s) => `"${s}"`).join(', ')}.` : ''
  const about = a.description.trim()
  return (
    `${a.displayName}, ${a.provider}'s model ${a.model}, running in the real ${a.harnessName} app on this machine.` +
    `${about ? ` ${about}` : ''}${names}${others}${efforts} ` +
    `Works in the task's directory and can read, edit and run commands there.`
  )
}

export function nameTable(all: AgentDef[]): string {
  if (!all.length) return ''
  const rows = all.map((a) => {
    const efforts = a.efforts.length ? `; effort ${a.efforts.join('|')}, default ${a.defaultEffort ?? 'set by the app'}` : ''
    return `- ${a.aliases.map((s) => `"${s}"`).join(', ') || a.displayName} -> bitfrost:${a.name} (${a.displayName} via ${a.harnessName}${efforts})`
  })
  return [
    'Models from other companies that you can hand work to as subagents (via bitfrost). When the user names one of these, use exactly the matching subagent type. To set its reasoning effort ("sol6 on high"), make the first line of the prompt "effort: <level>".',
    ...rows,
    'These run in their own app, not in this conversation: they see only the prompt you give them and the project folder, so make the prompt self-contained. ' +
      'They use their own tools, not yours (no MCP tools or skills of this session). Their permission requests go to the user, or to a safety review in auto mode. ' +
      'The final report comes back like a native subagent\'s; follow up with SendMessage, or read what one is doing with the bitfrost status and messages tools.',
  ].join('\n')
}
