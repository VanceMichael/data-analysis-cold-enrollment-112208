// 决策引擎：组装全部模块，对外提供按街区 / 服务点 / 预约班次的查询。
// 每次查询都带当时使用的气象发报时点（决策证据），
// 预报更新只影响未来开门时段，已开始接送的对象不重新当待派。

import { loadTables, text } from './records.js'
import {
  buildTimeline, classifyWindow, tonightWindows, windowOf,
} from './time.js'
import { forecastAt, buildContext } from './weather.js'
import {
  estimateAllBlocks, estimateBlock, estimateNextDay,
} from './demand.js'
import {
  reconcileTonight, closedSiteImpact, evaluateCoverageOption,
  vehicleReinforcement,
} from './coverage.js'
import { estimateBacklog } from './queue.js'
import {
  acceptRevision, confirmedWheelchairLocks, receiptBuckets, reviewToday,
} from './notifications.js'
import { publicBriefing } from './disclosure.js'
import { seatStatus, siteWindow } from './resources.js'

export class ColdResponseEngine {
  constructor(tables, options = {}) {
    this.tables = tables
    this.timeline = buildTimeline(
      tables.get('attendance'),
      tables.get('queue'),
      tables.get('seats'),
    )
    // 街区主数据来自人口服务清单 coverage。
    this.blocks = [...new Set(
      tables.get('coverage').map((r) => text(r.block)))]
    // 当前决策时点（发报时点口径）；默认取最大 issue，即最新一轮预报。
    this.asOf = options.asOf ?? maxIssue(tables.get('weather'))
    this.now = options.now ?? null
  }

  static async fromDir(dirUrl, options = {}) {
    const tables = await loadTables(dirUrl)
    return new ColdResponseEngine(tables, options)
  }

  /** 决策证据：每个街区每个有效时段实际采用的预报版本。 */
  weatherBasis() {
    const basis = []
    for (const slot of this.timeline.slots) {
      for (const block of this.blocks) {
        const picked = forecastAt(this.tables.get('weather'),
          { block, slot, asOf: this.asOf })
        if (picked) {
          basis.push({
            block, slot, window: windowOf(this.timeline, slot),
            issueUsed: text(picked.issue), asOf: this.asOf,
            temp: text(picked.temp), snow: text(picked.snow),
            wind: text(picked.wind),
            period: classifyWindow(windowOf(this.timeline, slot)),
          })
        }
      }
    }
    return basis
  }

  /** 街区维度：未满足量三层估计。 */
  queryByBlock(block) {
    return estimateBlock(this.tables, this.timeline, block, { asOf: this.asOf })
  }

  allBlockEstimates() {
    return estimateAllBlocks(this.tables, this.timeline, { asOf: this.asOf })
  }

  /** 服务点维度：容量状态、滞留重估、关闭影响。 */
  queryBySite(site) {
    const windows = this.timeline.windows
    return windows.map((window) => {
      const sw = siteWindow(this.tables.get('sites'), site, window)
      const backlog = estimateBacklog(this.tables.get('queue'), site, window)
      return { window, siteWindow: sw, backlog }
    }).filter((entry) => entry.siteWindow || entry.backlog.waiting.length > 0
      || entry.backlog.confirmedLeft.length > 0)
  }

  /** 预约班次维度：每个预约当前能否确认、车辆是否锁定。 */
  queryByShift() {
    return seatStatus(this.tables.get('seats'), this.now)
  }

  /** 当夜承诺对账（同一区间核需求与承诺）。 */
  reconciliation() {
    return reconcileTonight(this.tables, this.timeline, this.asOf)
  }

  /** 邻点临时关闭：失效承诺 + 需联系人群。 */
  closureImpacts(window) {
    return closedSiteImpact(this.tables, this.timeline, window)
  }

  /** 方案评估（延长/重开/增派），覆盖改善按可到达去重人群。 */
  evaluatePlan(plan) {
    return evaluateCoverageOption(this.tables, this.timeline, plan,
      { now: this.now, confirmations: confirmedWheelchairLocks(this.tables, this.timeline) })
  }

  /** 增派车辆的快捷评估。 */
  addVehicle(spec) {
    return vehicleReinforcement(this.tables, this.timeline, spec,
      { now: this.now, confirmations: confirmedWheelchairLocks(this.tables, this.timeline) })
  }

  /** 通知回单分桶与当日复核。 */
  notices() {
    return {
      buckets: receiptBuckets(this.tables.get('notifications'), this.timeline),
      review: reviewToday(this.tables, this.timeline),
      wheelchairLocks: confirmedWheelchairLocks(this.tables, this.timeline),
    }
  }

  /** 受理一份暂挂变更，立即反映另一份失去可用性的原因。 */
  accept(notice) {
    return acceptRevision(this.tables, this.timeline, notice,
      { now: this.now })
  }

  /** 次日需求（不复用今夜已服务人次）。 */
  nextDay() {
    return estimateNextDay(this.tables, this.timeline, { asOf: this.asOf })
  }

  /** 对外公共简报。 */
  briefing() {
    return publicBriefing(this.tables)
  }

  /**
   * 应用一轮新预报：只允许影响未来开门时段。
   * 返回新旧预报差异、受影响的未来 slot，以及仍锁定不可重派的预约。
   */
  applyForecast(newWeatherRows) {
    const changes = []
    for (const row of newWeatherRows) {
      const slot = text(row.valid)
      const block = text(row.block)
      const before = forecastAt(this.tables.get('weather'),
        { block, slot, asOf: this.asOf })
      const nextIssue = Number(text(row.issue))
      if (before && nextIssue <= Number(text(before.issue))) continue
      const futureOnly = this.now === null || Number(slot) > Number(this.now)
      changes.push({
        block, slot, window: windowOf(this.timeline, slot),
        previousIssue: before ? text(before.issue) : null,
        nextIssue: text(row.issue),
        appliedToFuture: futureOnly,
        skipped: !futureOnly,
        reason: futureOnly ? null : '时段已开始/已过，预报更新不回溯，已开始接送不重派',
      })
    }
    const applied = changes.filter((c) => !c.skipped)
    if (applied.length > 0) {
      const maxNewIssue = Math.max(
        ...newWeatherRows.map((r) => Number(text(r.issue))))
      this.tables.set('weather',
        [...this.tables.get('weather'), ...newWeatherRows])
      this.asOf = maxNewIssue
    }
    return {
      changes,
      appliedCount: applied.length,
      lockedShifts: seatStatus(this.tables.get('seats'), this.now)
        .filter((s) => !s.reassignable),
      weatherBasis: this.weatherBasis(),
    }
  }

  /** 决策时点上下文快照（查询结果可附带，便于复核）。 */
  decisionMeta() {
    return {
      asOf: this.asOf,
      now: this.now,
      tonightWindows: tonightWindows(this.timeline),
      blocks: this.blocks,
      reachContext: this.timeline.slots.map((slot) =>
        this.blocks.map((block) =>
          buildContext(this.tables.get('weather'),
            this.tables.get('mobility'), { block, slot, asOf: this.asOf }))),
    }
  }
}

function maxIssue(weatherRows) {
  return Math.max(...weatherRows.map((r) => Number(text(r.issue))))
}
