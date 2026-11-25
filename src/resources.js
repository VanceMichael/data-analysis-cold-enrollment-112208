// 站点容量、夜班人员与车辆资源。
// 规则要点：
// - 人员、车辆、无障碍座位按时段不可重复；同一人员/车辆可在两个点之间共用，
//   但同一供暖窗内同一资源只能落在一个点上。
// - 轮椅接送条件与普通座位条件分别成立，分开校验。
// - 已开始接送（已出发）的车辆保留到该窗结束，不能被重新当待派；
//   联系人确认家庭正架轮椅等原车时，该车对其他街区的新预约不可用。
// - 一趟车关闭会同时改变各点观察覆盖与次段预约可否确认。

import { num, text } from './records.js'
import { windowOf, isFutureSlot, isStartedSlot } from './time.js'

/** 站点在某供暖窗的容量与状态。 */
export function siteWindow(sitesRows, site, window) {
  const row = sitesRows.find(
    (r) => text(r.site) === site && text(r.window) === window)
  if (!row) return null
  return {
    site, window,
    chairs: num(row.chairs),
    wheelchair: num(row.wheelchair),
    staff: text(row.staff),
    state: text(row.state),
  }
}

/** 某窗全部站点（含临时关闭点，用于承诺失效分析）。 */
export function sitesForWindow(sitesRows, window) {
  return sitesRows
    .filter((r) => text(r.window) === window)
    .map((r) => siteWindow(sitesRows, text(r.site), window))
}

/**
 * 车辆可用性视图：window -> vehicle -> 各点记录。
 * mobility 的 available=false 表示该趟阻断。
 */
export function vehicleView(mobilityRows, timeline) {
  const view = new Map()
  for (const row of mobilityRows) {
    const window = windowOf(timeline, row.slot)
    if (window === null) continue
    if (!view.has(window)) view.set(window, new Map())
    const perVehicle = view.get(window)
    const vehicle = text(row.vehicle)
    if (!perVehicle.has(vehicle)) perVehicle.set(vehicle, [])
    perVehicle.get(vehicle).push({
      block: text(row.block),
      site: text(row.site),
      slot: text(row.slot),
      service: text(row.service),
      available: text(row.available) !== 'false',
    })
  }
  return view
}

/**
 * 一趟车在某窗是否已锁定不可重派。
 * 锁定来源：
 * 1) seats 中 phase='已出发' 的预约（已开始接送）；
 * 2) 联系人确认的轮椅等车（notifications 已送达 + queue 等车，见 engine 组装）。
 */
export function lockedVehicles(seatsRows, timeline, now, confirmations = []) {
  const locked = new Map() // window -> Set(vehicle)
  const remember = (window, vehicle, reason, ref) => {
    if (!locked.has(window)) locked.set(window, new Map())
    const map = locked.get(window)
    if (!map.has(vehicle)) map.set(vehicle, [])
    map.get(vehicle).push({ reason, ref })
  }
  for (const row of seatsRows) {
    const window = text(row.window)
    const vehicle = text(row.vehicle)
    if (text(row.phase) === '已出发' ||
        (text(row.phase) === '已接受' && isStartedSlot(now, row.closing))) {
      remember(window, vehicle, '已开始接送，车辆保留至该窗结束', text(row.id))
    }
  }
  for (const c of confirmations) {
    remember(c.window, c.vehicle,
      '联系人确认家庭架轮椅等原车，不得向其他街区承诺新预约', c.ref)
  }
  return locked
}

/**
 * 预约记录视图，并按当前时点判定能否确认。
 * 已开始的预约不可重新当待派；未来时段的预约还要过资源校验。
 */
export function seatStatus(seatsRows, now) {
  return seatsRows.map((row) => {
    const started = !isFutureSlot(now, row.closing)
    return {
      id: text(row.id),
      site: text(row.site),
      window: text(row.window),
      closing: text(row.closing),
      phase: text(row.phase),
      vehicle: text(row.vehicle),
      started,
      reassignable: !started && text(row.phase) !== '已出发',
    }
  })
}

/**
 * 校验一组“开放/延长/增派”方案能否在同一窗内同时成立。
 * 分别检查：人员不冲突、普通座位、轮椅座位、车辆（普通/轮椅分开）、锁车。
 *
 * plan: [{ site, window, chairsNeeded, wheelchairNeeded,
 *          vehicles: [{vehicle, service, block}], staffOverride? }]
 */
