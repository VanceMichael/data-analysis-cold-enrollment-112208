// 覆盖核算：把估计需求与现有夜间接纳承诺核到同一份区间上。
// 覆盖改善只能用“可到达的去重人群”衡量，不能数人次：
// 同一人在两个点登记不是两份覆盖，转点也不产生新增覆盖。

import { text } from './records.js'
import {
  classifyQueueState, indexAttendance, indexQueue,
} from './demand.js'
import {
  evaluatePlan, siteWindow,
} from './resources.js'
import { reachability } from './weather.js'
import { tonightWindows, windowOf } from './time.js'

/** 当夜区间上的承诺与需求对账。 */
export function reconcileTonight(tables, timeline, asOf) {
  const windows = tonightWindows(timeline)
  const attendance = indexAttendance(tables.get('attendance'))
  const queue = indexQueue(tables.get('queue'))
  const seats = tables.get('seats')
  const sitesRows = tables.get('sites')

  const commitments = seats
    .filter((r) => windows.includes(text(r.window)))
    .map((r) => {
      const sw = siteWindow(sitesRows, text(r.site), text(r.window))
      return {
        id: text(r.id),
        site: text(r.site),
        window: text(r.window),
        closing: text(r.closing),
        phase: text(r.phase),
        vehicle: text(r.vehicle),
        siteState: sw ? sw.state : null,
        atRisk: sw ? sw.state === '临时关闭' : true,
      }
    })

  const byWindow = windows.map((window) => {
    const turned = []
    const reservations = []
    const served = new Set()
    const map = attendance.get(window)
    if (map) {
      for (const rec of map.values()) {
        if (rec.events.has('满员未接')) {
          turned.push({ anonymous: rec.anonymous, block: rec.block,
            sites: [...rec.sites] })
        }
        if (rec.events.has('轮椅预约')) {
          reservations.push({ anonymous: rec.anonymous, block: rec.block,
            sites: [...rec.sites] })
        }
        if (rec.events.has('接纳') || rec.events.has('转点')) {
          served.add(rec.anonymous)
        }
      }
    }
    const waiting = []
    const qmap = queue.get(window)
    if (qmap) {
      for (const rec of qmap.values()) {
        const cls = classifyQueueState(rec.state)
        if (cls === 'waiting' || cls === 'reentry') {
          waiting.push({ anonymous: rec.anonymous, site: rec.site,
            state: rec.state, block: map?.get(rec.anonymous)?.block ?? null })
        }
      }
    }
    return { window, turned, reservations, waiting, served: [...served] }
  })

  // 风险承诺只针对临时关闭点；营业点上的预约本身不构成站点失效，
  // 但其车辆若被关闭点任务占用，会在方案评估的锁车规则中体现。
  return {
    asOf,
    windows,
    commitments,
    failingCommitments: commitments.filter((c) => c.atRisk),
    byWindow,
  }
}

/**
 * 邻点临时关闭：原承诺可能失效的清单与需要联系的人群。
 * 联系人群只列有记录依据的人：该窗该点的预约、等待者、未确认/改派通知。
 */
export function closedSiteImpact(tables, timeline, window) {
  const sitesRows = tables.get('sites')
  const closed = sitesRows
    .filter((r) => text(r.window) === window && text(r.state) === '临时关闭')
    .map((r) => text(r.site))

  const attendance = indexAttendance(tables.get('attendance'))
  const queue = indexQueue(tables.get('queue'))
  return closed.map((site) => {
    const failingCommitments = tables.get('seats')
      .filter((r) => text(r.site) === site && text(r.window) === window)
      .map((r) => ({ id: text(r.id), phase: text(r.phase),
        vehicle: text(r.vehicle), closing: text(r.closing) }))

    const contactMap = new Map()
    const addContact = (anonymous, block, reason, source) => {
      if (!contactMap.has(anonymous)) {
        contactMap.set(anonymous, { anonymous, block, reasons: [], sources: [] })
      }
      const entry = contactMap.get(anonymous)
      if (block && !entry.block) entry.block = block
      if (!entry.reasons.includes(reason)) entry.reasons.push(reason)
      if (!entry.sources.includes(source)) entry.sources.push(source)
    }
    const amap = attendance.get(window)
    if (amap) {
      for (const rec of amap.values()) {
        if (rec.sites.has(site) &&
          (rec.events.has('轮椅预约') || rec.events.has('满员未接'))) {
          addContact(rec.anonymous, rec.block,
            rec.events.has('轮椅预约') ? '轮椅预约受关闭影响' : '满员未接后等待安置',
            'attendance')
        }
      }
    }
    const qmap = queue.get(window)
    if (qmap) {
      for (const rec of qmap.values()) {
        if (rec.site === site &&
          ['waiting'].includes(classifyQueueState(rec.state))) {
          addContact(rec.anonymous, amap?.get(rec.anonymous)?.block ?? null,
            `门口滞留（${rec.state}）`, 'queue')
        }
      }
    }
    const peopleToContact = [...contactMap.values()]
    const notices = tables.get('notifications')
      .filter((r) => text(r.site) === site)
      .filter((r) => windowOf(timeline, text(r.slot)) === window)
      .filter((r) => ['未确认', '改派待确认'].includes(text(r.state)))
      .map((r) => ({ notice: text(r.notice), block: text(r.block),
        state: text(r.state), vehicle: text(r.vehicle) }))

    return { site, window, failingCommitments, peopleToContact,
      pendingNotices: notices }
  })
}

