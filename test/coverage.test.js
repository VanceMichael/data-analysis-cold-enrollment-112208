import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadTables, text } from '../src/records.js'
import { buildTimeline } from '../src/time.js'
import {
  reconcileTonight, closedSiteImpact, unmetCandidates,
  evaluateCoverageOption, vehicleReinforcement,
} from '../src/coverage.js'
import { estimateBacklog, queueEvidence } from '../src/queue.js'

const tables = await loadTables(new URL('../data/', import.meta.url))
const timeline = buildTimeline(
  tables.get('attendance'), tables.get('queue'), tables.get('seats'))

test('当夜对账：承诺与需求核到 W1/W2 同一区间，关闭点的承诺标为风险', () => {
  const r = reconcileTonight(tables, timeline, 100)
  assert.deepEqual(r.windows, ['W1', 'W2'])
  // A1 指向临时关闭的 S2 -> 风险；A2 在营业中的 S1，本身不失效。
  assert.deepEqual(r.failingCommitments.map((c) => c.id), ['A1'])
  assert.ok(r.commitments.find((c) => c.id === 'A2').atRisk === false)
  const w1 = r.byWindow.find((x) => x.window === 'W1')
  assert.equal(w1.turned[0].anonymous, 'P2')
  assert.ok(w1.served.includes('P1'))
})

test('邻点关闭：列出失效承诺与必须联系的具体人群', () => {
  const impacts = closedSiteImpact(tables, timeline, 'W2')
  assert.equal(impacts.length, 1)
  const s2 = impacts[0]
  assert.equal(s2.site, 'S2')
  assert.deepEqual(s2.failingCommitments.map((c) => c.id), ['A1'])
  const contacts = s2.peopleToContact.map((p) => p.anonymous)
  // P4 轮椅预约 + 门口等车；P11 在等。
  assert.ok(contacts.includes('P4'))
  assert.ok(contacts.includes('P11'))
  // S2 上的未确认通知 N2 被带出，供联系决策。
  assert.ok(s2.pendingNotices.some((n) => n.notice === 'N2'))
})

test('未满足候选按人去重：同一人多点多事件只出现一次', () => {
  const candidates = unmetCandidates(tables, timeline, 'W2')
  const ids = candidates.map((c) => c.anonymous)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.includes('P4'))
})

test('真实资料下延长 S1/W2 资源可行，但 P4 已有到营业点之外的可达路径证据不在 S1：覆盖改善记 0', () => {
  const result = evaluateCoverageOption(tables, timeline, [{
    site: 'S1', window: 'W2', chairsNeeded: 5, wheelchairNeeded: 1,
    vehicles: [],
  }], { now: null })
  assert.equal(result.feasible, true)
  // P4 属 B1：B1->S1/101 无通达资料（未知），不能计入 S1 延长的覆盖；
  // 唯一真实可达记录 B1->S2/101 指向临时关闭点，延长 S1 不新增可证实覆盖。
  assert.equal(result.coverage.genuineGain, 0)
  assert.ok(result.coverage.unknownReachPersons.some((p) => p.anonymous === 'P4'))
  // 人次口径被显式保留作对照，但不参与结论。
  assert.ok(result.coverage.personTripsConsidered >= result.coverage.genuineGain)
})

test('重开 S2/W2 单方案不可行：关闭点需显式 reopen，且 V1 被已出发预约锁定', () => {
  const result = evaluateCoverageOption(tables, timeline, [{
    site: 'S2', window: 'W2', reopen: true,
    chairsNeeded: 5, wheelchairNeeded: 1,
    vehicles: [{ vehicle: 'V1', service: '轮椅', block: 'B1' }],
  }], { now: 101 })
  assert.equal(result.feasible, false)
  assert.equal(result.coverage.genuineGain, 0) // 不可行时不得宣称覆盖改善
  const codes = result.resourceIssues.map((i) => i.code)
  assert.ok(codes.includes('VEHICLE_LOCKED'))
})

