import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface SQLTable {
  name: string
  columns: { name: string; type: string; pk?: boolean; fk?: string }[]
  rowCount: number
}

export interface QueryPlan {
  operation: string
  table?: string
  cost: number
  rows: number
  children: QueryPlan[]
  index?: string
  filter?: string
}

export interface ParsedQuery {
  type: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE' | 'UNKNOWN'
  tables: string[]
  columns: string[]
  joins: { type: string; table: string; condition: string }[]
  whereConditions: string[]
  orderBy: string[]
  groupBy: string[]
  limit?: number
  complexity: number
  suggestions: string[]
  estimatedCost: number
}

/** 可定位到编辑器原文的片段（偏移量相对于整个编辑器文本） */
export interface Snippet {
  start: number
  end: number
  text: string
}

export interface AdviceReason {
  kind: 'filter' | 'join'
  detail: string
  weight: number
  snippet: Snippet
}

export interface IndexAdvice {
  id: string
  table: string
  column: string
  ddl: string
  kind: 'filter' | 'join' | 'mixed'
  reasons: AdviceReason[]
  weightSum: number
  benefit: number
  costLabel: string
}

export interface IndexAdviceGroup {
  table: string
  rowCount: number
  advices: IndexAdvice[]
}

export interface ColumnIssue {
  id: string
  category: 'wildcard' | 'incomplete'
  table: string | null
  detail: string
  suggestion: string
  snippet: Snippet
}

export interface AnalyzeStep {
  name: string
  status: 'ok' | 'empty' | 'skip'
  message: string
}

export interface StmtAnalysis {
  index: number
  start: number
  end: number
  sql: string
  isEmpty: boolean
  parsed: ParsedQuery
  indexGroups: IndexAdviceGroup[]
  indexAdvices: IndexAdvice[]
  wildcardIssues: ColumnIssue[]
  incompleteIssues: ColumnIssue[]
  steps: AnalyzeStep[]
}

const SCHEMA: SQLTable[] = [
  { name: 'users', rowCount: 50000, columns: [
    { name: 'id', type: 'INT', pk: true }, { name: 'username', type: 'VARCHAR(50)' },
    { name: 'email', type: 'VARCHAR(100)' }, { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'status', type: 'ENUM' }
  ]},
  { name: 'orders', rowCount: 200000, columns: [
    { name: 'id', type: 'INT', pk: true }, { name: 'user_id', type: 'INT', fk: 'users.id' },
    { name: 'product_id', type: 'INT', fk: 'products.id' }, { name: 'amount', type: 'DECIMAL' },
    { name: 'status', type: 'VARCHAR(20)' }, { name: 'created_at', type: 'TIMESTAMP' }
  ]},
  { name: 'products', rowCount: 10000, columns: [
    { name: 'id', type: 'INT', pk: true }, { name: 'name', type: 'VARCHAR(200)' },
    { name: 'price', type: 'DECIMAL' }, { name: 'category_id', type: 'INT', fk: 'categories.id' },
    { name: 'stock', type: 'INT' }
  ]},
  { name: 'categories', rowCount: 100, columns: [
    { name: 'id', type: 'INT', pk: true }, { name: 'name', type: 'VARCHAR(50)' },
    { name: 'parent_id', type: 'INT' }
  ]},
]

const FALLBACK_ROWS = 1000
const ALIAS_GUARD = new Set([
  'WHERE', 'ON', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'SET', 'VALUES', 'INNER', 'LEFT',
  'RIGHT', 'FULL', 'OUTER', 'CROSS', 'JOIN', 'AS', 'SELECT', 'FROM', 'AND', 'OR', 'UNION',
  'NOT', 'NULL', 'BY', 'ASC', 'DESC', 'DISTINCT', 'INTO',
])
const CLAUSE_STOP = new Set(['GROUP', 'ORDER', 'LIMIT', 'HAVING', 'UNION'])
const ON_STOP = new Set(['JOIN', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'UNION'])

// ---------- 基础工具 ----------

function getTable(name: string): SQLTable | undefined {
  return SCHEMA.find(s => s.name === name.toLowerCase())
}

function skipQuoted(sql: string, i: number): number {
  const q = sql[i]
  i++
  while (i < sql.length) {
    if (sql[i] === '\\') { i += 2; continue }
    if (sql[i] === q) {
      if (sql[i + 1] === q) { i += 2; continue }
      return i + 1
    }
    i++
  }
  return i
}

interface Tok { word: string; upper: string; start: number; end: number; depth: number }

function tokenize(sql: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  let depth = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "'" || ch === '"' || ch === '`') { i = skipQuoted(sql, i); continue }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i = Math.min(i + 2, sql.length)
      continue
    }
    if (ch === '(') { depth++; i++; continue }
    if (ch === ')') { depth = Math.max(0, depth - 1); i++; continue }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_]\w*/.exec(sql.slice(i))!
      toks.push({ word: sql.slice(i, i + m[0].length), upper: m[0].toUpperCase(), start: i, end: i + m[0].length, depth })
      i += m[0].length
      continue
    }
    i++
  }
  return toks
}

