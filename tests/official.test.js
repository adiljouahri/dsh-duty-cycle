/**
 * official.test.js — Check that the generated official bundle stays
 * version- and manifest-consistent with the repository package.
 *
 * Run from the repository root: node tests/official.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const rootPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const pluginPkg = JSON.parse(readFileSync(new URL('../plugin/package.json', import.meta.url), 'utf8'))
const client = readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../plugin/index.js', import.meta.url), 'utf8')

test('package.json version matches plugin/package.json', () => {
  assert.equal(rootPkg.version, '1.6.0')
  assert.equal(pluginPkg.version, rootPkg.version)
})

test('plugin/client.js advertises the package version', () => {
  assert.equal(client.includes(`const PLUGIN_VERSION = '${rootPkg.version}'`), true)
})

test('plugin/index.js exports the plugin name', () => {
  assert.equal(host.includes(`export const name = 'dsh-duty-cycle'`), true)
})

test('plugin/package.json declares the browser half', () => {
  assert.equal(pluginPkg.exports['./client'], './client.js')
  assert.equal(pluginPkg.dsh.client.platform, 'web')
})
