// 需求估计。
// 核心口径：
// 1) 去重键是 (匿名号, 供暖窗)：同一人在同一窗到两个点登记只算一人；
//    不同供暖窗是不同的服务需要，再次入站不是重复计数，也不是误报。
// 2) 三层分开报：看得见的需求、交通阻断下的未满足下限、资料不足的潜在范围。
// 3) 历史窗只有在气象组合与通达情况可比时才能用于推断，且只收紧区间。

import { num, text } from './records.js'
import { buildContext, compareContext } from './weather.js'
import { classifyWindow, windowOf } from './time.js'

/** 到场事件归类。转点是真实服务流转，不算误报。 */
export function classifyAttendanceEvent(event) {
  switch (event) {
    case '接纳':
    case '转点':
      return 'served'
    case '满员未接':
      return 'turned'
    case '轮椅预约':
      return 'reservation'
    default:
      return 'other'
  }
}

/** 排队状态归类：已离开有证据，等待类不能被直接填进下一时段。 */
export function classifyQueueState(state) {
  switch (state) {
    case '离开':
      return 'left'
    case '等车':
    case '在等':
      return 'waiting'
    case '再次入站':
      return 'reentry'
    default:
      return 'other'
  }
}

/**
 * 到场去重索引：window -> anonymous -> 合并后的一人记录。
 * 同一窗内多点登记合并，事件取并集，站点取并集。
 */
export function indexAttendance(attendanceRows) {
  const byWindow = new Map()
  for (const row of attendanceRows) {
    const window = text(row.window)
    const anon = text(row.anonymous)
    if (window === null || anon === null) continue
    if (!byWindow.has(window)) byWindow.set(window, new Map())
    const map = byWindow.get(window)
    if (!map.has(anon)) {
      map.set(anon, {
        anonymous: anon, block: text(row.block), window,
        events: new Set(), sites: new Set(), slots: new Set(),
      })
    }
    const rec = map.get(anon)
    rec.events.add(text(row.event))
    rec.sites.add(text(row.site))
    rec.slots.add(text(row.slot))
  }
  return byWindow
}

/** 排队索引（同样按 window+anonymous 去重，与到场记录合并用）。 */
export function indexQueue(queueRows) {
  const byWindow = new Map()
  for (const row of queueRows) {
    const window = text(row.window)
    const anon = text(row.anonymous)
    if (window === null || anon === null) continue
    if (!byWindow.has(window)) byWindow.set(window, new Map())
    const map = byWindow.get(window)
    if (!map.has(anon)) {
      map.set(anon, {
        anonymous: anon, site: text(row.site), window,
        state: text(row.state), arrive: text(row.arrive), leave: text(row.leave),
      })
    }
  }
  return byWindow
}

function blockEpisodes(byWindow, block, windows) {
  const out = []
  for (const window of windows) {
    const map = byWindow.get(window)
    if (!map) continue
    for (const rec of map.values()) {
      if (rec.block === block) out.push(rec)
    }
  }
  return out
}

function countByClass(episodes) {
  const served = new Set()
  const turned = new Set()
  const reservations = new Set()
  for (const ep of episodes) {
    for (const event of ep.events) {
      const cls = classifyAttendanceEvent(event)
      if (cls === 'served') served.add(ep.anonymous)
      if (cls === 'turned') turned.add(ep.anonymous)
      if (cls === 'reservation') reservations.add(ep.anonymous)
    }
  }
  return {
    served: served.size,
    turned: turned.size,
    reservations: reservations.size,
    persons: new Set([...served, ...turned, ...reservations]),
  }
}

/**
 * 历史对照：把历史窗各时段与目标夜各时段逐对比较，
 * 返回可用的历史计数及其可比质量。
 */
function historicalEvidence(tables, timeline, block, targetSlots, asOf) {
  const weatherRows = tables.get('weather')
  const mobilityRows = tables.get('mobility')
  const historySlots = timeline.slots.filter(
    (s) => classifyWindow(timeline.slotWindow.get(s)) === '历史',
  )
  let full = false
  let partial = false
  const usedHistorySlots = new Set()
  for (const hSlot of historySlots) {
    const hContext = buildContext(weatherRows, mobilityRows,
      { block, slot: hSlot, asOf: Number.MAX_SAFE_INTEGER })
    for (const tSlot of targetSlots) {
      const tContext = buildContext(weatherRows, mobilityRows,
        { block, slot: tSlot, asOf })
      const cmp = compareContext(hContext, tContext)
      if (!cmp.comparable) continue
      usedHistorySlots.add(hSlot)
      if (cmp.partial) partial = true
      else full = true
    }
  }
  const historyWindows = [...usedHistorySlots].map((s) => windowOf(timeline, s))
  const episodes = blockEpisodes(
    indexAttendance(tables.get('attendance')), block, historyWindows)
  const counts = countByClass(episodes)
  const observed = counts.served + counts.turned
  return {
    usable: usedHistorySlots.size > 0,
    confidence: full ? 'full' : (partial ? 'partial' : 'none'),
    slots: [...usedHistorySlots],
    served: counts.served,
    turned: counts.turned,
    unmetRate: observed === 0 ? null : counts.turned / observed,
  }
}

