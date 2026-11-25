// 来源资料访问层。
// 约定（见 README）：原始记录全部以字符串保存；问号表示缺值；
// 加号是来源系统的组合编号分隔符。本层只做解析，不改变原始表内容。

export const MISSING = null

/** 字符串字段：'?' / undefined 归一为 null，其余保留字符串。 */
export function text(value) {
  if (value === undefined || value === '?' || value === null) return MISSING
  return String(value)
}

/** 数字字段：缺值返回 null；非有限数字抛出错误，避免静默吞掉脏数据。 */
export function num(value) {
  if (value === undefined || value === '?' || value === null) return MISSING
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`无法把 ${JSON.stringify(value)} 解析为数字`)
  }
  return parsed
}

/** 布尔字段：仅接受 'true' / 'false' 字符串。 */
export function flag(value) {
  if (value === 'true') return true
  if (value === 'false') return false
  return MISSING
}

/** 组合编号拆分，例如 'W2+W3' -> ['W2', 'W3']。 */
export function composite(value, separator = '+') {
  const raw = text(value)
  if (raw === MISSING) return []
  return raw.split(separator).map((part) => part.trim()).filter(Boolean)
}

/**
 * 读取全部来源表。返回 Map<表名, 原始行数组>，行内仍是原始字符串，
 * 业务模块通过上面的解析访问器取值，保证“原始值格式可追溯”。
 */
export async function loadTables(dirUrl) {
  const { readFile } = await import('node:fs/promises')
  const names = [
    'weather', 'attendance', 'mobility', 'sites', 'coverage',
    'seats', 'notifications', 'queue', 'disclosure',
  ]
  const tables = new Map()
  for (const name of names) {
    const file = new URL(`${name}.json`, dirUrl)
    const rows = JSON.parse(await readFile(file, 'utf8'))
    tables.set(name, rows)
  }
  return tables
}
