import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ColdResponseEngine } from '../src/engine.js'

const dataUrl = new URL('../data/', import.meta.url)

async function newEngine(options) {
  return ColdResponseEngine.fromDir(dataUrl, options)
}

test('引擎默认采用最新发报时点，查询结果带气象决策证据', async () => {
  const engine = await newEngine()
  assert.equal(engine.asOf, 100)
  const basis = engine.weatherBasis()
  const b2 = basis.find((b) => b.block === 'B2' && b.slot === '101')
  assert.equal(b2.issueUsed, '100')
  assert.equal(b2.temp, '-12')
})

test('指定历史 asOf 时只能看到当时已发布的预报版本', async () => {
  const engine = await newEngine({ asOf: 89 })
  assert.equal(engine.asOf, 89)
  const basis = engine.weatherBasis()
  // 100/101 时段在 issue 89 时尚无预报，不应出现。
  assert.equal(basis.some((b) => b.slot === '101'), false)
  assert.ok(basis.some((b) => b.slot === '90'))
})

test('按街区/服务点/预约班次三个维度都能查到未满足量与可执行变更', async () => {
  const engine = await newEngine()
  const block = engine.queryByBlock('B2')
  assert.equal(block.estimates.minUnmet, 6)

  const site = engine.queryBySite('S2')
  assert.ok(site.some((s) => s.window === 'W2'))
  const w2 = site.find((s) => s.window === 'W2')
  assert.equal(w2.backlog.backlogLowerBound, 2)

  const shifts = engine.queryByShift()
  assert.deepEqual(shifts.map((s) => s.id).sort(), ['A1', 'A2'])
})

test('预报更新只影响未来时段，已开始接送的班次保持锁定', async () => {
  // now=100：slot 101 仍是未来开门时段，slot 90 早已结束。
  const engine = await newEngine({ now: 100 })
  const result = engine.applyForecast([
    { issue: '101', valid: '101', block: 'B1',
      temp: '-14', snow: '多', wind: '强' },
    { issue: '101', valid: '90', block: 'B1',
      temp: '-14', snow: '多', wind: '强' },
  ])
  const future = result.changes.find((c) => c.slot === '101')
  const past = result.changes.find((c) => c.slot === '90')
  assert.equal(future.appliedToFuture, true)
  assert.equal(past.skipped, true)
  assert.match(past.reason, /不回溯/)
  assert.equal(engine.asOf, 101)
  // A2 已出发，锁定不重派。
  assert.ok(result.lockedShifts.some((s) => s.id === 'A2'))
})

test('旧 issue 的预报不会覆盖新版本', async () => {
  const engine = await newEngine()
  const result = engine.applyForecast([
    { issue: '50', valid: '101', block: 'B1', temp: '-1', snow: '少', wind: '弱' },
  ])
  assert.equal(result.appliedCount, 0)
  assert.equal(engine.asOf, 100)
})

test('暂挂受理决策会立即反映另一份通知的可用性变化（真实资料为车辆锁定场景）', async () => {
  const engine = await newEngine()
  const decision = engine.accept('N3')
  // V1 被已出发预约与轮椅等车锁定，N3 不可受理，原因可直接展示给值班人员。
  assert.equal(decision.ok, false)
  assert.ok(decision.resourceIssues.some((i) => i.code === 'VEHICLE_LOCKED'))
  const n4 = decision.decisions.find((d) => d.notice === 'N4')
  // 即便未来解锁，同窗共用 V1 的 N4 也会因资源被占而失去可用性。
  assert.ok(n4.reasons.length > 0)
  // 通知复核仍可查到原始记录（资料不被改写，决策单独留痕）。
  const review = engine.notices().review
  assert.ok(review.some((r) => r.notice === 'N4'))
})

test('关闭点影响与对外简报可从引擎直接取得', async () => {
  const engine = await newEngine()
  const closures = engine.closureImpacts('W2')
  assert.equal(closures[0].site, 'S2')
  const briefing = engine.briefing()
  assert.equal(briefing.publicTotal, 0)
  const nextDay = engine.nextDay()
  assert.ok(nextDay.some((b) => b.reentryNeed === 1))
})

test('决策元数据包含当夜区间、街区清单与逐点通达上下文', async () => {
  const engine = await newEngine()
  const meta = engine.decisionMeta()
  assert.deepEqual(meta.tonightWindows, ['W1', 'W2'])
  assert.deepEqual(meta.blocks.sort(), ['B1', 'B2', 'B3'])
  assert.equal(meta.reachContext.length, engine.timeline.slots.length)
})
