// 气象预报与历史街区可比性。
// 以发报时点(issue)与有效时段(valid)为准：同一有效时段可能存在多版预报，
// 决定时必须用“该时点能看到的最新一版”，并把发报时点写进决策证据。

import { num, text } from './records.js'

/** 温度分档（摄氏度），用于温度风雪组合的可比性比较。 */
export function tempBand(celsius) {
  const t = num(celsius)
  if (t === null) return null
  if (t <= -15) return '极寒'
  if (t <= -10) return '严寒'
  if (t <= -5) return '寒冷'
  return '低温'
}

/**
 * 一条预报的“温度风雪组合”签名。
 * 任一要素缺值则签名缺值，该时段不能强行与历史匹配。
 */
export function weatherSignature(row) {
  const band = tempBand(row.temp)
  const snow = text(row.snow)
  const wind = text(row.wind)
  if (band === null || snow === null || wind === null) return null
  return { band, snow, wind }
}

export function sameSignature(a, b) {
  return a !== null && b !== null &&
    a.band === b.band && a.snow === b.snow && a.wind === b.wind
}

/**
 * 取某街区在某有效时段、给定发报时点下可见的最新一版预报。
 * issue <= asOf 中最大者胜出；没有任何已发报记录时返回 null。
 */
export function forecastAt(weatherRows, { block, slot, asOf }) {
  const candidates = weatherRows
    .filter((r) => text(r.block) === block && text(r.valid) === text(slot))
    .filter((r) => num(r.issue) <= Number(asOf))
    .sort((a, b) => num(b.issue) - num(a.issue))
  return candidates[0] ?? null
}

/**
 * 交通通达：取 mobility 表中某街区到某点在某时段的记录。
 * available=false 表示该趟服务阻断；没有记录表示资料不足（未知），
 * 不能当作可达，也不能直接当作阻断。
 */
export function reachability(mobilityRows, { block, site, slot }) {
  const rows = mobilityRows.filter(
    (r) => text(r.block) === block &&
      text(r.site) === site &&
      text(r.slot) === text(slot),
  )
  if (rows.length === 0) return { status: '未知', rows: [] }
  const blocked = rows.some((r) => text(r.available) === 'false')
  return {
    status: blocked ? '阻断' : '可达',
    rows,
    services: rows.map((r) => text(r.service)),
  }
}

/**
 * 历史街区是否可比（业务规则）。
 * 可比性取决于两件事：温度风雪组合，以及到各点的实际通达情况。
 * - 气象签名不一致 -> 不可比；
 * - 同一点出现“历史阻断 vs 当前可达”或反之的硬冲突 -> 不可比；
 * - 某点在一侧没有通达资料 -> 部分可比（证据不全，需求只能给区间）；
 * - 全部点均有资料且一致 -> 完全可比。
 */
export function compareContext(history, current) {
  if (!sameSignature(history.signature, current.signature)) {
    return { comparable: false, partial: false, reasons: ['温度风雪组合不同'] }
  }
  const sites = new Set([
    ...history.reach.map((r) => r.site),
    ...current.reach.map((r) => r.site),
  ])
  let partial = false
  const conflicts = []
  for (const site of sites) {
    const h = history.reach.find((r) => r.site === site)
    const c = current.reach.find((r) => r.site === site)
    if (!h || !c) {
      partial = true
      continue
    }
    if (h.status !== c.status && h.status !== '未知' && c.status !== '未知') {
      conflicts.push(`${site} 通达由 ${h.status} 变为 ${c.status}`)
    }
    if (h.status === '未知' || c.status === '未知') partial = true
  }
  if (conflicts.length > 0) {
    return { comparable: false, partial: false, reasons: conflicts }
  }
  return {
    comparable: true,
    partial,
    reasons: partial ? ['部分站点缺少通达资料'] : ['气象与通达均一致'],
  }
}

/**
 * 为一个街区的某时段构建对照上下文（气象签名 + 各点通达）。
 */
export function buildContext(weatherRows, mobilityRows, { block, slot, asOf }) {
  const forecast = forecastAt(weatherRows, { block, slot, asOf })
  const sites = [...new Set(mobilityRows
    .filter((r) => text(r.block) === block && text(r.slot) === text(slot))
    .map((r) => text(r.site)))]
  const reach = sites.map((site) => ({
    site,
    ...reachability(mobilityRows, { block, site, slot }),
  }))
  return {
    block,
    slot: text(slot),
    issue: forecast ? text(forecast.issue) : null,
    signature: forecast ? weatherSignature(forecast) : null,
    reach,
  }
}