/** 深度感知地查找从 from 开始第一个 ON（同深度），返回 ON token 在数组中的下标 */
function findOnAtDepth(toks: Tok[], from: number): number {
  const d = toks[from]?.depth ?? 0
  for (let k = from; k < toks.length; k++) {
    if (toks[k].depth < d) return -1
    if (toks[k].depth === d && ON_STOP.has(toks[k].upper)) return -1
    if (toks[k].depth === d && toks[k].upper === 'ON') return k
  }
  return -1
}

/** 从子句关键字之后扫描子句结束位置（按括号深度感知，不进入字符串） */
function clauseEnd(sql: string, start: number, stop: Set<string>): number {
  let depth = 0
  let i = start
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "'" || ch === '"' || ch === '`') { i = skipQuoted(sql, i); continue }
    if (ch === '(') { depth++; i++; continue }
    if (ch === ')') { if (depth === 0) return i; depth--; i++; continue }
    if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_]\w*/.exec(sql.slice(i))!
      if (stop.has(m[0].toUpperCase())) return i
      i += m[0].length
      continue
    }
    i++
  }
  return i
}

interface TableRef { name: string; alias?: string; after: number }

function readTable(sql: string, pos: number): TableRef | null {
  let i = pos
  while (i < sql.length && /\s/.test(sql[i])) i++
  const m = /^[`"\[]?([A-Za-z_]\w*)[`"\]]?/.exec(sql.slice(i))
  if (!m) return null
  const name = m[1].toLowerCase()
  i += m[0].length
  let alias: string | undefined
  const j = i
  let k = j
  while (k < sql.length && /\s/.test(sql[k])) k++
  const am = /^(?:AS\s+)?([A-Za-z_]\w*)/i.exec(sql.slice(k))
  if (am && !ALIAS_GUARD.has(am[1].toUpperCase())) alias = am[1].toLowerCase()
  return { name, alias, after: k + (am && alias ? am[0].length : 0) }
}

/** 按 AND/OR（括号深度 0）切分谓词，返回相对偏移 */
function splitPredicates(text: string, base: number): { text: string; snippet: Snippet }[] {
  const raw: { text: string; start: number; end: number }[] = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') { i = skipQuoted(text, i); continue }
    if (ch === '(') { depth++; i++; continue }
    if (ch === ')') { depth--; i++; continue }
    if (depth === 0) {
      const m = /^\s+(?:AND|OR)\s+/i.exec(text.slice(i))
      if (m) { raw.push({ text: text.slice(start, i), start, end: i }); start = i + m[0].length; i += m[0].length; continue }
    }
    i++
  }
  raw.push({ text: text.slice(start), start, end: text.length })
  return raw
    .map(r => {
      const ls = r.text.match(/^\s*/)![0].length
      const te = r.text.match(/\s*$/)!
      const rs = te.index!
      const lt = r.text.slice(ls, rs)
      if (!lt) return null
      return { text: lt, snippet: { start: base + r.start + ls, end: base + r.start + rs, text: lt } }
    })
    .filter((x): x is { text: string; snippet: Snippet } => !!x)
}

// ---------- 原有解析（复杂度 / 建议 / 计划树输入） ----------

function parseSQL(sql: string): ParsedQuery {
  const up = sql.toUpperCase().trim()
  const type = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE'].find(t => up.startsWith(t)) as ParsedQuery['type'] || 'UNKNOWN'
  const tables = Array.from(sql.matchAll(/(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z_]\w*)/gi)).map(m => m[1].toLowerCase())
  const columns = type === 'SELECT' ? Array.from(sql.matchAll(/SELECT\s+([\s\S]*?)\s+FROM/gi))[0]?.[1]?.split(',').map((s: string) => s.trim()) || [] : []
  const joins = Array.from(sql.matchAll(/(LEFT|RIGHT|INNER|OUTER|CROSS|FULL)?\s*JOIN\s+([a-zA-Z_]\w*)\s+ON\s+([^JOIN|WHERE|GROUP|ORDER|LIMIT]+)/gi)).map(m => ({ type: (m[1] || 'INNER').trim(), table: m[2], condition: m[3].trim() }))
  const whereMatch = sql.match(/WHERE\s+([\s\S]*?)(?:GROUP|ORDER|LIMIT|$)/i)
  const whereConditions = whereMatch ? whereMatch[1].split(/\s+AND\s+|\s+OR\s+/i).map(s => s.trim()).filter(Boolean) : []
  const orderBy = Array.from(sql.matchAll(/ORDER\s+BY\s+([\s\S]*?)(?:LIMIT|$)/gi))[0]?.[1]?.split(',').map((s: string) => s.trim()) || []
  const groupBy = Array.from(sql.matchAll(/GROUP\s+BY\s+([\s\S]*?)(?:HAVING|ORDER|LIMIT|$)/gi))[0]?.[1]?.split(',').map((s: string) => s.trim()) || []
  const limitMatch = sql.match(/LIMIT\s+(\d+)/i)
  const limit = limitMatch ? parseInt(limitMatch[1]) : undefined

  const complexity = tables.length + joins.length * 2 + whereConditions.length + orderBy.length + (sql.includes('DISTINCT') ? 3 : 0) + (sql.includes('HAVING') ? 2 : 0)
  const estimatedCost = tables.reduce((sum, t) => { const tbl = SCHEMA.find(s => s.name === t); return sum + (tbl?.rowCount || 1000) }, 0) * (joins.length + 1) / (limit || 100)

  const suggestions: string[] = []
  if (joins.length > 3) suggestions.push('连接表过多（>3），考虑分解查询')
  if (!whereConditions.length && type === 'SELECT') suggestions.push('无 WHERE 条件，将扫描全表')
  if (sql.includes('SELECT *')) suggestions.push('避免 SELECT *，明确指定列名')
  if (sql.toUpperCase().includes("LIKE '%")) suggestions.push("前缀通配符 LIKE '%...' 无法使用索引")
  if (!limit && type === 'SELECT') suggestions.push('建议添加 LIMIT 限制结果集大小')

  return { type, tables, columns, joins, whereConditions, orderBy, groupBy, limit, complexity, suggestions, estimatedCost: Math.round(estimatedCost) }
}