/**
 * 估计一个街区在目标供暖窗集合上的需求（默认当夜窗）。
 *
 * 公式（显式写定，便于值班复核）：
 * - visible：按 (匿名号,窗) 去重后的已服务、满员未接、预约计数。
 * - minUnmet（阻断下限）= 可见满员未接
 *     + 若当夜存在阻断记录且 coverage.prior_state='断报'，
 *       再加 max(0, reserved − 已服务 − 已见预约)：已承诺但未见履约的人。
 * - maxUnmet（潜在上限）= max(0, eligible − 已服务人数)：
 *     所有未观察到服务的清单人口都可能仍有需求。
 * - pointEstimate：仅当存在可比历史时给出（历史未满足率 × 未见人口）；
 *     部分可比时标记 partial，完全不可比时为 null，只保留区间。
 */
export function estimateBlock(tables, timeline, block, options = {}) {
  const asOf = options.asOf ?? Number.MAX_SAFE_INTEGER
  const windows = options.windows ??
    timeline.windows.filter((w) => classifyWindow(w) === '当夜')
  const attendance = indexAttendance(tables.get('attendance'))
  const episodes = blockEpisodes(attendance, block, windows)
  const counts = countByClass(episodes)
  const visible = {
    served: counts.served,
    turnedAway: counts.turned,
    reservations: counts.reservations,
    total: counts.persons.size,
    persons: [...counts.persons].sort(),
  }

  const coverage = tables.get('coverage').find((r) => text(r.block) === block)
  const eligible = coverage ? num(coverage.eligible) : null
  const reserved = coverage ? num(coverage.reserved) : 0
  const priorState = coverage ? text(coverage.prior_state) : null

  const targetSlots = [...new Set(episodes.flatMap((e) => [...e.slots]))]
  const mobilityRows = tables.get('mobility')
  const blockedSlots = mobilityRows
    .filter((r) => text(r.block) === block && text(r.available) === 'false')
    .filter((r) => windows.includes(windowOf(timeline, r.slot)))
    .map((r) => text(r.slot))
  const disruption = blockedSlots.length > 0

  const hiddenAtRisk = disruption && priorState === '断报'
    ? Math.max(0, reserved - counts.served - counts.reservations)
    : 0
  const minUnmet = counts.turned + hiddenAtRisk

  const history = historicalEvidence(tables, timeline, block,
    timeline.slots.filter((s) => windows.includes(windowOf(timeline, s))), asOf)

  const unseen = eligible === null
    ? null
    : Math.max(0, eligible - counts.served)
  const maxUnmet = unseen
  let pointEstimate = null
  if (history.usable && history.unmetRate !== null && unseen !== null) {
    pointEstimate = {
      value: Math.round(history.unmetRate * unseen),
      confidence: history.confidence,
      basis: {
        historySlots: history.slots,
        unmetRate: history.unmetRate,
        served: history.served,
        turnedAway: history.turned,
      },
    }
  }

  return {
    block,
    windows,
    visible,
    disruption: { active: disruption, blockedSlots: [...new Set(blockedSlots)] },
    dataGaps: [
      ...(priorState === '断报' ? ['人口清单历史断报'] : []),
      ...(history.usable && history.confidence === 'partial'
        ? ['历史仅部分可比（通达资料不全），无完全可比的历史街区时段'] : []),
      ...(!history.usable ? ['无完全可比的历史街区时段'] : []),
    ],
    estimates: {
      minUnmet,
      maxUnmet,
      pointEstimate,
      reserved,
      eligible,
    },
  }
}

/** 全部街区的需求估计（当夜口径）。 */
export function estimateAllBlocks(tables, timeline, options = {}) {
  const blocks = [...new Set(tables.get('coverage').map((r) => text(r.block)))]
  return blocks.map((b) => estimateBlock(tables, timeline, b, options))
}

/**
 * 次日窗估计：低温持续到次日时，今天已服务的人次不能当新增服务证据，
 * 每个供暖窗单独识别是否需要再次入站。
 */
export function estimateNextDay(tables, timeline, options = {}) {
  const nextWindows = timeline.windows.filter((w) => classifyWindow(w) === '次日')
  const queue = indexQueue(tables.get('queue'))
  const attendance = indexAttendance(tables.get('attendance'))
  const blocks = [...new Set(tables.get('coverage').map((r) => text(r.block)))]
  // 匿名号 -> 街区：queue 表本身无 block 字段，用该匿名号在任意窗的
  // 到场登记推断其所属街区；推断不到的再次入站保留在未归属清单中。
  const ownerOf = new Map()
  for (const map of attendance.values()) {
    for (const rec of map.values()) {
      if (!ownerOf.has(rec.anonymous)) ownerOf.set(rec.anonymous, rec.block)
    }
  }
  const unattributed = []
  const result = blocks.map((block) => {
    const episodes = blockEpisodes(attendance, block, nextWindows)
    const waiting = []
    for (const window of nextWindows) {
      const map = queue.get(window)
      if (!map) continue
      for (const rec of map.values()) {
        if (classifyQueueState(rec.state) !== 'reentry') continue
        const owner = attendance.get(window)?.get(rec.anonymous)?.block
          ?? ownerOf.get(rec.anonymous)
        if (owner === block) waiting.push(rec.anonymous)
        else if (!owner) unattributed.push(rec.anonymous)
      }
    }
    return {
      block,
      windows: nextWindows,
      // 再次入站是新窗的新需要，不与昨夜的服务记录抵消。
      reentryNeed: new Set(waiting).size,
      visibleTotal: new Set(episodes.map((e) => e.anonymous)).size,
      note: '次日需求按供暖窗重新识别，不复用昨夜已服务人次',
    }
  })
  result.unattributedReentry = [...new Set(unattributed)]
  return result
}
