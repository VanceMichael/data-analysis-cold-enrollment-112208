// 对外公共简报口径。
// 规则：
// - share='仅本点' 的低温脆弱分组只能本点看见，不纳入对外小计；
// - share='对外' 的分组还要满足 min_group（最小分组规模）才发布；
// - 对外小计是去重人数，不能用服务人次充当覆盖。

import { composite, num, text } from './records.js'
import { indexAttendance, indexQueue } from './demand.js'

/** 某分组在指定窗集合内的去重人数（按匿名号）。 */
export function groupHeadcount(tables, groupRow) {
  const windows = composite(groupRow.slots)
  const attendance = indexAttendance(tables.get('attendance'))
  const queue = indexQueue(tables.get('queue'))
  const people = new Set()

  // “行动协助”类以轮椅预约/等车证据识别；“普通入站”以接纳/转点/再次入站识别。
  const isAssistance = text(groupRow.group) === '行动协助'
  for (const window of windows) {
    const amap = attendance.get(window)
    if (amap) {
      for (const rec of amap.values()) {
        const hit = isAssistance
          ? rec.events.has('轮椅预约')
          : [...rec.events].some((e) => ['接纳', '转点'].includes(e))
        if (hit) people.add(rec.anonymous)
      }
    }
    const qmap = queue.get(window)
    if (qmap) {
      for (const rec of qmap.values()) {
        if (isAssistance && rec.state === '等车') people.add(rec.anonymous)
        if (!isAssistance && rec.state === '再次入站') people.add(rec.anonymous)
      }
    }
  }
  return [...people].sort()
}

/**
 * 生成可发布的公共简报。
 * 返回每个分组的可发布性、依据，以及对外小计（仅含可发布分组，去重人数）。
 */
export function publicBriefing(tables) {
  const rows = tables.get('disclosure')
  const groups = rows.map((row) => {
    const headcount = groupHeadcount(tables, row)
    const share = text(row.share)
    const minGroup = num(row.min_group)
    const internalOnly = share === '仅本点'
    const belowThreshold = headcount.length < minGroup
    return {
      group: text(row.group),
      slots: composite(row.slots),
      share,
      minGroup,
      headcount: headcount.length,
      persons: headcount,
      publishable: !internalOnly && !belowThreshold,
      reasons: [
        ...(internalOnly ? ['仅本点可见的脆弱分组，不纳入对外小计'] : []),
        ...(belowThreshold ? [`去重人数 ${headcount.length} 低于最小分组 ${minGroup}`] : []),
      ],
    }
  })

  const publishable = groups.filter((g) => g.publishable)
  // 跨分组去重：同一匿名号在多个可发布分组中只计一次。
  const publicPeople = new Set()
  for (const g of publishable) g.persons.forEach((p) => publicPeople.add(p))

  return {
    groups,
    publicTotal: publicPeople.size,
    publicPersons: [...publicPeople].sort(),
    note: '对外小计只含 share=对外 且达到最小分组规模的去重人数',
  }
}
