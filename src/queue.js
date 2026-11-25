// 门口滞留与排队重估。
// 规则：只有可确认的排队离场证据（leave 为实际时段、state=离开）
// 才能把人从等待中移除；leave 缺值者继续等待，
// 不能把所有滞留者直接填进下一个时段的需求。

import { num, text } from './records.js'
import { classifyQueueState } from './demand.js'

/** 单条排队记录的证据判定。 */
export function queueEvidence(row) {
  const state = text(row.state)
  const cls = classifyQueueState(state)
  const leave = text(row.leave)
  const confirmedLeave = cls === 'left' && leave !== null
  return {
    anonymous: text(row.anonymous),
    site: text(row.site),
    window: text(row.window),
    arrive: text(row.arrive),
    leave,
    state,
    class: cls,
    confirmedLeave,
    stillWaiting: !confirmedLeave && cls !== 'left',
  }
}

/**
 * 重估某点某窗的滞留等待。
 * 返回等待下限（仍在等且无离场证据）与不确定部分（状态缺失等）。
 */
export function estimateBacklog(queueRows, site, window) {
  const rows = queueRows
    .filter((r) => text(r.site) === site && text(r.window) === window)
    .map(queueEvidence)

  const waiting = rows.filter((r) => r.stillWaiting)
  const left = rows.filter((r) => r.confirmedLeave)
  const unknown = rows.filter(
    (r) => !r.confirmedLeave && !r.stillWaiting)

  // 等待时长只对有离场证据者计算（arrive/leave 都是时段号）。
  const observedWaits = left
    .map((r) => ({ anonymous: r.anonymous,
      wait: num(r.leave) - num(r.arrive) }))
    .filter((r) => Number.isFinite(r.wait))

  return {
    site, window,
    backlogLowerBound: waiting.length,
    waiting,
    confirmedLeft: left.map((r) => r.anonymous),
    unknown,
    observedWaits,
    averageObservedWait: observedWaits.length === 0
      ? null
      : observedWaits.reduce((s, r) => s + r.wait, 0) / observedWaits.length,
    note: '无离场证据者保留在等待中，不滚入下一时段',
  }
}