/**
 * 收集某窗“仍有需要、尚未在开放点确认服务”的去重人群。
 * 每人只出现一次（即便在多点多事件出现），并保留其街区用于通达判定。
 */
export function unmetCandidates(tables, timeline, window) {
  const people = new Map()
  const remember = (anonymous, block, need) => {
    if (!people.has(anonymous)) people.set(anonymous, { anonymous, block, needs: [] })
    const p = people.get(anonymous)
    if (block && !p.block) p.block = block
    if (!p.needs.includes(need)) p.needs.push(need)
  }
  const amap = indexAttendance(tables.get('attendance')).get(window)
  if (amap) {
    for (const rec of amap.values()) {
      if (rec.events.has('满员未接')) remember(rec.anonymous, rec.block, '满员未接')
      if (rec.events.has('轮椅预约')) remember(rec.anonymous, rec.block, '轮椅预约')
    }
  }
  const qmap = indexQueue(tables.get('queue')).get(window)
  if (qmap) {
    for (const rec of qmap.values()) {
      const cls = classifyQueueState(rec.state)
      if (cls === 'waiting') {
        remember(rec.anonymous, amap?.get(rec.anonymous)?.block ?? null,
          `门口滞留:${rec.state}`)
      }
    }
  }
  return [...people.values()]
}

/**
 * 评估一个开放/延长/增派方案的真实覆盖变化。
 * 先过资源可行性（人员、普通座位、轮椅位、车辆分开校验），
 * 再逐人核对到目标点的实际通达；只有“可达”的去重人群计入覆盖改善，
 * 阻断者单列，资料不足者列为缺口，绝不折算成人次充数。
 *
 * plan 结构同 resources.evaluatePlan，另可带 slot 与目标 block。
 */