function buildPlan(parsed: ParsedQuery): QueryPlan {
  if (parsed.tables.length === 0) return { operation: 'EMPTY', cost: 0, rows: 0, children: [] }
  const tableScans: QueryPlan[] = parsed.tables.map(t => {
    const tbl = SCHEMA.find(s => s.name === t)
    return { operation: parsed.whereConditions.length > 0 ? 'Index Scan' : 'Seq Scan', table: t, cost: (tbl?.rowCount || 1000) * 0.01, rows: Math.round((tbl?.rowCount || 1000) * (parsed.whereConditions.length > 0 ? 0.1 : 1)), children: [], index: parsed.whereConditions.length > 0 ? 'idx_' + t + '_id' : undefined }
  })
  if (tableScans.length === 1) {
    const root: QueryPlan = { operation: 'Sort', cost: tableScans[0].cost * 1.2, rows: tableScans[0].rows, children: [tableScans[0]] }
    return root
  }
  const join: QueryPlan = { operation: 'Hash Join', cost: tableScans.reduce((s, n) => s + n.cost, 0) * 1.5, rows: Math.round(tableScans[0].rows * 0.5), children: tableScans, filter: parsed.joins[0]?.condition }
  return { operation: parsed.orderBy.length ? 'Sort' : 'Result', cost: join.cost * 1.1, rows: join.rows, children: [join] }
}

// ---------- 多语句切分（引号/注释感知） ----------

export function splitStatements(raw: string): { sql: string; start: number; end: number }[] {
  const segs: { sql: string; start: number; end: number }[] = []
  let start = 0
  let i = 0
  let quote: string | null = null
  let line = false, block = false
  while (i < raw.length) {
    const ch = raw[i], next = raw[i + 1]
    if (line) { if (ch === '\n') line = false; i++; continue }
    if (block) { if (ch === '*' && next === '/') { block = false; i += 2; continue }; i++; continue }
    if (quote) {
      if (ch === '\\') { i += 2; continue }
      if (ch === quote) { if (next === quote) { i += 2; continue }; quote = null }
      i++; continue
    }
    if (ch === '-' && next === '-') { line = true; i += 2; continue }
    if (ch === '/' && next === '*') { block = true; i += 2; continue }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; i++; continue }
    if (ch === ';') { segs.push({ sql: raw.slice(start, i), start, end: i }); start = i + 1; i++; continue }
    i++
  }
  segs.push({ sql: raw.slice(start), start, end: raw.length })
  const meaningful = segs.filter(s => s.sql.trim() !== '')
  if (meaningful.length) return meaningful
  return [{ sql: raw, start: 0, end: raw.length }]
}

// ---------- 第 2 步：表与别名 ----------

/** 读取 FROM 后以逗号分隔的表清单，返回最后一个 token 的 end 之后位置 */
function readTableList(sql: string, pos: number, tables: string[], aliases: Map<string, string>): number {
  let i = pos
  while (true) {
    const ref = readTable(sql, i)
    if (!ref) break
    if (!tables.includes(ref.name)) tables.push(ref.name)
    aliases.set(ref.name, ref.name)
    if (ref.alias) aliases.set(ref.alias, ref.name)
    i = ref.after
    while (i < sql.length && /\s/.test(sql[i])) i++
    if (sql[i] === ',') { i++; while (i < sql.length && /\s/.test(sql[i])) i++; continue }
    break
  }
  return i
}

