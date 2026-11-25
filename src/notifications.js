// 告知与改派。
// 规则要点：
// - 下午已答复可接纳的街区，晚间改派按确认回单区分：已出门 / 等车 / 未收到通知。
// - 联系人确认家庭架轮椅等原车时，该车不能再向另一街区承诺新预约（原车锁）。
// - 两份未确认变更可同时暂挂等待一个受理决定；确认其中一份后，
//   查询必须立刻显示另一份为何失去可用性（共享资源被占）。
// - 通知复核按履约情况逐条留痕，作为值班组当日复核依据。

import { text } from './records.js'
import { evaluatePlan, siteWindow } from './resources.js'
import { windowOf } from './time.js'

export const NOTICE_STATES = Object.freeze({
  DELIVERED: '送达',
  UNCONFIRMED: '未确认',
  REVISION_PENDING: '改派待确认',
})

/** 回单分桶：按确认回单区分人群，未确认者不假定其已出门。 */
export function receiptBuckets(notificationsRows, timeline) {
  const buckets = {
    delivered: [],      // 已收到告知（含已出门、等车等已送达回单）
    awaitingReply: [],  // 改派待确认：等车/未收到通知尚未分清
    unconfirmed: [],    // 未确认
  }
  for (const row of notificationsRows) {
    const entry = {
      notice: text(row.notice), block: text(row.block), site: text(row.site),
      slot: text(row.slot), vehicle: text(row.vehicle),
      state: text(row.state), revision: text(row.revision),
      window: windowOf(timeline, row.slot),
    }
    if (entry.state === NOTICE_STATES.DELIVERED) buckets.delivered.push(entry)
    else if (entry.state === NOTICE_STATES.REVISION_PENDING) {
      buckets.awaitingReply.push(entry)
    } else buckets.unconfirmed.push(entry)
  }
  return buckets
}

/**
 * 由排队/到场资料识别“原车锁”：联系人确认的轮椅等车。
 * 这里的确认依据是 attendance 中存在轮椅预约、queue 中同一匿名号
 * 在同窗处于等车状态，且通知已送达该车辆。
 */
export function confirmedWheelchairLocks(tables, timeline) {
  const attendance = tables.get('attendance')
  const queue = tables.get('queue')
  const notifications = tables.get('notifications')
  const locks = []
  for (const q of queue) {
    if (text(q.state) !== '等车') continue
    const window = text(q.window)
    const anon = text(q.anonymous)
    const reservation = attendance.find((r) =>
      text(r.anonymous) === anon &&
      text(r.window) === window &&
      text(r.event) === '轮椅预约')
    if (!reservation) continue
    const site = text(q.site)
    const slot = text(q.arrive)
    const notice = notifications.find((r) =>
      text(r.site) === site &&
      text(r.slot) === slot &&
      text(r.state) === NOTICE_STATES.DELIVERED)
    if (!notice) continue
    locks.push({
      ref: text(notice.notice),
      anonymous: anon,
      window,
      site,
      vehicle: text(notice.vehicle),
      block: text(reservation.block),
    })
  }
  return locks
}

/**
 * 尝试受理一份暂挂变更。
 * 同窗共享同一资源（车辆/人员）的其他暂挂变更会立即失去可用性，
 * 返回每份暂挂变更的状态与原因，保证查询可直接展示。
 *
 * acceptedNotice: 被受理的 notice 编号。
 */
export function acceptRevision(tables, timeline, acceptedNotice, options = {}) {
  const rows = tables.get('notifications')
  const pending = rows.filter((r) =>
    text(r.state) === NOTICE_STATES.REVISION_PENDING)
  const target = rows.find((r) => text(r.notice) === acceptedNotice)
  if (!target) {
    return { ok: false, reason: '通知不存在', decisions: [] }
  }
  if (text(target.state) !== NOTICE_STATES.REVISION_PENDING) {
    return { ok: false, reason: `状态为 ${text(target.state)}，不在暂挂中`,
      decisions: [] }
  }

  const confirmations = confirmedWheelchairLocks(tables, timeline)
  const targetWindow = windowOf(timeline, text(target.slot))
  const plan = [{
    site: text(target.site),
    window: targetWindow,
    chairsNeeded: 0,
    wheelchairNeeded: 0,
    vehicles: [{ vehicle: text(target.vehicle),
      block: text(target.block) }],
  }]
  const check = evaluatePlan(tables.get('sites'), tables.get('mobility'),
    tables.get('seats'), timeline, plan,
    { now: options.now ?? null, confirmations })

  const decisions = pending.map((row) => {
    const notice = text(row.notice)
    const window = windowOf(timeline, text(row.slot))
    if (notice === acceptedNotice) {
      return {
        notice, accepted: check.feasible, window,
        reasons: check.feasible ? ['受理决定已确认'] : check.issues.map((i) => i.message),
      }
    }
    // 同窗、共享车辆或同一站点人员的另一份变更立即失去可用性。
    const sharesVehicle = text(row.vehicle) === text(target.vehicle)
    const sameWindow = window === targetWindow
    if (sameWindow && sharesVehicle) {
      return { notice, accepted: false, window,
        reasons: [`车辆 ${text(target.vehicle)} 已被受理的 ${acceptedNotice} 占用，同窗不可再承诺`] }
    }
    if (sameWindow) {
      const sw = siteWindow(tables.get('sites'), text(row.site), window)
      const targetSw = siteWindow(tables.get('sites'), text(target.site), targetWindow)
      if (sw && targetSw && sw.staff === targetSw.staff) {
        return { notice, accepted: false, window,
          reasons: [`夜班人员 ${sw.staff} 已随 ${acceptedNotice} 锁定到 ${text(target.site)}`] }
      }
    }
    return { notice, accepted: null, window,
      reasons: ['暂挂继续等待受理决定'] }
  })

  return {
    ok: check.feasible,
    accepted: check.feasible ? acceptedNotice : null,
    resourceIssues: check.issues,
    decisions,
  }
}

/**
 * 当日通知履约复核：逐条对照站点状态与通知状态，
 * 输出可复核的履约结论，供值班组按履约情况检查。
 */
export function reviewToday(tables, timeline) {
  return tables.get('notifications').map((row) => {
    const window = windowOf(timeline, text(row.slot))
    const sw = siteWindow(tables.get('sites'), text(row.site), window)
    let finding
    if (sw?.state === '临时关闭') {
      finding = '站点临时关闭：原承诺可能失效，需按回单联系'
    } else if (text(row.state) === NOTICE_STATES.DELIVERED) {
      finding = '已送达，承诺保留'
    } else if (text(row.state) === NOTICE_STATES.REVISION_PENDING) {
      finding = '改派待确认：暂挂，未占用基线资源'
    } else {
      finding = '未确认：不得假定已出门或已收到'
    }
    return {
      notice: text(row.notice), block: text(row.block),
      site: text(row.site), window, slot: text(row.slot),
      vehicle: text(row.vehicle), state: text(row.state),
      revision: text(row.revision), finding,
    }
  })
}
