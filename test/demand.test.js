import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadTables } from '../src/records.js'
import { buildTimeline } from '../src/time.js'
import {
  classifyAttendanceEvent, indexAttendance, indexQueue,
  estimateBlock, estimateAllBlocks, estimateNextDay,
} from '../src/demand.js'

const tables = await loadTables(new URL('../data/', import.meta.url))
const timeline = buildTimeline(
  tables.get('attendance'), tables.get('queue'), tables.get('seats'))

test('事件归类：转点是真实服务，不是误报', () => {
  assert.equal(classifyAttendanceEvent('转点'), 'served')
  assert.equal(classifyAttendanceEvent('接纳'), 'served')
  assert.equal(classifyAttendanceEvent('满员未接'), 'turned')
  assert.equal(classifyAttendanceEvent('轮椅预约'), 'reservation')
})

test('同一匿名号同一供暖窗在两个点登记只算一人（跨窗不去重）', () => {
  const indexed = indexAttendance(tables.get('attendance'))
  // P1 在 W1 的 S1 接纳、S2 转点：同一窗同一人。
  const w1 = indexed.get('W1')
  assert.ok(w1.has('P1'))
  assert.deepEqual([...w1.get('P1').sites].sort(), ['S1', 'S2'])
  // W3 的再次入站记录在排队表中，是另一个窗的独立服务需要。
  const queued = indexQueue(tables.get('queue'))
  assert.ok(queued.get('W3').has('P1'))
})

test('B1 当夜需求：看得见的服务与预约，无阻断时下限为 0', () => {
  const r = estimateBlock(tables, timeline, 'B1', { asOf: 100 })
  // W1: P1 接纳/转点（1 人）；W2: P4 轮椅预约（1 人）。
  assert.equal(r.visible.served, 1)
  assert.equal(r.visible.reservations, 1)
  assert.equal(r.visible.turnedAway, 0)
  assert.equal(r.visible.total, 2)
  assert.equal(r.estimates.minUnmet, 0)
  // eligible 40，已服务 1 -> 潜在上限 39。
  assert.equal(r.estimates.maxUnmet, 39)
  assert.ok(r.dataGaps.some((g) => g.includes('无完全可比')))
})

test('B2 断报+阻断：未见履约的已承诺人数进入未满足下限', () => {
  const r = estimateBlock(tables, timeline, 'B2', { asOf: 100 })
  // W1: P2 满员未接；W2 无到场。reserved=5, served=0, reservations=0。
  assert.equal(r.visible.turnedAway, 1)
  assert.equal(r.disruption.active, true)
  assert.deepEqual(r.disruption.blockedSlots, ['101'])
  // hidden = max(0, 5 - 0 - 0) = 5；下限 = 1 + 5 = 6。
  assert.equal(r.estimates.minUnmet, 6)
  // eligible 72，未见服务 -> 上限 72。
  assert.equal(r.estimates.maxUnmet, 72)
  assert.ok(r.dataGaps.includes('人口清单历史断报'))
})

test('B3 无阻断证据时不把承诺人数塞进下限', () => {
  const r = estimateBlock(tables, timeline, 'B3', { asOf: 100 })
  assert.equal(r.visible.served, 1) // P3 接纳
  assert.equal(r.estimates.minUnmet, 0)
  assert.equal(r.estimates.maxUnmet, 60) // 61 - 1
})

test('历史证据质量：部分可比给 partial 点估计；存在通达硬冲突的时段被排除', () => {
  const r = estimateBlock(tables, timeline, 'B2', { asOf: 100 })
  // B2 历史 slot 90 部分可比、slot 91 与当夜存在通达硬冲突（91 阻断 vs 101 可达）。
  // 因此任何点估计都只能是 partial；完全不可比的街区返回 null。
  if (r.estimates.pointEstimate) {
    assert.equal(r.estimates.pointEstimate.confidence, 'partial')
    assert.deepEqual(r.estimates.pointEstimate.basis.historySlots, ['90'])
  }
  const b3 = estimateBlock(tables, timeline, 'B3', { asOf: 100 })
  assert.equal(b3.estimates.pointEstimate, null)
})

test('全部街区估计都带窗口与区间，且不产生负的未满足量', () => {
  const all = estimateAllBlocks(tables, timeline, { asOf: 100 })
  assert.deepEqual(all.map((r) => r.block).sort(), ['B1', 'B2', 'B3'])
  for (const r of all) {
    assert.ok(r.estimates.minUnmet >= 0)
    assert.ok(r.estimates.maxUnmet >= r.estimates.minUnmet)
    assert.ok(r.windows.includes('W1') && r.windows.includes('W2'))
  }
})

test('次日窗按供暖窗重新识别需求，今夜已服务人次不充当新增服务证据', () => {
  const next = estimateNextDay(tables, timeline)
  const b1 = next.find((r) => r.block === 'B1')
  // P1 在 W3 再次入站：是新窗的新需要，而不是 W1 服务的重复。
  assert.equal(b1.reentryNeed, 1)
  assert.ok(b1.note.includes('不复用昨夜'))
  // P1 属 B1（由其历史到场登记推断），不能在每个街区都计一次。
  assert.equal(next.find((r) => r.block === 'B2').reentryNeed, 0)
  assert.equal(next.find((r) => r.block === 'B3').reentryNeed, 0)
})
