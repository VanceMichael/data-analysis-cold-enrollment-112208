import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { loadTables } from '../src/records.js'
import { buildTimeline, classifyWindow, windowOf, isFutureSlot } from '../src/time.js'
import {
  forecastAt, weatherSignature, sameSignature, tempBand,
  reachability, compareContext, buildContext,
} from '../src/weather.js'

const dataUrl = new URL('../data/', import.meta.url)
const tables = await loadTables(dataUrl)
const timeline = buildTimeline(
  tables.get('attendance'), tables.get('queue'), tables.get('seats'))

test('时段按供暖窗归位，W0/W3 分别是历史窗与次日窗', () => {
  assert.equal(windowOf(timeline, '100'), 'W1')
  assert.equal(windowOf(timeline, '101'), 'W2')
  assert.equal(windowOf(timeline, '90'), 'W0')
  assert.equal(windowOf(timeline, '102'), 'W3')
  assert.deepEqual(classifyWindow('W0'), '历史')
  assert.deepEqual(classifyWindow('W2'), '当夜')
  assert.deepEqual(classifyWindow('W3'), '次日')
})

test('预报以发报时点为准：同一有效时段取 asOf 可见的最新一版', () => {
  // slot 101 的 B3 有 issue 99/100 两版；asOf=99 只能看到旧版。
  const oldPick = forecastAt(tables.get('weather'),
    { block: 'B3', slot: '101', asOf: 99 })
  const newPick = forecastAt(tables.get('weather'),
    { block: 'B3', slot: '101', asOf: 100 })
  assert.equal(oldPick.issue, '99')
  assert.equal(newPick.issue, '100')
  assert.equal(newPick.temp, '-11')
  // 还没发报时返回 null，而不是静默用未来版本。
  assert.equal(forecastAt(tables.get('weather'),
    { block: 'B3', slot: '101', asOf: 98 }), null)
})

test('温度分档与风雪组合签名', () => {
  assert.equal(tempBand('-12'), '严寒')
  assert.equal(tempBand('-6'), '寒冷')
  const sig = weatherSignature({ temp: '-12', snow: '多', wind: '强' })
  assert.deepEqual(sig, { band: '严寒', snow: '多', wind: '强' })
  assert.equal(sameSignature(sig, { band: '严寒', snow: '多', wind: '强' }), true)
  assert.equal(sameSignature(sig, { band: '寒冷', snow: '多', wind: '强' }), false)
  assert.equal(weatherSignature({ temp: '?', snow: '多', wind: '强' }), null)
})

test('通达三态：可达、阻断、资料不足(未知)，未知不被当作阻断', () => {
  assert.equal(reachability(tables.get('mobility'),
    { block: 'B2', site: 'S2', slot: '91' }).status, '阻断')
  assert.equal(reachability(tables.get('mobility'),
    { block: 'B3', site: 'S2', slot: '101' }).status, '可达')
  // B1 到 S1 在 slot 101 没有任何 mobility 记录：资料不足，保持未知，
  // 既不擅自判可达也不判阻断。
  assert.equal(reachability(tables.get('mobility'),
    { block: 'B1', site: 'S1', slot: '101' }).status, '未知')
})

test('历史可比性：气象与通达都一致才完全可比；硬冲突不可比；缺资料为部分可比', () => {
  // B2 历史 slot 90 与当夜 slot 101：风雪同为严寒/多/强，
  // 90 仅 S2 可达、101 的 S2 同样可达，S1 一侧无历史资料 -> 部分可比。
  const history = buildContext(tables.get('weather'), tables.get('mobility'),
    { block: 'B2', slot: '90', asOf: Number.MAX_SAFE_INTEGER })
  const current = buildContext(tables.get('weather'), tables.get('mobility'),
    { block: 'B2', slot: '101', asOf: 100 })
  const cmp = compareContext(history, current)
  assert.equal(cmp.comparable, true)
  assert.equal(cmp.partial, true)

  // 气象组合不同直接不可比（slot 91 的 B2 是 -11/多/强，签名仍为严寒；
  // 用构造行制造温度档差异与通达硬冲突）。
  const cold = buildContext(
    tables.get('weather'), tables.get('mobility'),
    { block: 'B2', slot: '91', asOf: Number.MAX_SAFE_INTEGER })
  const mild = { ...current, signature: { band: '寒冷', snow: '少', wind: '中' } }
  assert.equal(compareContext(cold, mild).comparable, false)

  // 硬冲突：同一点历史阻断、当前可达。
  const blockedHistory = {
    signature: current.signature,
    reach: [{ site: 'S2', status: '阻断' }],
  }
  const reachableNow = {
    signature: current.signature,
    reach: [{ site: 'S2', status: '可达' }],
  }
  const hard = compareContext(blockedHistory, reachableNow)
  assert.equal(hard.comparable, false)
  assert.equal(hard.partial, false)
  assert.match(hard.reasons[0], /通达由 阻断 变为 可达/)
})

test('未来时段判定：预报更新只影响未来 slot', () => {
  assert.equal(isFutureSlot(100, '101'), true)
  assert.equal(isFutureSlot(100, '100'), false)
  assert.equal(isFutureSlot(null, '90'), true)
})