test('同窗同时延长 S1 与重开 S2 触发夜班人员 E1 冲突', () => {
  const result = evaluateCoverageOption(tables, timeline, [
    { site: 'S1', window: 'W2', chairsNeeded: 1, wheelchairNeeded: 0, vehicles: [] },
    { site: 'S2', window: 'W2', reopen: true,
      chairsNeeded: 1, wheelchairNeeded: 0, vehicles: [] },
  ], { now: null })
  assert.equal(result.feasible, false)
  assert.ok(result.resourceIssues.some((i) => i.code === 'STAFF_CONFLICT'))
})

test('增派未受阻车辆到关闭点需显式重开；资源可行但无可达证据时改善记 0', () => {
  // V2 在 W2 的既有趟次均 available=true（B2/S2、B3/S2），可增派；
  // S2 临时关闭，必须带 reopen 才谈得上恢复服务。
  const result = vehicleReinforcement(tables, timeline, {
    window: 'W2', site: 'S2', vehicle: 'V2', service: '普通',
    block: 'B2', slot: '101',
  })
  assert.equal(result.feasible, false)
  assert.ok(result.resourceIssues.some((i) => i.code === 'SITE_CLOSED'))

  const reopened = vehicleReinforcement(tables, timeline, {
    window: 'W2', site: 'S2', vehicle: 'V2', service: '普通',
    block: 'B2', slot: '101', reopen: true,
  })
  assert.equal(reopened.feasible, true)
  assert.equal(reopened.coverage.genuineGain, 0)
  // B2 在 101 对 S2 有阻断记录的是 V1 趟次；候选人群里没有可证实由 V2 新送达的人。
  assert.equal(reopened.coverage.reachablePersons.length, 0)
})

test('合成场景：通达补齐后覆盖改善按去重人群增加，而非人次', () => {
  // 深拷贝资料并为 B1->S1/101 补一条可达记录。
  const synthetic = new Map([...tables].map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
  synthetic.get('mobility').push({
    block: 'B1', site: 'S1', slot: '101', vehicle: 'V3',
    service: '轮椅', available: 'true',
  })
  const synTimeline = buildTimeline(
    synthetic.get('attendance'), synthetic.get('queue'), synthetic.get('seats'))
  const result = evaluateCoverageOption(synthetic, synTimeline, [{
    site: 'S1', window: 'W2', chairsNeeded: 5, wheelchairNeeded: 1,
    vehicles: [{ vehicle: 'V3', service: '轮椅', block: 'B1' }],
  }], { now: null })
  assert.equal(result.feasible, true)
  // P4（B1，轮椅预约+等车）现在可证实可达 S1 -> 覆盖 +1 人；
  // 其在 S2 的多次出现不重复计数。
  assert.equal(result.coverage.genuineGain, 1)
  assert.deepEqual(result.coverage.reachablePersons.map((p) => p.anonymous), ['P4'])
})

test('排队重估：只承认有离场证据的人，缺 leave 者保留等待，不滚入下一时段', () => {
  const backlog = estimateBacklog(tables.get('queue'), 'S2', 'W2')
  // P4 等车(leave=?)、P11 在等(leave=?) 仍等待；P10 有 leave=101 已离开。
  assert.equal(backlog.backlogLowerBound, 2)
  assert.deepEqual(backlog.confirmedLeft, ['P10'])
  assert.deepEqual(backlog.waiting.map((p) => p.anonymous).sort(), ['P11', 'P4'])
  assert.equal(backlog.averageObservedWait, 1) // P10: 101-100
  assert.ok(backlog.note.includes('不滚入下一时段'))
})

test('单条排队证据：离开 vs 等待分类', () => {
  const left = queueEvidence({ anonymous: 'X', site: 'S2', arrive: '100',
    leave: '102', window: 'W2', state: '离开' })
  assert.equal(left.confirmedLeave, true)
  const waiting = queueEvidence({ anonymous: 'Y', site: 'S2', arrive: '101',
    leave: '?', window: 'W2', state: '在等' })
  assert.equal(waiting.stillWaiting, true)
  assert.equal(waiting.confirmedLeave, false)
})
