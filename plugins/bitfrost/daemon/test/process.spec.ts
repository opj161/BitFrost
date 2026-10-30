// Copyright (C) 2026 Nick Germaine
// SPDX-License-Identifier: GPL-3.0-only
//
// BitFrost is free software: you can share and change it under the GNU General
// Public License, version 3 only. It comes with no warranty. See LICENSE.

import test from 'node:test'
import assert from 'node:assert/strict'
import { appEnv } from '../process.ts'

test('apps get the helper\'s environment without Claude Code\'s own session variables', (t) => {
  const set = { CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_OAUTH_TOKEN: 'o', CLAUDECODE: '1', CLAUDE_PID: '1', CLAUDE_EFFORT: 'high', CLAUDE_PLUGIN_DATA: '/d', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u', CLAUDE_CONFIG_DIR: '/profile', OPENAI_API_KEY: 'mine', PATH_LIKE: 'x' }
  const before = { ...process.env }
  Object.assign(process.env, set)
  t.after(() => { for (const k of Object.keys(set)) if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k] })
  const env = appEnv()
  for (const name of ['CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_PLUGIN_DATA'])
    assert.equal(env[name], undefined, name)
  // What the user set for the apps stays, including Anthropic keys an app may use, and what the caller asks for wins.
  assert.equal(env.ANTHROPIC_API_KEY, 'k')
  assert.equal(env.ANTHROPIC_BASE_URL, 'u')
  assert.equal(env.CLAUDE_CONFIG_DIR, '/profile')
  assert.equal(env.OPENAI_API_KEY, 'mine')
  assert.equal(env.PATH, process.env.PATH)
  assert.equal(appEnv({ CLAUDE_CODE_SESSION_ID: 'chosen' }).CLAUDE_CODE_SESSION_ID, 'chosen')
})