function collectTables(sql: string): { tables: string[]; aliases: Map<string, string>; scope: Map<number, string[]> } {
  const toks = tokenize(sql)
  const tables: string[] = []
  const aliases = new Map<string, string>()
  const scope = new Map<number, string[]>()
  const pushScope = (depth: number, t: string) => {
    const arr = scope.get(depth) || []
    if (!arr.includes(t)) arr.push(t)
    scope.set(depth, arr)
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.upper === 'FROM') {
      const before = tables.length
      readTableList(sql, t.end, tables, aliases)
      for (let k = before; k < tables.length; k++) pushScope(t.depth, tables[k])
    } else if (t.upper === 'JOIN' || t.upper === 'INTO' || t.upper === 'UPDATE') {
      const ref = readTable(sql, t.end)
      if (!ref) continue
      if (!tables.includes(ref.name)) tables.push(ref.name)
      aliases.set(ref.name, ref.name)
      if (ref.alias) aliases.set(ref.alias, ref.name)
      if (t.upper === 'JOIN') pushScope(t.depth, ref.name)
    }
  }
  return { tables, aliases, scope }
}

// ---------- 第 3/4 步：谓词 → 列 → 索引建议 ----------

type ResolveResult = { table: string; column: string } | { error: string }

function resolveColumn(token: string, aliases: Map<string, string>, scopeTables: string[]): ResolveResult {
  const col = token.toLowerCase()
  const parts = col.split('.')
  if (parts.length === 2) {
    const table = aliases.get(parts[0])
    if (!table) return { error: `别名/表名 "${parts[0]}" 未在 FROM/JOIN 中定义，无法确定列 ${parts[1]} 的归属` }
    const tbl = getTable(table)
    if (tbl && !tbl.columns.some(c => c.name.toLowerCase() === parts[1])) return { error: `列 "${table}.${parts[1]}" 不在当前 Schema 中` }
    return { table, column: parts[1] }
  }
  // 裸列：先在当前括号深度的 FROM/JOIN 作用域内解析
  let candidates = scopeTables.filter(t => getTable(t)?.columns.some(c => c.name.toLowerCase() === col))
  if (candidates.length === 1) return { table: candidates[0], column: col }
  if (candidates.length > 1) return { error: `列 "${col}" 未限定表名，在 ${candidates.join('、')} 中都存在，无法确定归属` }
  return { error: `列 "${col}" 在该查询作用域的表（${scopeTables.join('、') || '无'}）中不存在` }
}

interface AdviceBuilder {
  table: string
  column: string
  reasons: AdviceReason[]
  weightSum: number
}

