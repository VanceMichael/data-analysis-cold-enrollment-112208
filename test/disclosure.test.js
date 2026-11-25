import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadTables } from '../src/records.js'
import { groupHeadcount, publicBriefing } from '../src/disclosure.js'

const tables = await loadTables(new URL('../data/', import.meta.url))

test('行动协助分组按轮椅预约/等车证据识别并去重', () => {
  const assistance = tables.get('disclosure')
    .find((r) => r.group === '行动协助')
  const people = groupHeadcount(tables, assistance)
  // P4 同时出现在轮椅预约与等车记录，只计一次。
  assert.deepEqual(people, ['P4'])
})

test('普通入站分组统计接纳/转点/再次入站，跨窗按人去重', () => {
  const regular = tables.get('disclosure')
    .find((r) => r.group === '普通入站')
  const people = groupHeadcount(tables, regular)
  // W2 的 P3 + W3 再次入站的 P1。
  assert.ok(people.includes('P3'))
  assert.ok(people.includes('P1'))
})

test('对外简报：仅本点分组不进小计；对外分组达不到最小规模也不发布', () => {
  const briefing = publicBriefing(tables)
  const assistance = briefing.groups.find((g) => g.group === '行动协助')
  assert.equal(assistance.publishable, false)
  assert.ok(assistance.reasons.some((m) => m.includes('仅本点')))

  const regular = briefing.groups.find((g) => g.group === '普通入站')
  assert.equal(regular.publishable, false)
  assert.ok(regular.reasons.some((m) => m.includes('低于最小分组')))

  // 两个分组都不可发布 -> 对外可信小计为 0，而不是把人次加总。
  assert.equal(briefing.publicTotal, 0)
  assert.deepEqual(briefing.publicPersons, [])
})