export function evaluatePlan(sitesRows, mobilityRows, seatsRows, timeline,
  plan, { now = null, confirmations = [] } = {}) {
  const locked = lockedVehicles(seatsRows, timeline, now, confirmations)
  const issues = []
  const usedStaff = new Map() // window+staff -> site
  const usedVehicles = new Map() // window+vehicle -> {site, service}
  const siteInfo = new Map()

  for (const step of plan) {
    const sw = siteWindow(sitesRows, step.site, step.window)
    siteInfo.set(`${step.site}|${step.window}`, sw)
    if (!sw) {
      issues.push({ level: 'hard', code: 'NO_SITE_RECORD',
        message: `${step.site} 在 ${step.window} 无站点记录`, step })
      continue
    }
    if (sw.state === '临时关闭' && !step.reopen) {
      issues.push({ level: 'hard', code: 'SITE_CLOSED',
        message: `${step.site} 在 ${step.window} 临时关闭，普通延长不成立`, step })
    }

    // 人员：同一窗同一人只能在一个点。
    const staff = step.staffOverride ?? sw.staff
    const staffKey = `${step.window}|${staff}`
    if (usedStaff.has(staffKey)) {
      issues.push({ level: 'hard', code: 'STAFF_CONFLICT',
        message: `人员 ${staff} 在 ${step.window} 已被 ${usedStaff.get(staffKey)} 占用`,
        step })
    } else {
      usedStaff.set(staffKey, step.site)
    }

    // 容量：轮椅与普通分别成立。普通座位 = 总椅位数（轮椅位含在其中单独校验）。
    if ((step.chairsNeeded ?? 0) > sw.chairs) {
      issues.push({ level: 'hard', code: 'CHAIRS_EXCEEDED',
        message: `${step.site} 普通座位需求 ${step.chairsNeeded} > 容量 ${sw.chairs}`,
        step })
    }
    if ((step.wheelchairNeeded ?? 0) > sw.wheelchair) {
      issues.push({ level: 'hard', code: 'WHEELCHAIR_EXCEEDED',
        message: `${step.site} 轮椅位需求 ${step.wheelchairNeeded} > 容量 ${sw.wheelchair}`,
        step })
    }

    const lockMap = locked.get(step.window)
    for (const v of step.vehicles ?? []) {
      const vKey = `${step.window}|${v.vehicle}`
      const lockReasons = lockMap?.get(v.vehicle)
      if (lockReasons) {
        issues.push({ level: 'hard', code: 'VEHICLE_LOCKED',
          message: `车辆 ${v.vehicle} 在 ${step.window} 已锁定`,
          reasons: lockReasons, step })
      }
      if (usedVehicles.has(vKey)) {
        const held = usedVehicles.get(vKey)
        issues.push({ level: 'hard', code: 'VEHICLE_CONFLICT',
          message: `车辆 ${v.vehicle} 在 ${step.window} 同时被 ${held.site} 与 ${step.site} 承诺`,
          step })
      } else {
        usedVehicles.set(vKey, { site: step.site, service: v.service })
      }
      // 同一车辆在该窗的既有阻断趟次才使本方案不可行；
      // 其他车辆的阻断记录不阻止本车增派（阻断街区的影响在覆盖核算中单列）。
      const blocked = mobilityRows.some((r) =>
        text(r.vehicle) === v.vehicle &&
        windowOf(timeline, r.slot) === step.window &&
        text(r.available) === 'false' &&
        (!v.block || text(r.block) === v.block))
      if (blocked) {
        issues.push({ level: 'hard', code: 'VEHICLE_TRIP_BLOCKED',
          message: `车辆 ${v.vehicle} 在 ${step.window} 存在阻断趟次，关闭会改变观察覆盖`,
          step })
      }
    }
  }

  return {
    feasible: issues.length === 0,
    issues,
    locks: locked,
    usedStaff: [...usedStaff.entries()],
    usedVehicles: [...usedVehicles.entries()],
  }
}

/**
 * 一趟车关闭的影响：列出受影响的预约与受影响街区，
 * 供“观察覆盖变化 + 次段预约能否确认”说明使用。
 */
export function tripClosureImpact(seatsRows, notificationsRows, timeline,
  vehicle, window) {
  const affectedSeats = seatsRows
    .filter((r) => text(r.vehicle) === vehicle && text(r.window) === window)
    .map((r) => ({ id: text(r.id), site: text(r.site), phase: text(r.phase),
      closing: text(r.closing) }))
  const affectedNotices = notificationsRows
    .filter((r) => text(r.vehicle) === vehicle &&
      windowOf(timeline, r.slot) === window)
    .map((r) => text(r.notice))
  return { vehicle, window, affectedSeats, affectedNotices }
}