export function analyzeStatement(seg: { sql: string; start: number; end: number }, index: number): StmtAnalysis {
  const sql = seg.sql
  const base = seg.start
  const isEmpty = sql.trim() === ''
  const parsed = parseSQL(sql)

  const steps: AnalyzeStep[] = []
  const wildcardIssues: ColumnIssue[] = []
  const incompleteIssues: ColumnIssue[] = []
  const builders = new Map<string, AdviceBuilder>()
  const notes: string[] = []
  const pushNote = (msg: string) => { if (!notes.includes(msg)) notes.push(msg) }
  const snippet = (s: number, e: number): Snippet => ({ start: base + s, end: base + e, text: sql.slice(s, e) })

  // —— 第 1 步：类型识别 ——
  if (isEmpty) {
    steps.push({ name: '语句类型识别', status: 'empty', message: '语句为空，没有任何可识别的关键字或文本' })
  } else if (parsed.type === 'UNKNOWN') {
    steps.push({ name: '语句类型识别', status: 'empty', message: '未找到 SELECT/INSERT/UPDATE/DELETE/CREATE 关键字，无法识别语句类型' })
  } else {
    steps.push({ name: '语句类型识别', status: 'ok', message: `识别为 ${parsed.type} 语句` })
  }

  // —— 第 2 步：涉及表 ——
  const { tables, aliases, scope } = isEmpty ? { tables: [] as string[], aliases: new Map<string, string>(), scope: new Map<number, string[]>() } : collectTables(sql)
  if (isEmpty) {
    steps.push({ name: '提取涉及表（FROM / JOIN / UPDATE / INTO）', status: 'skip', message: '语句为空，跳过' })
  } else if (tables.length === 0) {
    steps.push({ name: '提取涉及表（FROM / JOIN / UPDATE / INTO）', status: 'empty', message: '未匹配到 FROM/JOIN/UPDATE/INTO 之后的表名' })
  } else {
    steps.push({ name: '提取涉及表（FROM / JOIN / UPDATE / INTO）', status: 'ok', message: `涉及 ${tables.length} 张表：${tables.join('、')}（别名映射 ${aliases.size} 项）` })
  }

  const addAdvice = (r: { table: string; column: string }, kind: 'filter' | 'join', weight: number, detail: string, snip: Snippet) => {
    const tbl = getTable(r.table)
    if (tbl?.columns.some(c => c.pk && c.name.toLowerCase() === r.column)) {
      pushNote(`${r.table}.${r.column} 是主键，已有主键索引覆盖，无需重复建索引`)
      return
    }
    const key = `${r.table}::${r.column}`
    let b = builders.get(key)
    if (!b) { b = { table: r.table, column: r.column, reasons: [], weightSum: 0 }; builders.set(key, b) }
    if (!b.reasons.some(x => x.snippet.start === snip.start)) {
      b.reasons.push({ kind, detail, weight, snippet: snip })
      b.weightSum += weight
    }
  }

  let filterCount = 0
  let joinCount = 0

  const analyzeFilter = (text: string, snip: Snippet, scopeTables: string[]) => {
    const t = text.trim()
    // IN (SELECT ...) 子查询：左侧列可作为过滤索引
    const subIn = /\bIN\s*\(\s*SELECT\b/i.exec(t)
    if (subIn) {
      const left = t.slice(0, subIn.index).trim()
      const cm = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*$/.exec(left)
      if (cm) {
        filterCount++
        const r = resolveColumn(cm[1], aliases, scopeTables)
        if ('error' in r) { pushNote(`过滤片段 "${t}"：${r.error}`); return }
        addAdvice(r, 'filter', 0.7, `WHERE 半连接过滤（IN 子查询）：${t}`, snip)
      }
      return
    }
    // LIKE
    const likeM = /^([\s\S]+?)\s+LIKE\s+('([^']*)'|\S+)/i.exec(t)
    if (likeM) {
      filterCount++
      const left = likeM[1].trim()
      const literal = likeM[3]
      const wrapM = /^[A-Za-z_]\w*\s*\(\s*([\w.]+)\s*\)/.exec(left)
      const colToken = wrapM ? wrapM[1] : (/^([\w.]+)$/.exec(left) ? left : null)
      if (wrapM || !colToken) {
        wildcardIssues.push({ id: `col-${index}-w-${wildcardIssues.length}`, category: 'wildcard', table: null, detail: `LIKE 条件 "${t}" 的左侧是函数/表达式，不是裸列，索引无法生效`, suggestion: '把表达式改写为裸列比较，或使用表达式索引 / 生成列', snippet: snip })
        pushNote(`过滤片段 "${t}"：条件列被函数/表达式包裹，属于非 SARGable 谓词，普通索引无法生效`)
        return
      }
      const r = resolveColumn(colToken, aliases, scopeTables)
      if ('error' in r) { pushNote(`过滤片段 "${t}"：${r.error}`); return }
      if (literal !== undefined && literal.startsWith('%')) {
        wildcardIssues.push({ id: `col-${index}-w-${wildcardIssues.length}`, category: 'wildcard', table: r.table, detail: `LIKE 匹配值 "${literal}" 以 % 开头（前导通配符），B-Tree 索引无法用于定位`, suggestion: `改为后缀匹配（如 '${literal.slice(1).replace(/%+$/, '')}%'）或改用全文索引`, snippet: snip })
        pushNote(`过滤片段 "${t}"：前导通配符 LIKE 无法使用索引（${r.table}.${r.column}）`)
        return
      }
      addAdvice(r, 'filter', 0.3, `WHERE 后缀模糊匹配：${t}`, snip)
      return
    }
    // 函数/表达式包裹的列
    const wrapM = /^[A-Za-z_]\w*\s*\(\s*([\w.]+)\s*\)/.exec(t)
    if (wrapM) {
      filterCount++
      const inner = resolveColumn(wrapM[1], aliases, scopeTables)
      const where = 'error' in inner ? '' : `（${inner.table}.${inner.column}）`
      pushNote(`过滤片段 "${t}"：在列${where}上使用了函数/表达式，普通索引无法生效，可改写条件或建表达式索引`)
      return
    }
    // 标准谓词
    const std = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*(>=|<=|<>|!=|=|>|<|\bIS(?:\s+NOT)?\b|\bBETWEEN\b|\bIN\b)/i.exec(t)
    if (!std) {
      filterCount++
      pushNote(`过滤片段 "${t}"：无法解析为「列 比较符 值」结构，未给出索引建议`)
      return
    }
    filterCount++
    const r = resolveColumn(std[1], aliases, scopeTables)
    if ('error' in r) { pushNote(`过滤片段 "${t}"：${r.error}`); return }
    const op = std[2].toUpperCase().replace(/\s+/g, ' ')
    let weight = 0.5
    if (op === '=') weight = 1.0
    else if (op === 'IN') weight = 0.9
    else if (op === '<>' || op === '!=') weight = 0.6
    else if (op.startsWith('IS')) weight = 0.4
    else if (op === 'BETWEEN') weight = 0.5
    const label = op === '=' ? '等值过滤' : op === 'IN' ? '枚举过滤（IN 列表）' : op === 'BETWEEN' ? '范围过滤' : op.startsWith('IS') ? 'NULL 过滤' : '范围过滤'
    addAdvice(r, 'filter', weight, `WHERE ${label}：${t}`, snip)
  }

  const analyzeJoinPred = (text: string, snip: Snippet, scopeTables: string[]) => {
    const m = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*=\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)$/.exec(text.replace(/\s+/g, ' ').trim())
    if (!m) {
      pushNote(`连接条件 "${text}" 不是两列等值（col = col）形式，未给出连接索引建议`)
      return
    }
    joinCount++
    const left = resolveColumn(m[1], aliases, scopeTables)
    const right = resolveColumn(m[2], aliases, scopeTables)
    if ('error' in left) { pushNote(`连接片段 "${text}"：${left.error}`); return }
    if ('error' in right) { pushNote(`连接片段 "${text}"：${right.error}`); return }
    addAdvice(left, 'join', 0.8, `JOIN 连接键：${text}`, snip)
    addAdvice(right, 'join', 0.8, `JOIN 连接键：${text}`, snip)
  }

  if (!isEmpty && tables.length > 0) {
    const toks = tokenize(sql)
    // WHERE 块（含子查询中的 WHERE，按括号深度选择 FROM 作用域）
    for (const t of toks) {
      if (t.upper !== 'WHERE') continue
      const end = clauseEnd(sql, t.end, CLAUSE_STOP)
      const scopeTables = scope.get(t.depth) || scope.get(0) || tables
      for (const p of splitPredicates(sql.slice(t.end, end), base + t.end)) analyzeFilter(p.text, p.snippet, scopeTables)
    }
    // JOIN ... ON 块
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]
      if (t.upper !== 'JOIN') continue
      const onIdx = findOnAtDepth(toks, i + 1)
      if (onIdx < 0) continue
      const onTok = toks[onIdx]
      const end = clauseEnd(sql, onTok.end, ON_STOP)
      const scopeTables = scope.get(t.depth) || tables
      for (const p of splitPredicates(sql.slice(onTok.end, end), base + onTok.end)) analyzeJoinPred(p.text, p.snippet, scopeTables)
    }
  }

  // —— 第 3 步结论 ——
  if (isEmpty) {
    steps.push({ name: '提取过滤条件与连接条件', status: 'skip', message: '语句为空，跳过' })
  } else if (filterCount + joinCount === 0) {
    steps.push({ name: '提取过滤条件与连接条件', status: 'empty', message: '没有找到 WHERE 过滤谓词，也没有找到 JOIN ... ON 连接条件，缺少需要索引支撑的访问路径' })
  } else {
    steps.push({ name: '提取过滤条件与连接条件', status: 'ok', message: `提取到 ${filterCount} 个过滤谓词、${joinCount} 个连接列条件` })
  }

  // —— 第 4 步：组装按表归组的索引建议 ——
  const makeAdvice = (b: AdviceBuilder, seq: number): IndexAdvice => {
    const rowCount = getTable(b.table)?.rowCount ?? FALLBACK_ROWS
    const benefit = Math.round(rowCount * b.weightSum)
    const kind: IndexAdvice['kind'] = b.reasons.some(r => r.kind === 'filter') && b.reasons.some(r => r.kind === 'join') ? 'mixed' : b.reasons[0].kind
    return {
      id: `idx-${index}-${seq}`,
      table: b.table,
      column: b.column,
      ddl: `CREATE INDEX idx_${b.table}_${b.column} ON ${b.table} (${b.column});`,
      kind,
      reasons: b.reasons,
      weightSum: b.weightSum,
      benefit,
      costLabel: `代价权重 ${b.weightSum.toFixed(1)}；${b.table} 约 ${rowCount.toLocaleString()} 行，预计可减少约 ${benefit.toLocaleString()} 次行扫描`,
    }
  }
  const allAdvices = Array.from(builders.values()).map((b, i) => makeAdvice(b, i))
  const indexGroups: IndexAdviceGroup[] = tables.map(t => ({
    table: t,
    rowCount: getTable(t)?.rowCount ?? FALLBACK_ROWS,
    advices: allAdvices.filter(a => a.table === t).sort((a, b) => b.benefit - a.benefit),
  })).filter(g => g.advices.length > 0)
  // Schema 中不存在的表（无法归入已知表顺序），追加在最后
  for (const a of allAdvices) {
    if (!indexGroups.some(g => g.table === a.table)) {
      indexGroups.push({ table: a.table, rowCount: FALLBACK_ROWS, advices: allAdvices.filter(x => x.table === a.table).sort((x, y) => y.benefit - x.benefit) })
    }
  }
  indexGroups.forEach(g => g.advices.forEach((a, i) => { a.id = `idx-${index}-${g.table}-${i}` }))

  if (isEmpty) {
    steps.push({ name: '匹配列与现有索引（按表归组）', status: 'skip', message: '语句为空，跳过' })
  } else if (indexGroups.length === 0) {
    let msg: string
    if (tables.length === 0) msg = '上一步未找到涉及表，本步没有可归属的列，无法给出索引建议'
    else if (filterCount + joinCount === 0) msg = '上一步未找到过滤/连接条件，本步没有需要匹配索引的列'
    else msg = notes.length ? `所有谓词均无需新增索引：${notes.join('；')}` : '所有谓词列均已被现有索引（主键）覆盖，无需新增索引'
    steps.push({ name: '匹配列与现有索引（按表归组）', status: 'empty', message: msg })
  } else {
    const skippedPk = notes.filter(n => n.includes('主键')).length
    steps.push({
      name: '匹配列与现有索引（按表归组）',
      status: 'ok',
      message: `按表归组得到 ${allAdvices.length} 条索引建议，覆盖 ${indexGroups.length} 张表（组内按代价从高到低排序）` + (skippedPk ? `；主键列 ${skippedPk} 处已跳过` : '') + (notes.filter(n => !n.includes('主键')).length ? `；另有 ${notes.filter(n => !n.includes('主键')).length} 条片段未能形成建议，见下方说明` : ''),
    })
  }

  // —— 第 5/6 步：列粒度检查（SELECT 列表 / LIKE / INSERT） ——
  const starSeen = new Set<string>()
  const columnListOf = (table: string | null): string => {
    const tbl = table ? getTable(table) : undefined
    return tbl ? tbl.columns.map(c => c.name).join(', ') : '（Schema 中未找到该表，请按实际需要显式列出列名）'
  }
  const addStarIssues = (itemText: string, s: number, e: number) => {
    const qm = /^([A-Za-z_]\w*)\.\*$/.exec(itemText.trim())
    let targets: (string | null)[]
    if (qm) {
      const resolved = aliases.get(qm[1].toLowerCase())
      targets = [resolved ?? null]
    } else {
      targets = tables.length ? [...tables] : [null]
    }
    for (const table of targets) {
      const snip = snippet(s, e)
      const wk = `w-${table}-${s}`
      const ik = `i-${table}-${s}`
      const label = table ?? (qm ? qm[1] : '未知表')
      if (!starSeen.has(wk)) {
        starSeen.add(wk)
        wildcardIssues.push({
          id: `col-${index}-w-${wildcardIssues.length}`,
          category: 'wildcard',
          table,
          detail: `SELECT 列表中的 "${itemText.trim()}" 仍在使用通配符，会取出 ${label} 的全部列，放大 IO 并使覆盖索引失效`,
          suggestion: table ? `改为显式列出需要的列，例如：${columnListOf(table)}` : '改为显式列出需要的列',
          snippet: snip,
        })
      }
      if (!starSeen.has(ik)) {
        starSeen.add(ik)
        incompleteIssues.push({
          id: `col-${index}-i-${incompleteIssues.length}`,
          category: 'incomplete',
          table,
          detail: `SELECT 列表中的 "${itemText.trim()}" 没有把列名写全，${label} 的列清单不明确`,
          suggestion: `应展开为完整列名单：${columnListOf(table)}`,
          snippet: snip,
        })
      }
    }
  }

  if (!isEmpty) {
    const toks = tokenize(sql)
    // SELECT 列表扫描（逗号/括号深度感知，* 只在深度 0 时才算通配符）
    for (const tk of toks) {
      if (tk.upper !== 'SELECT') continue
      let i = tk.end
      while (i < sql.length && /\s/.test(sql[i])) i++
      if (/^DISTINCT\s+/i.test(sql.slice(i))) i += RegExp.lastMatch!.length
      let depth = 0
      let itemStart = i
      let fromPos = -1
      for (; i < sql.length; i++) {
        const ch = sql[i]
        if (ch === "'" || ch === '"' || ch === '`') { i = skipQuoted(sql, i) - 1; continue }
        if (ch === '(') depth++
        else if (ch === ')') depth--
        else if (depth === 0) {
          const wm = /^FROM\b/i.exec(sql.slice(i))
          if (wm) { fromPos = i; break }
          if (ch === ',') {
            scanSelectItem(sql.slice(itemStart, i), itemStart, addStarIssues)
            itemStart = i + 1
          }
        }
      }
      if (fromPos >= 0) scanSelectItem(sql.slice(itemStart, fromPos), itemStart, addStarIssues)
    }
    // INSERT 未带列清单
    const insM = /INSERT\s+INTO\s+[`"\[]?([A-Za-z_]\w*)[`"\]]?\s*VALUES\b/i.exec(sql)
    if (insM) {
      const s = insM.index, e = s + insM[0].length
      incompleteIssues.push({
        id: `col-${index}-i-${incompleteIssues.length}`,
        category: 'incomplete',
        table: insM[1].toLowerCase(),
        detail: `INSERT INTO ${insM[1]} 后直接跟 VALUES，没有写出列名清单，表结构变动时容易错位`,
        suggestion: `改为 INSERT INTO ${insM[1]} (${columnListOf(insM[1].toLowerCase())}) VALUES (...)`,
        snippet: snippet(s, e),
      })
    }
  }

  if (isEmpty) {
    steps.push({ name: '通配符写法检查（SELECT * / 表名.* / 前导通配符 LIKE）', status: 'skip', message: '语句为空，跳过' })
    steps.push({ name: '列名完整性检查（SELECT 列表 / INSERT 列表）', status: 'skip', message: '语句为空，跳过' })
  } else {
    steps.push(wildcardIssues.length
      ? { name: '通配符写法检查（SELECT * / 表名.* / 前导通配符 LIKE）', status: 'ok', message: `发现 ${wildcardIssues.length} 处通配符写法` }
      : { name: '通配符写法检查（SELECT * / 表名.* / 前导通配符 LIKE）', status: 'empty', message: '未发现 SELECT *、表名.* 或前导通配符 LIKE 等写法' })
    if (parsed.type === 'SELECT' || parsed.type === 'INSERT' || wildcardIssues.length || incompleteIssues.length) {
      steps.push(incompleteIssues.length
        ? { name: '列名完整性检查（SELECT 列表 / INSERT 列表）', status: 'ok', message: `发现 ${incompleteIssues.length} 处列名未写全` }
        : { name: '列名完整性检查（SELECT 列表 / INSERT 列表）', status: 'empty', message: 'SELECT 列表与 INSERT 均已显式写出列名，未发现遗漏' })
    } else {
      steps.push({ name: '列名完整性检查（SELECT 列表 / INSERT 列表）', status: 'skip', message: `${parsed.type} 语句不包含 SELECT 列清单或 INSERT 列表，无需检查` })
    }
  }

  return {
    index,
    start: seg.start,
    end: seg.end,
    sql,
    isEmpty,
    parsed,
    indexGroups,
    indexAdvices: allAdvices,
    wildcardIssues,
    incompleteIssues,
    steps,
  }
}

