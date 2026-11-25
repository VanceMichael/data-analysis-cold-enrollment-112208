import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadTables } from '../src/records.js'
import { buildTimeline } from '../src/time.js'
import {
  siteWindow, vehicleView, lockedVehicles, seatStatus, evaluatePlan,
  tripClosureImpact,
} from '../src/resources.js'

const tables = await loadTables(new URL('../data/', import.meta.url))
const timeline = buildTimeline(
  tables.get('attendance'), tables.get('queue'), tables.get('seats'))

test('站点窗容量与状态：S2/W2 临时关闭，E1 在两个点同窗共用', () => {
  const s2w2 = siteWindow(tables.get('sites'), 'S2', 'W2')
  assert.equal(s2w2.state, '临时关闭')
  assert.equal(s2w2.wheelchair, 1)
  const s1w2 = siteWindow(tables.get('sites'), 'S1', 'W2')
  assert.equal(s1w2.state, '可延长')
  assert.equal(s1w2.staff, s2w2.staff) // 都是 E1 -> 同窗只能选一个点
})

test('车辆视图按窗归集，V1 同时挂在 S1/S2 的 W2', () => {
  const view = vehicleView(tables.get('mobility'), timeline)
  const v1 = view.get('W2').get('V1')
  assert.deepEqual(v1.map((r) => r.site).sort(), ['S1', 'S2'])
  assert.equal(v1.some((r) => !r.available), true) // B2/S1 趟阻断
})

test('已出发的车辆锁定到窗结束，不能重新当待派', () => {
  // now=101：A2(已出发, closing 101) 与 A1(已接受, closing 101) 都已到时点。
  const locked = lockedVehicles(tables.get('seats'), timeline, 101)
  assert.ok(locked.get('W2').has('V1'))
  const status = seatStatus(tables.get('seats'), 101)
  const a2 = status.find((s) => s.id === 'A2')
  assert.equal(a2.started, true)
  assert.equal(a2.reassignable, false)
  // now 在时段之前时，仅“已出发”锁定。
  const early = seatStatus(tables.get('seats'), 99)
  assert.equal(early.find((s) => s.id === 'A1').reassignable, true)
  assert.equal(early.find((s) => s.id === 'A2').reassignable, false)
})

test('联系人确认的轮椅等车形成原车锁', () => {
  const locked = lockedVehicles(tables.get('seats'), timeline, null,
    [{ window: 'W2', vehicle: 'V1', ref: 'N1' }])
  const reasons = locked.get('W2').get('V1').map((r) => r.reason)
  assert.ok(reasons.some((m) => m.includes('架轮椅等原车')))
})

test('延长 S1/W2 单独成立；同窗同时重开 S2 触发人员冲突', () => {
  const extendS1 = evaluatePlan(tables.get('sites'), tables.get('mobility'),
    tables.get('seats'), timeline, [{
      site: 'S1', window: 'W2', chairsNeeded: 5, wheelchairNeeded: 1,
      vehicles: [],
    }], { now: null })
  assert.equal(extendS1.feasible, true)

  const both = evaluatePlan(tables.get('sites'), tables.get('mobility'),
    tables.get('seats'), timeline, [
      { site: 'S1', window: 'W2', chairsNeeded: 5, wheelchairNeeded: 1,
        vehicles: [] },
      { site: 'S2', window: 'W2', reopen: true, chairsNeeded: 5,
        wheelchairNeeded: 1, vehicles: [] },
    ], { now: null })
  assert.equal(both.feasible, false)
  assert.ok(both.issues.some((i) => i.code === 'STAFF_CONFLICT'))
})

test('轮椅位与普通座位分别校验，互不替代', () => {
  const badWheelchair = evaluatePlan(tables.get('sites'),
    tables.get('mobility'), tables.get('seats'), timeline, [{
      site: 'S2', window: 'W2', reopen: true,
      chairsNeeded: 1, wheelchairNeeded: 5, // 容量只有 1
      vehicles: [],
    }], { now: null })
  assert.ok(badWheelchair.issues.some((i) => i.code === 'WHEELCHAIR_EXCEEDED'))

  const badChairs = evaluatePlan(tables.get('sites'),
    tables.get('mobility'), tables.get('seats'), timeline, [{
      site: 'S1', window: 'W2', chairsNeeded: 99, wheelchairNeeded: 0,
      vehicles: [],
    }], { now: null })
  assert.ok(badChairs.issues.some((i) => i.code === 'CHAIRS_EXCEEDED'))
})

test('同一车辆同窗向两个街区承诺被拦截；锁车也被拦截', () => {
  const conflict = evaluatePlan(tables.get('sites'), tables.get('mobility'),
    tables.get('seats'), timeline, [{
      site: 'S1', window: 'W2', chairsNeeded: 0, wheelchairNeeded: 0,
      vehicles: [{ vehicle: 'V1', service: '普通', block: 'B1' },
        { vehicle: 'V1', service: '普通', block: 'B2' }],
    }], { now: null })
  assert.ok(conflict.issues.some((i) => i.code === 'VEHICLE_CONFLICT'))

  const withLock = evaluatePlan(tables.get('sites'), tables.get('mobility'),
    tables.get('seats'), timeline, [{
      site: 'S1', window: 'W2', chairsNeeded: 0, wheelchairNeeded: 0,
      vehicles: [{ vehicle: 'V1', service: '轮椅', block: 'B1' }],
    }], { now: 101 })
  assert.ok(withLock.issues.some((i) => i.code === 'VEHICLE_LOCKED'))
})

test('阻断趟次被标记为车辆问题，提示关闭会改变观察覆盖', () => {
  const blocked = evaluatePlan(tables.get('sites'), tables.get('mobility'),
    tables.get('seats'), timeline, [{
      site: 'S1', window: 'W2', chairsNeeded: 0, wheelchairNeeded: 0,
      vehicles: [{ vehicle: 'V1', service: '普通', block: 'B2' }],
    }], { now: null })
  assert.ok(blocked.issues.some((i) => i.code === 'VEHICLE_TRIP_BLOCKED'))
})

test('一趟车关闭：列出受影响预约，说明观察覆盖与次段确认同时受影响', () => {
  const impact = tripClosureImpact(
    tables.get('seats'), tables.get('notifications'), timeline, 'V1', 'W2')
  assert.equal(impact.vehicle, 'V1')
  assert.deepEqual(impact.affectedSeats.map((s) => s.id).sort(), ['A1', 'A2'])
  // V1 在 W2 的通知 N1/N3/N4 一并带出，便于联系受影响街区。
  assert.deepEqual([...impact.affectedNotices].sort(), ['N1', 'N3', 'N4'])
  // A2 已出发、A1 已接受：V1 关闭同时冲击在途接送与待确认预约。
  const phases = impact.affectedSeats.map((s) => s.phase)
  assert.ok(phases.includes('已出发'))
  assert.ok(phases.includes('已接受'))
})