export function evaluateCoverageOption(tables, timeline, plan, options = {}) {
  const sitesRows = tables.get('sites')
  const mobilityRows = tables.get('mobility')
  const resourceCheck = evaluatePlan(sitesRows, mobilityRows,
    tables.get('seats'), timeline, plan, options)

  const windows = [...new Set(plan.map((p) => p.window))]
  const reachable = []
  const blocked = []
  const unknown = []
  const alreadyCovered = []
  const serviceMismatch = []
  const personTripCounter = { count: 0 }

  // 轮椅需要只能由轮椅服务满足；普通车辆的可达记录不构成轮椅覆盖，
  // 轮椅与普通座位条件必须分别成立。
  const needsWheelchair = (person) =>
    person.needs.some((n) => n.includes('轮椅'))
  const serviceOfStep = (step) =>
    [...new Set((step.vehicles ?? []).map((v) => v.service))]

  const openSites = (window) => sitesRows
    .filter((r) => text(r.window) === window && text(r.state) !== '临时关闭')
    .map((r) => text(r.site))

  const reachToAny = (person, window, sites, slots, requiredService) => {
    let verdict = '未知'
    let evidence = null
    for (const slot of slots) {
      for (const site of sites) {
        if (!person.block) return { verdict: '未知', evidence: null }
        const r = reachability(mobilityRows,
          { block: person.block, site, slot })
        if (r.status === '未知') continue
        // 服务类型必须匹配：轮椅需求只认轮椅趟次，普通需求只认普通趟次。
        const serviceOk = requiredService === null ||
          r.services.includes(requiredService)
        if (r.status === '可达' && serviceOk) {
          return { verdict: '可达', evidence: `${site}@${slot}` }
        }
        if (r.status === '阻断' || !serviceOk) {
          verdict = '阻断'
          evidence = `${site}@${slot}`
        }
      }
    }
    return { verdict, evidence }
  }

  for (const window of windows) {
    const candidates = unmetCandidates(tables, timeline, window)
    const windowSlotsAll = timeline.windowSlots.get(window) ?? []
    const open = openSites(window)
    for (const step of plan.filter((p) => p.window === window)) {
      const targetSlots = step.slot ? [step.slot] : windowSlotsAll
      const stepServices = serviceOfStep(step)
      const hasExplicitVehicles = stepServices.length > 0
      // 未显式指定车辆服务时（纯站点延长），按站点自身能力认定；
      // 指定车辆时以车辆服务为准，普通车不能借站点轮椅位承接轮椅需要。
      const sw = siteWindow(sitesRows, step.site, window)
      const siteCapabilities = sw
        ? [...(sw.wheelchair > 0 ? ['轮椅'] : []), ...(sw.chairs > 0 ? ['普通'] : [])]
        : []
      const capabilities = hasExplicitVehicles
        ? stepServices
        : [...new Set([...stepServices, ...siteCapabilities])]
      for (const person of candidates) {
        personTripCounter.count += 1 // 人次口径（仅作对照展示，不用于结论）
        const personNeedsWheelchair = needsWheelchair(person)
        const required = personNeedsWheelchair
          ? '轮椅'
          : (capabilities.includes('普通') ? '普通' : (capabilities[0] ?? null))
        // 普通车辆方案不能承接轮椅需要：服务条件分别成立，不能互相顶替。
        if (personNeedsWheelchair && !capabilities.includes('轮椅')) {
          serviceMismatch.push({ anonymous: person.anonymous, block: person.block,
            site: step.site, window, needs: person.needs,
            reason: '轮椅需要不能由普通车辆/座位满足' })
          continue
        }
        // 已经能到达某个营业点的人，本方案不产生新增覆盖（避免数人次充改善）。
        // 既有覆盖按整窗 slot 判断；目标点的新增覆盖只看方案目标 slot。
        const existing = reachToAny(person, window,
          open.filter((s) => s !== step.site), windowSlotsAll, required)
        if (existing.verdict === '可达') {
          alreadyCovered.push({ anonymous: person.anonymous, block: person.block,
            window, evidence: existing.evidence })
          continue
        }
        const { verdict, evidence } = reachToAny(
          person, window, [step.site], targetSlots, required)
        const entry = { anonymous: person.anonymous, block: person.block,
          site: step.site, window, needs: person.needs, evidence }
        if (verdict === '可达') reachable.push(entry)
        else if (verdict === '阻断') blocked.push(entry)
        else unknown.push(entry)
      }
    }
  }

  // 去重：同一人即使被多个步骤覆盖也只算一个。
  const dedupe = (list) => {
    const seen = new Set()
    return list.filter((e) => {
      const key = `${e.anonymous}|${e.window}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  const reachableUnique = dedupe(reachable)
  const blockedUnique = dedupe(blocked)
  const unknownUnique = dedupe(unknown)
  const alreadyCoveredUnique = dedupe(alreadyCovered)
  const mismatchUnique = dedupe(serviceMismatch)

  return {
    plan,
    feasible: resourceCheck.feasible,
    resourceIssues: resourceCheck.issues,
    coverage: {
      // 真实覆盖改善 = 可到达的去重人群，且方案本身资源可行。
      genuineGain: resourceCheck.feasible ? reachableUnique.length : 0,
      reachablePersons: reachableUnique,
      blockedPersons: blockedUnique,
      unknownReachPersons: unknownUnique,
      alreadyCoveredPersons: alreadyCoveredUnique,
      serviceMismatchPersons: mismatchUnique,
      personTripsConsidered: personTripCounter.count,
      note: '覆盖改善按可到达的去重人群计算，人次仅作对照',
    },
  }
}

/**
 * 增派车辆方案：给定街区、时段、服务类型（轮椅/普通），
 * 检查车辆未锁定且该趟不与既有承诺冲突，再核算可达覆盖。
 */
export function vehicleReinforcement(tables, timeline, {
  window, site, vehicle, service, block, slot, chairsNeeded = 0,
  wheelchairNeeded = 0, reopen = false,
}, engineOptions = {}) {
  const plan = [{
    site, window, slot,
    chairsNeeded,
    wheelchairNeeded,
    reopen,
    vehicles: [{ vehicle, service, block }],
  }]
  return evaluateCoverageOption(tables, timeline, plan, engineOptions)
}