/** 检查单个 SELECT 列表项中是否在括号深度 0 使用了 * */
function scanSelectItem(text: string, absStart: number, cb: (text: string, s: number, e: number) => void) {
  let depth = 0
  let star = -1
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') { i = skipQuoted(text, i); continue }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === '*' && depth === 0) { star = i; break }
    i++
  }
  if (star < 0) return
  const ls = text.match(/^\s*/)![0].length
  const re = text.match(/\s*$/)!
  cb(text, absStart + ls, absStart + (re.index ?? text.length))
}

// ---------- 模板与 Schema ----------

export const SQL_TEMPLATES = [
  { name: '基础查询', sql: `SELECT id, username, email
FROM users
WHERE status = 'active'
LIMIT 100;` },
  { name: '多表JOIN', sql: `SELECT u.username, o.id AS order_id, p.name AS product, o.amount
FROM users u
INNER JOIN orders o ON u.id = o.user_id
INNER JOIN products p ON o.product_id = p.id
WHERE o.status = 'completed'
ORDER BY o.created_at DESC
LIMIT 50;` },
  { name: '聚合分析', sql: `SELECT c.name AS category, COUNT(o.id) AS order_count, SUM(o.amount) AS revenue, AVG(o.amount) AS avg_amount
FROM categories c
LEFT JOIN products p ON c.id = p.category_id
LEFT JOIN orders o ON p.id = o.product_id
GROUP BY c.id, c.name
HAVING COUNT(o.id) > 10
ORDER BY revenue DESC;` },
  { name: '子查询', sql: `SELECT username, email
FROM users
WHERE id IN (
  SELECT DISTINCT user_id
  FROM orders
  WHERE amount > 1000
  AND created_at >= '2024-01-01'
)
ORDER BY username;` },
  { name: '全表扫描', sql: `SELECT *
FROM orders
WHERE YEAR(created_at) = 2024;` },
  { name: '多语句连续分析', sql: `SELECT *
FROM orders
WHERE status = 'pending';

SELECT u.username, o.amount
FROM users u
INNER JOIN orders o ON u.id = o.user_id
WHERE o.created_at >= '2024-06-01'
  AND u.username LIKE '%tom%';

SELECT id, name FROM products WHERE price > 100;` },
]

