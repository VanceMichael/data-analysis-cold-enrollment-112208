import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadTables } from '../src/records.js'
import { buildTimeline } from '../src/time.js'
import {
  receiptBuckets, confirmedWheelchairLocks, acceptRevision, reviewToday,
  NOTICE_STATES,
} from '../src/notifications.js'

const tables = await loadTables(new URL('../data/', import.meta.url))
const timeline = buildTimeline(
  tables.get('attendance'), tables.get('queue'), tables.get('seats'))

test('回单分桶：送达 / 改派待确认 / 未确认分开，未确认不假定已出门', () => {
  const buckets = receiptBuckets(tables.get('notifications'), timeline)
  assert.deepEqual(buckets.delivered.map((n) => n.notice), ['N1'])
  assert.deepEqual(buckets.awaitingReply.map((n) => n.notice).sort(),
    ['N3', 'N4'])
  assert.deepEqual(buckets.unconfirmed.map((n) => n.notice), ['N2'])
  // 通知 slot 被正确归入供暖窗。
  assert.ok(buckets.awaitingReply.every((n) => n.window === 'W2'))
})

test('联系人确认的轮椅等车形成原车锁：P4 等 V1', () => {
  const locks = confirmedWheelchairLocks(tables, timeline)
  const lock = locks.find((l) => l.anonymous === 'P4')
  assert.ok(lock)
  assert.equal(lock.vehicle, 'V1')
  assert.equal(lock.window, 'W2')
  assert.equal(lock.block, 'B1')
})

test('两份改派可同时暂挂；共享车辆锁定时受理被拒并给出原因', () => {
  // N3 与 N4 都在 W2 且共用 V1，初始都是“改派待确认”。
  const pending = tables.get('notifications')
    .filter((r) => r.state === NOTICE_STATES.REVISION_PENDING)
  assert.equal(pending.length, 2)

  // 真实资料里 V1 已被 A2（已出发）与 P4 轮椅等车锁定，
  // 因此 N3 不能受理，查询必须直接显示原因，而不是静默吞掉。
  const result = acceptRevision(tables, timeline, 'N3', { now: null })
  assert.equal(result.ok, false)
  assert.ok(result.resourceIssues.some((i) => i.code === 'VEHICLE_LOCKED'))
  const n3 = result.decisions.find((d) => d.notice === 'N3')
  assert.equal(n3.accepted, false)
  assert.ok(n3.reasons.some((m) => m.includes('V1')))
})

test('合成场景：资源可用时受理一份暂挂，另一份立即显示失去可用性', () => {
  // 深拷贝并移除 V1 的已出发/已接受预约与轮椅等车锁，制造可受理环境。
  const synthetic = new Map([...tables].map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
  synthetic.set('seats', synthetic.get('seats')
    .filter((r) => r.vehicle !== 'V1'))
  synthetic.set('queue', synthetic.get('queue')
    .filter((r) => r.state !== '等车'))
  const synTimeline = buildTimeline(
    synthetic.get('attendance'), synthetic.get('queue'), synthetic.get('seats'))

  const result = acceptRevision(synthetic, synTimeline, 'N3', { now: null })
  assert.equal(result.ok, true)
  const n4 = result.decisions.find((d) => d.notice === 'N4')
  assert.equal(n4.accepted, false)
  assert.ok(n4.reasons.some((m) => m.includes('V1')))
})

test('受理不存在或非暂挂通知被拒绝', () => {
  const missing = acceptRevision(tables, timeline, 'N9')
  assert.equal(missing.ok, false)
  const delivered = acceptRevision(tables, timeline, 'N1')
  assert.equal(delivered.ok, false)
  assert.match(delivered.reason, /不在暂挂/)
})

test('原车锁存在时，向另一街区承诺 V1 的新预约不可行', () => {
  // now=101 时 A2 已出发锁 V1；即便没有已出发锁，P4 的轮椅等车也锁 V1。
  const result = acceptRevision(tables, timeline, 'N4', { now: 101 })
  assert.equal(result.ok, false)
  assert.ok(result.resourceIssues.some((i) => i.code === 'VEHICLE_LOCKED'))
})

test('当日通知复核逐条留痕：关闭点承诺与未确认通知各自标注', () => {
  const review = reviewToday(tables, timeline)
  const n3 = review.find((r) => r.notice === 'N3')
  assert.match(n3.finding, /暂挂/)
  // N1 指向 S2/W2（临时关闭）。
  const n1 = review.find((r) => r.notice === 'N1')
  assert.match(n1.finding, /临时关闭/)
  // N2 也指向关闭点，优先标关闭风险；未确认语义在状态字段保留。
  const n2 = review.find((r) => r.notice === 'N2')
  assert.equal(n2.state, '未确认')
  assert.match(n2.finding, /临时关闭|不得假定/)
})
