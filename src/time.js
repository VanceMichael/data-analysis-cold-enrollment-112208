// 时间轴：把发报时点(issue)、有效时段(slot)与供暖窗(window)串起来。
// 合成资料里时段按编号排序即可比较先后（90 < 91 < 100 < ...）。

import { text } from './records.js'

/**
 * 建立 slot -> window 的权威索引（以到场登记为准），
 * 同时记录每个 window 下出现过的全部 slot（按数值升序）。
 * queue 的 arrive 只用于排队自身的时间记录，不参与权威 slot 归属：
 * 同一 slot 在不同资料里可能挂不同 window（如转点/跨窗滞留），
 * 权威口径必须与气象 valid 和到场 slot 对齐。
 */
export function buildTimeline(attendanceRows, queueRows, seatRows) {
  const slotWindow = new Map()
  const windowSlots = new Map()
  const index = (slotRaw, windowRaw) => {
    const slot = text(slotRaw)
    const window = text(windowRaw)
    if (slot === null || window === null) return
    if (!slotWindow.has(slot)) slotWindow.set(slot, window)
    if (!windowSlots.has(window)) windowSlots.set(window, new Set())
    windowSlots.get(window).add(slot)
  }
  attendanceRows.forEach((r) => index(r.slot, r.window))
  seatRows.forEach((r) => index(r.closing, r.window))

  // 排队表的 arrive 只在权威映射缺失时补登记（如次日窗 W3），
  // 已有的 slot->window 归属不被排队资料覆盖，避免跨窗滞留串槽。
  for (const row of queueRows) {
    const window = text(row.window)
    const arrive = text(row.arrive)
    if (window === null || arrive === null) continue
    if (!slotWindow.has(arrive)) {
      slotWindow.set(arrive, window)
      if (!windowSlots.has(window)) windowSlots.set(window, new Set())
      windowSlots.get(window).add(arrive)
    }
  }

  const windows = [...windowSlots.keys()].sort()
  const slots = [...slotWindow.keys()].sort((a, b) => Number(a) - Number(b))
  return {
    slots,
    windows,
    slotWindow: new Map(slotWindow),
    windowSlots: new Map(
      [...windowSlots.entries()].map(([w, set]) => [
        w,
        [...set].sort((a, b) => Number(a) - Number(b)),
      ]),
    ),
  }
}

/** slot 属于哪个供暖窗；未知时段返回 null。 */
export function windowOf(timeline, slot) {
  return timeline.slotWindow.get(text(slot)) ?? null
}

/**
 * 时段分期（业务规则）：
 * - 历史窗：已经完整结束、只用于对照的供暖窗（资料中为 W0）；
 * - 当夜：当前承诺要履约的窗（W1、W2），夜间接纳承诺核到这一区间；
 * - 次日：低温持续时需要重新识别需求的窗（W3），今天已服务的人次
 *   不能充当次日的新增服务证据。
 */
export function classifyWindow(window) {
  if (window === null || window === undefined) return '未知'
  if (window === 'W0') return '历史'
  if (window === 'W3') return '次日'
  return '当夜'
}

/** 当夜覆盖区间：承诺核到同一区间时使用的供暖窗集合。 */
export function tonightWindows(timeline) {
  return timeline.windows.filter((w) => classifyWindow(w) === '当夜')
}

/**
 * 判定 slot 是否落在“当前时刻 now”之后。
 * 预报更新通常只影响未来开门时段；已开始接送的对象不能被重新当待派。
 */
export function isFutureSlot(now, slot) {
  if (now === null || now === undefined) return true
  return Number(slot) > Number(now)
}

/** 一个时段是否已经开始（车辆/预约锁定判定使用）。 */
export function isStartedSlot(now, slot) {
  if (now === null || now === undefined) return false
  return Number(slot) <= Number(now)
}