export const SCHEMA_TABLES = SCHEMA

// ---------- Store ----------

interface FragmentSelection { id: string; start: number; end: number; stmt: number }

export const useSQLStore = defineStore('sql', () => {
  const sql = ref(SQL_TEMPLATES[0].sql)
  const results = ref<StmtAnalysis[]>([])
  const activeStmt = ref(0)
  const activeFragment = ref<FragmentSelection | null>(null)
  const activeSchema = ref<SQLTable | null>(null)

  function analyze() {
    const segs = splitStatements(sql.value)
    results.value = segs.map((s, i) => analyzeStatement(s, i))
    activeStmt.value = Math.min(activeStmt.value, results.value.length - 1)
    activeFragment.value = null
  }

  function setActiveStmt(i: number) {
    activeStmt.value = i
    activeFragment.value = null
  }

  function locate(stmt: number, snip: Snippet, id: string) {
    activeStmt.value = stmt
    activeFragment.value = { id, start: snip.start, end: snip.end, stmt }
  }

  const active = computed<StmtAnalysis | null>(() => results.value[activeStmt.value] ?? results.value[0] ?? null)
  const parsed = computed<ParsedQuery | null>(() => active.value?.parsed ?? null)
  const plan = computed<QueryPlan | null>(() => (active.value ? buildPlan(active.value.parsed) : null))

  const complexityLabel = computed(() => {
    const c = parsed.value?.complexity || 0
    if (c <= 2) return { label: '简单', color: 'text-green-400' }
    if (c <= 5) return { label: '中等', color: 'text-yellow-400' }
    if (c <= 8) return { label: '复杂', color: 'text-orange-400' }
    return { label: '非常复杂', color: 'text-red-400' }
  })

  return { sql, results, activeStmt, activeFragment, activeSchema, active, parsed, plan, complexityLabel, analyze, setActiveStmt, locate }
})
