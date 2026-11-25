import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))

async function run(args) {
  const { stdout } = await exec(process.execPath, [cli, ...args])
  return JSON.parse(stdout)
}

test('CLI blocks：输出三个街区的三层需求估计', async () => {
  const out = await run(['blocks'])
  assert.equal(out.asOf, 100)
  assert.deepEqual(out.estimates.map((r) => r.block).sort(),
    ['B1', 'B2', 'B3'])
  const b2 = out.estimates.find((r) => r.block === 'B2')
  assert.equal(b2.estimates.minUnmet, 6)
})

test('CLI block 单查与 shifts 班次查询', async () => {
  const b1 = await run(['block', 'B1'])
  assert.equal(b1.visible.total, 2)
  const shifts = await run(['shifts', '--now', '101'])
  assert.ok(shifts.find((s) => s.id === 'A2').reassignable === false)
})

test('CLI closures 输出关闭点影响，briefing 输出对外小计', async () => {
  const closures = await run(['closures', 'W2'])
  assert.equal(closures[0].site, 'S2')
  const briefing = await run(['briefing'])
  assert.equal(briefing.publicTotal, 0)
})

test('CLI plan 评估延长方案，forecast 拒绝回溯更新', async () => {
  const plan = [{
    site: 'S1', window: 'W2', chairsNeeded: 5, wheelchairNeeded: 1,
    vehicles: [],
  }]
  const result = await run(['plan', JSON.stringify(plan)])
  assert.equal(result.feasible, true)
  assert.equal(result.coverage.genuineGain, 0)

  const forecast = await run([
    'forecast',
    JSON.stringify([{ issue: '101', valid: '90', block: 'B1',
      temp: '-14', snow: '多', wind: '强' }]),
    '--now', '100',
  ])
  assert.equal(forecast.appliedCount, 0)
  assert.equal(forecast.changes[0].skipped, true)
})
