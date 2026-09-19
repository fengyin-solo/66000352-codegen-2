import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface Range { start: number; end: number }

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

export interface Tok { text: string; range: Range; depth?: number }

export interface TableRef {
  name: string
  alias?: string
  range: Range
  clause: 'FROM' | 'JOIN' | 'UPDATE'
  depth: number
}

export interface JoinRef {
  type: string
  table: string
  alias?: string
  condition: string
  range: Range
  condRange: Range
  depth: number
}

export interface CondRef {
  text: string
  range: Range
  kind: 'where' | 'join'
  joinType?: string
  depth: number
}

export interface ParsedQuery {
  type: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE' | 'UNKNOWN'
  tables: string[]
  columns: string[]
  joins: JoinRef[]
  whereConditions: string[]
  orderBy: string[]
  groupBy: string[]
  limit?: number
  complexity: number
  suggestions: string[]
  estimatedCost: number
  // 带源码位置的结构化信息
  tableRefs: TableRef[]
  whereRefs: CondRef[]
  joinCondRefs: CondRef[]
  selectItems: (Tok & { clause: string })[]
  orderItems: Tok[]
  groupItems: Tok[]
}

/** 索引粒度建议 */
export interface IndexAdvice {
  id: number
  table: string
  kind: 'single' | 'composite' | 'rewrite'
  reason: 'filter' | 'join' | 'mixed' | 'expression'
  columns: string[]
  ddl: string
  rationale: string
  cost: number
  fragments: { range: Range; label: string }[]
}

/** 列粒度问题（通配符写法 / 未写全的列名） */
export interface ColumnIssue {
  id: number
  type: 'select-star' | 'leading-wildcard-like' | 'unqualified-column'
  title: string
  message: string
  clause: string
  range: Range
}

export type StepStatus = 'ok' | 'warn' | 'skip' | 'info'
export interface AnalysisStep { title: string; status: StepStatus; detail: string }

export interface AnalysisRecord {
  id: number
  sql: string
  label: string
  parsed: ParsedQuery
  plan: QueryPlan
  indexAdvice: IndexAdvice[]
  columnIssues: ColumnIssue[]
  steps: AnalysisStep[]
  indexEmptyReason: string
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

const STOPWORDS = new Set([
  'select','from','where','and','or','not','null','is','in','like','between','join','inner',
  'left','right','full','outer','cross','on','group','by','order','having','limit','distinct',
  'as','asc','desc','count','sum','avg','min','max','coalesce','year','month','date','day',
  'case','when','then','else','end','true','false','union','all','insert','into','values',
  'update','set','delete','create','table','if','exists','cast','char','int','varchar','or',
])

/* ------------------------------ 基础扫描工具 ------------------------------ */

function isWord(ch: string | undefined) {
  return !!ch && /[A-Za-z0-9_$]/.test(ch)
}

/** 跳过引号字符串，返回结束位置 */
function skipQuoted(sql: string, i: number): number {
  const q = sql[i]
  if (q === "'") {
    i++
    while (i < sql.length) {
      if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue }
      if (sql[i] === "'") return i + 1
      i++
    }
    return i
  }
  if (q === '"' || q === '`') {
    i++
    while (i < sql.length && sql[i] !== q) i++
    return Math.min(i + 1, sql.length)
  }
  return i
}

interface ClauseMark { kw: string; start: number; end: number; depth: number }

const CLAUSE_RE = /^(SELECT|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|UNION(?:\s+ALL)?)\b/i
const JOIN_RE = /^(?:(INNER|LEFT(?:\s+OUTER)?|RIGHT(?:\s+OUTER)?|FULL(?:\s+OUTER)?|CROSS)\s+)?JOIN\b/i

/** 找出所有子句关键字位置（JOIN 在 depth 0，其余任意深度，SELECT 用于列名单扫描） */
function findClauses(sql: string): ClauseMark[] {
  const out: ClauseMark[] = []
  let depth = 0
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'" || ch === '"' || ch === '`') { i = skipQuoted(sql, i) - 1; continue }
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue }
    if (isWord(sql[i - 1])) continue
    const slice = sql.slice(i)
    const mc = CLAUSE_RE.exec(slice)
    if (mc) {
      out.push({ kw: mc[1].toUpperCase().replace(/\s+/g, ' '), start: i, end: i + mc[0].length, depth })
      i += mc[0].length - 1
      continue
    }
    const mj = JOIN_RE.exec(slice)
    if (mj) {
      out.push({ kw: 'JOIN', start: i, end: i + mj[0].length, depth })
      i += mj[0].length - 1
    }
  }
  return out
}

/** 按顶层逗号切分 */
function splitTopLevel(body: string, base: number, depth = 0): Tok[] {
  const parts: Tok[] = []
  let d = 0, start = 0
  const emit = (segStart: number, segEnd: number) => {
    const raw = body.slice(segStart, segEnd)
    const lead = raw.search(/\S/)
    if (lead < 0) return
    const abs = base + segStart + lead
    parts.push({ text: raw.trim(), range: { start: abs, end: abs + raw.trim().length }, depth })
  }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === "'" || ch === '"' || ch === '`') { i = skipQuoted(body, i) - 1; continue }
    if (ch === '(') d++
    else if (ch === ')') d = Math.max(0, d - 1)
    else if (ch === ',' && d === 0) {
      emit(start, i)
      start = i + 1
    }
  }
  emit(start, body.length)
  return parts
}

/** 按顶层 AND/OR 切分谓词 */
function splitPredicates(body: string, base: number, depth = 0): CondRef[] {
  const out: CondRef[] = []
  let d = 0, start = 0
  const push = (end: number) => {
    const raw = body.slice(start, end)
    const lead = raw.search(/\S/)
    if (lead >= 0) {
      out.push({
        text: raw.trim(),
        range: { start: base + start + lead, end: base + start + lead + raw.trim().length },
        kind: 'where', depth,
      })
    }
  }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === "'" || ch === '"' || ch === '`') { i = skipQuoted(body, i) - 1; continue }
    if (ch === '(') d++
    else if (ch === ')') d = Math.max(0, d - 1)
    else if (d === 0 && !isWord(body[i - 1])) {
      const m = /^(AND|OR)\b/i.exec(body.slice(i))
      if (m) { push(i); start = i + m[0].length; i += m[0].length - 1 }
    }
  }
  push(body.length)
  return out
}

/* ------------------------------ SQL 解析 ------------------------------ */

const GENERIC_TYPE = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE']

function parseSQL(sql: string): ParsedQuery {
  const empty: ParsedQuery = {
    type: 'UNKNOWN', tables: [], columns: [], joins: [], whereConditions: [], orderBy: [],
    groupBy: [], complexity: 0, suggestions: [], estimatedCost: 0,
    tableRefs: [], whereRefs: [], joinCondRefs: [], selectItems: [], orderItems: [], groupItems: [],
  }
  const trimmed = sql.trim()
  if (!trimmed) return empty

  const up = trimmed.toUpperCase()
  const type = (GENERIC_TYPE.find(t => up.startsWith(t)) || 'UNKNOWN') as ParsedQuery['type']
  const clauses = findClauses(sql)
  const top = clauses.filter(c => c.depth === 0)
  const after = (kw: string, from?: number) => top.find(c => c.kw === kw && (from === undefined || c.start > from))

  // ---- 表与别名（FROM / JOIN / UPDATE）----
  const tableRefs: TableRef[] = []
  const aliasOk = (word: string) => !STOPWORDS.has(word.toLowerCase()) &&
    !/^(WHERE|GROUP|ORDER|HAVING|LIMIT|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|OUTER|ON|UNION|SET|VALUES)$/i.test(word)

  for (const f of clauses.filter(c => c.kw === 'FROM')) {
    const m = /^\s*FROM\s+([a-zA-Z_]\w*)(?:\s+(?:AS\s+)?([a-zA-Z_]\w*))?/i.exec(sql.slice(f.start))
    if (m) {
      const nameStart = f.start + m[0].indexOf(m[1])
      tableRefs.push({
        name: m[1].toLowerCase(),
        alias: m[2] && aliasOk(m[2]) ? m[2].toLowerCase() : undefined,
        range: { start: nameStart, end: nameStart + m[1].length },
        clause: 'FROM', depth: f.depth,
      })
    }
  }
  const joins: JoinRef[] = []
  const joinCondRefs: CondRef[] = []
  for (const j of clauses.filter(c => c.kw === 'JOIN')) {
    const head = /^(?:(INNER|LEFT(?:\s+OUTER)?|RIGHT(?:\s+OUTER)?|FULL(?:\s+OUTER)?|CROSS)\s+)?JOIN\s+([a-zA-Z_]\w*)(?:\s+(?:AS\s+)?([a-zA-Z_]\w*))?\s+ON\b/i.exec(sql.slice(j.start))
    if (!head) continue
    const joinType = (head[1] || 'INNER').toUpperCase().replace('OUTER', '').trim() || 'INNER'
    const tname = head[2].toLowerCase()
    const nameStart = j.start + head[0].indexOf(head[2])
    const alias = head[3] && aliasOk(head[3]) ? head[3].toLowerCase() : undefined
    const onEnd = j.start + head[0].length
    // 按括号深度扫描 ON 体的结束位置（不能越过本层的后续子句或右括号）
    let bodyEnd = sql.length, d = j.depth
    for (let i = onEnd; i < sql.length; i++) {
      const ch = sql[i]
      if (ch === "'" || ch === '"' || ch === '`') { i = skipQuoted(sql, i) - 1; continue }
      if (ch === '(') { d++; continue }
      if (ch === ')') { d--; if (d < j.depth) { bodyEnd = i; break }; continue }
      if (d === j.depth && (!isWord(sql[i - 1])) &&
        /^(WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|UNION|INNER\s+JOIN|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|FULL\s+(?:OUTER\s+)?JOIN|CROSS\s+JOIN|JOIN)\b/i.test(sql.slice(i))) {
        bodyEnd = i
        break
      }
      if (d === j.depth && sql[i] === ';') { bodyEnd = i; break }
    }
    const condText = sql.slice(onEnd, bodyEnd).trim().replace(/;+$/, '').trim()
    const condStart = onEnd + sql.slice(onEnd, bodyEnd).indexOf(condText)
    const condRange = { start: condStart, end: condStart + condText.length }
    tableRefs.push({ name: tname, alias, range: { start: nameStart, end: nameStart + head[2].length }, clause: 'JOIN', depth: j.depth })
    joins.push({ type: joinType, table: tname, alias, condition: condText, range: { start: nameStart, end: nameStart + head[2].length }, condRange, depth: j.depth })
    joinCondRefs.push({ text: condText, range: condRange, kind: 'join', joinType, depth: j.depth })
  }
  const upd = /^\s*UPDATE\s+([a-zA-Z_]\w*)(?:\s+AS\s+([a-zA-Z_]\w*))?/i.exec(sql)
  if (type === 'UPDATE' && upd) {
    const nameStart = upd[0].indexOf(upd[1])
    tableRefs.push({ name: upd[1].toLowerCase(), alias: upd[2] ? upd[2].toLowerCase() : undefined, range: { start: nameStart, end: nameStart + upd[1].length }, clause: 'UPDATE', depth: 0 })
  }
  // 旧逻辑兼容：INSERT INTO / 兜底正则
  if (!tableRefs.length) {
    for (const m of sql.matchAll(/(?:INTO)\s+([a-zA-Z_]\w*)/gi)) {
      tableRefs.push({ name: m[1].toLowerCase(), range: { start: (m.index ?? 0) + m[0].indexOf(m[1]), end: (m.index ?? 0) + m[0].length }, clause: 'FROM', depth: 0 })
    }
  }
  const tables = Array.from(new Set(tableRefs.map(t => t.name)))

  // ---- SELECT 列表（所有层级，供列粒度检查）----
  const selectItems: (Tok & { clause: string })[] = []
  for (const sm of sql.matchAll(/\bSELECT\s+(?:DISTINCT\s+)?([\s\S]*?)\s+FROM\b/gi)) {
    const base = (sm.index ?? 0) + sm[0].indexOf(sm[1])
    const mark = clauses.find(c => c.kw === 'SELECT' && c.start === sm.index)
    for (const it of splitTopLevel(sm[1], base, mark?.depth ?? 0)) {
      selectItems.push({ ...it, clause: (mark?.depth ?? 0) === 0 ? 'SELECT' : '子查询 SELECT' })
    }
  }

  // ---- WHERE（各层级子查询的 WHERE 都解析，按括号深度界定结束位置）----
  const whereRefs: CondRef[] = []
  for (const wClause of clauses.filter(c => c.kw === 'WHERE')) {
    let bodyEnd = sql.length, d = wClause.depth
    for (let i = wClause.end; i < sql.length; i++) {
      const ch = sql[i]
      if (ch === "'" || ch === '"' || ch === '`') { i = skipQuoted(sql, i) - 1; continue }
      if (ch === '(') { d++; continue }
      if (ch === ')') { d--; if (d < wClause.depth) { bodyEnd = i; break }; continue }
      if (d === wClause.depth && !isWord(sql[i - 1]) &&
        /^(GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|UNION)\b/i.test(sql.slice(i))) {
        bodyEnd = i
        break
      }
      if (d === wClause.depth && sql[i] === ';') { bodyEnd = i; break }
    }
    const body = sql.slice(wClause.end, bodyEnd)
    for (const p of splitPredicates(body, wClause.end, wClause.depth)) whereRefs.push({ ...p, kind: 'where' })
  }

  // ---- 顶层 ORDER BY / GROUP BY / LIMIT ----
  const listAfter = (kw: string): Tok[] => {
    const c = after(kw)
    if (!c) return []
    const end = top.filter(x => x.start > c.start && ['GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'UNION'].includes(x.kw))
      .sort((a, b) => a.start - b.start)[0]
    return splitTopLevel(sql.slice(c.end, end ? end.start : sql.length), c.end, 0)
  }
  const orderItems = listAfter('ORDER BY')
  const groupItems = listAfter('GROUP BY')
  const limitMatch = sql.match(/LIMIT\s+(\d+)/i)
  const limit = limitMatch ? parseInt(limitMatch[1]) : undefined

  const whereConditions = whereRefs.map(w => w.text)
  const orderBy = orderItems.map(o => o.text)
  const groupBy = groupItems.map(g => g.text)
  const columns = selectItems.filter(s => s.clause === 'SELECT').map(s => s.text)

  const complexity = tables.length + joins.length * 2 + whereConditions.length + orderBy.length +
    (sql.includes('DISTINCT') ? 3 : 0) + (sql.toUpperCase().includes('HAVING') ? 2 : 0)
  const estimatedCost = tables.reduce((sum, t) => {
    const tbl = SCHEMA.find(s => s.name === t)
    return sum + (tbl?.rowCount || 1000)
  }, 0) * (joins.length + 1) / (limit || 100)

  const suggestions: string[] = []
  if (joins.length > 3) suggestions.push('连接表过多（>3），考虑分解查询')
  if (!whereConditions.length && type === 'SELECT') suggestions.push('无 WHERE 条件，将扫描全表')
  if (sql.toUpperCase().includes('SELECT *') || /\bJOIN\s+\w+\s+\w+\s*,/i.test(sql)) {
    if (selectItems.some(s => s.text === '*' || /^\w+\.\*$/.test(s.text))) suggestions.push('避免 SELECT *，明确指定列名')
  }
  if (/LIKE\s+'%/i.test(sql)) suggestions.push("前缀通配符 LIKE '%...' 无法使用索引")
  if (!limit && type === 'SELECT') suggestions.push('建议添加 LIMIT 限制结果集大小')

  return {
    type, tables, columns, joins, whereConditions, orderBy, groupBy, limit,
    complexity, suggestions, estimatedCost: Math.round(estimatedCost),
    tableRefs, whereRefs, joinCondRefs, selectItems, orderItems, groupItems,
  }
}

function buildPlan(parsed: ParsedQuery): QueryPlan {
  if (parsed.tables.length === 0) return { operation: 'EMPTY', cost: 0, rows: 0, children: [] }
  const tableScans: QueryPlan[] = parsed.tables.map(t => {
    const tbl = SCHEMA.find(s => s.name === t)
    return {
      operation: parsed.whereConditions.length > 0 ? 'Index Scan' : 'Seq Scan', table: t,
      cost: (tbl?.rowCount || 1000) * 0.01,
      rows: Math.round((tbl?.rowCount || 1000) * (parsed.whereConditions.length > 0 ? 0.1 : 1)),
      children: [],
      index: parsed.whereConditions.length > 0 ? 'idx_' + t + '_id' : undefined,
    }
  })
  if (tableScans.length === 1) {
    return { operation: 'Sort', cost: tableScans[0].cost * 1.2, rows: tableScans[0].rows, children: [tableScans[0]] }
  }
  const join: QueryPlan = {
    operation: 'Hash Join', cost: tableScans.reduce((s, n) => s + n.cost, 0) * 1.5,
    rows: Math.round(tableScans[0].rows * 0.5), children: tableScans,
    filter: parsed.joins[0]?.condition,
  }
  return { operation: parsed.orderBy.length ? 'Sort' : 'Result', cost: join.cost * 1.1, rows: join.rows, children: [join] }
}

/* ------------------------ 索引与列粒度分析引擎 ------------------------ */

interface ResolvedCol {
  table: string
  col: string
  qualified: boolean
  range: Range
  wrapped: boolean
  wrapFunc?: string
  leadingWild: boolean
  op: string
}

interface FilterCand {
  table: string; col: string; weight: number; range: Range; nonSargable?: 'wrap' | 'wildcard'; func?: string
}
interface JoinCand { table: string; col: string; range: Range }

export function analyzeInsights(sql: string, p: ParsedQuery) {
  const indexAdvice: IndexAdvice[] = []
  const columnIssues: ColumnIssue[] = []
  const steps: AnalysisStep[] = []
  let issueId = 0, adviceId = 0
  let indexEmptyReason = ''

  const involved = p.tables.map(t => SCHEMA.find(s => s.name === t)).filter((x): x is SQLTable => !!x)
  const schemaOf = (name: string) => SCHEMA.find(s => s.name === name)
  // 同一嵌套层级可见的表：本层 + 外层（depth 更小）
  const scopeTables = (depth: number) => p.tableRefs.filter(t => t.depth <= depth)
  const aliasMapAt = (depth: number) => {
    const m = new Map<string, string>()
    for (const t of scopeTables(depth)) {
      m.set(t.name, t.name)
      if (t.alias) m.set(t.alias, t.name)
    }
    return m
  }
  const isPk = (table: string, col: string) => !!schemaOf(table)?.columns.find(c => c.name === col)?.pk

  // ---- 步骤 1：语句类型 ----
  if (!sql.trim()) {
    steps.push({ title: '1. 读取语句', status: 'warn', detail: '编辑器内容为空：没有可分析的 SQL，未产生任何建议，请先输入语句或从模板中选择。' })
    return { indexAdvice, columnIssues, steps, indexEmptyReason: '语句为空，未进入解析步骤。' }
  }
  steps.push({ title: '1. 识别语句类型', status: 'ok', detail: `识别为 ${p.type} 语句${p.limit ? `，LIMIT ${p.limit}` : ''}。` })

  // ---- 步骤 2：表与别名 ----
  if (!p.tableRefs.length) {
    steps.push({ title: '2. 解析表与别名', status: 'warn', detail: '未在语句中找到 FROM / JOIN / UPDATE 后的表名，无法确定涉及的表，后续索引与列名分析全部跳过。' })
    steps.push({ title: '3~7. 后续检查', status: 'skip', detail: '因上一步未定位到表而跳过（无过滤条件、连接条件、列名可检查）。' })
    return { indexAdvice, columnIssues, steps, indexEmptyReason: '第 2 步「解析表与别名」未找到任何表，索引建议没有依据。' }
  }
  steps.push({
    title: '2. 解析表与别名', status: 'ok',
    detail: p.tableRefs.map(t => `${t.clause} ${t.name}${t.alias ? `（别名 ${t.alias}）` : ''} · ${schemaOf(t.name)?.rowCount.toLocaleString() ?? '未知'} 行`).join('；'),
  })

  /** 从一个谓词文本中解析出可定位到表的列（按谓词所在嵌套层级确定可见表） */
  function resolveCols(cond: CondRef): ResolvedCol[] {
    const text = cond.text
    const base = cond.range.start
    const depth = cond.depth
    const sameDepthRefs = scopeTables(depth).filter(t => t.depth === depth)
    const scopeRefs = scopeTables(depth)
    const aliasMap = aliasMapAt(depth)
    // 谓词中嵌套的子查询区间（IN (SELECT ...) / EXISTS (SELECT ...)），其中的列不属于本谓词作用域
    const excluded: { start: number; end: number }[] = []
    {
      let pd = 0, pstart = -1
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (ch === "'" || ch === '"' || ch === '`') { i = skipQuoted(text, i) - 1; continue }
        if (ch === '(') { if (pd === 0) pstart = i; pd++ }
        else if (ch === ')') {
          pd--
          if (pd === 0 && pstart >= 0) {
            if (/\bSELECT\b/i.test(text.slice(pstart + 1, i))) excluded.push({ start: pstart, end: i + 1 })
            pstart = -1
          }
        }
      }
    }
    const qualRanges: Range[] = []
    const cols: ResolvedCol[] = []
    for (const m of text.matchAll(/\b[a-zA-Z_]\w*\s*\.\s*[a-zA-Z_]\w*\b/g)) {
      const s = base + m.index!
      qualRanges.push({ start: s, end: s + m[0].length })
    }
    const inQual = (s: number, e: number) => qualRanges.some(r => s >= r.start && e <= r.end)
    const inExcluded = (local: number) => excluded.some(r => local >= r.start && local < r.end)
    const seen = new Set<string>()
    for (const m of text.matchAll(/\b(?:([a-zA-Z_]\w*)\s*\.\s*)?([a-zA-Z_]\w*)\b/g)) {
      const s = base + m.index!
      const e = s + m[0].length
      if (inExcluded(m.index!)) continue
      if (seen.has(`${s}:${e}`)) continue
      seen.add(`${s}:${e}`)
      const qual = m[1]?.toLowerCase()
      const name = m[2]
      const lname = name.toLowerCase()
      if (STOPWORDS.has(lname)) continue
      if (text[e - base] === '(') continue
      let table: string | undefined
      let qualified = false
      if (qual) {
        table = aliasMap.get(qual)
        if (!table) continue
        if (!schemaOf(table)!.columns.some(c => c.name === lname)) continue
        qualified = true
      } else {
        if (inQual(s, e)) continue
        // 裸列优先按同层级表解析；同层级只有一张表即可确定归属
        const sameOwners = sameDepthRefs.filter(t => schemaOf(t.name)?.columns.some(c => c.name === lname))
        if (sameOwners.length === 1) table = sameOwners[0].name
        else if (sameOwners.length > 1) continue // 同层多表且未限定，交给列名检查
        else {
          // 同层没有，可能是关联到外层表的列；外层唯一可解析时才采纳
          const outerOwners = scopeRefs.filter(t => t.depth < depth && schemaOf(t.name)?.columns.some(c => c.name === lname))
          const uniq = Array.from(new Set(outerOwners.map(t => t.name)))
          if (uniq.length === 1) table = uniq[0]
          else continue
        }
      }
      const prefix = text.slice(0, m.index!)
      const wm = /([A-Za-z_]\w*)\s*\(\s*$/.exec(prefix)
      const rest = text.slice(m.index! + m[0].length)
      const opm = /^\s*(>=|<=|<>|!=|=|>|<|\bIS\b|\bIN\b|\bBETWEEN\b|\bLIKE\b)/i.exec(rest)
      let leadingWild = false
      if (opm && opm[1].toUpperCase().startsWith('LIKE')) {
        const pm = /^\s*LIKE\s+'((?:[^']|'')*)'/i.exec(rest)
        leadingWild = !!pm && (pm[1].startsWith('%') || pm[1].startsWith('_'))
      }
      cols.push({
        table: table!, col: lname, qualified, range: { start: s, end: e },
        wrapped: !!wm, wrapFunc: wm?.[1].toUpperCase(), leadingWild,
        op: opm ? opm[1].toUpperCase().replace(/\s+/g, '') : '',
      })
    }
    return cols
  }

  // ---- 步骤 3：连接条件 ----
  const joinCands: JoinCand[] = []
  const joinSeen = new Set<string>()
  for (const cond of p.joinCondRefs) {
    const cols = resolveCols(cond)
    const pair = cols.length === 2 && !cols[0].wrapped && !cols[1].wrapped &&
      cols[0].op === '=' && cols[0].table !== cols[1].table
    if (pair) {
      for (const c of cols) {
        steps.push({
          title: '3. 解析连接条件', status: 'ok',
          detail: `${cond.joinType} JOIN 条件「${cond.text}」：${c.table}.${c.col} 参与等值连接${isPk(c.table, c.col) ? '，该列已是主键无需再建索引' : '，连接侧需要索引支撑'}。`,
        })
        if (!isPk(c.table, c.col)) {
          const key = `${c.table}.${c.col}`
          if (!joinSeen.has(key)) { joinSeen.add(key); joinCands.push({ table: c.table, col: c.col, range: c.range }) }
        }
      }
    } else {
      steps.push({
        title: '3. 解析连接条件', status: 'warn',
        detail: `${cond.joinType} JOIN 的 ON 条件「${cond.text}」未能解析成两张表之间的等值列比较，本步没有找到连接索引依据。`,
      })
    }
  }
  if (!p.joinCondRefs.length) steps.push({ title: '3. 解析连接条件', status: 'skip', detail: '语句中没有 JOIN，未产生连接类索引建议。' })

  // ---- 步骤 4：过滤条件 ----
  const filterCands: FilterCand[] = []
  const fSeen = new Set<string>()
  const coveredPk = new Set<string>()
  let unresolvedPredicates = 0
  for (const cond of p.whereRefs) {
    const cols = resolveCols(cond)
    if (!cols.length) {
      unresolvedPredicates++
      steps.push({ title: '4. 解析过滤条件', status: 'warn', detail: `WHERE 谓词「${cond.text}」中的列未能定位到涉及的表（多表查询时列名未限定表名，或谓词位于子查询中），本步无法为其匹配索引。` })
      continue
    }
    const isJoinPair = cols.length === 2 && cols[0].op === '=' && cols[0].table !== cols[1].table
    for (const c of cols) {
      if (isJoinPair) continue
      const nonSargable = c.wrapped ? 'wrap' : c.leadingWild ? 'wildcard' : undefined
      const weight = ['=', 'IN', 'IS'].includes(c.op) ? 10 : 6
      steps.push({
        title: '4. 解析过滤条件', status: nonSargable ? 'warn' : 'ok',
        detail: `谓词「${cond.text}」命中 ${c.table}.${c.col}（${c.op || '无比较运算符'}）` +
          (nonSargable === 'wrap' ? `，但列被 ${c.wrapFunc}() 包裹，普通索引无法生效`
            : nonSargable === 'wildcard' ? '，LIKE 以前导通配符开头，无法走普通索引'
              : isPk(c.table, c.col) ? '，该列已是主键，现有索引可直接覆盖' : '，缺少索引时会造成大范围扫描'),
      })
      if (isPk(c.table, c.col)) { coveredPk.add(`${c.table}.${c.col}`); continue }
      const key = `${c.table}.${c.col}:${nonSargable || ''}`
      if (fSeen.has(key)) continue
      fSeen.add(key)
      filterCands.push({ table: c.table, col: c.col, weight, range: c.range, nonSargable, func: c.wrapFunc })
    }
  }
  if (!p.whereRefs.length) steps.push({ title: '4. 解析过滤条件', status: 'skip', detail: '语句中没有 WHERE 子句，未产生过滤类索引建议。' })

  // ---- 步骤 5：与现有索引比对（本 Schema 仅主键自带索引）----
  for (const key of joinSeen) if (isPk(key.split('.')[0], key.split('.')[1])) coveredPk.add(key)
  steps.push({
    title: '5. 比对现有索引', status: 'ok',
    detail: `当前 Schema 只有各表主键自带索引${coveredPk.size ? `；跳过已被主键覆盖的 ${[...coveredPk].join('、')}` : '；本次谓词没有命中主键列'}。`,
  })

  const usableFilters = filterCands.filter(f => !f.nonSargable)
  const rewriteFilters = filterCands.filter(f => f.nonSargable)

  // ---- 生成索引建议：单列 + 组合 ----
  const perTable = new Map<string, { filters: FilterCand[]; joins: JoinCand[] }>()
  for (const f of usableFilters) {
    if (!perTable.has(f.table)) perTable.set(f.table, { filters: [], joins: [] })
    perTable.get(f.table)!.filters.push(f)
  }
  for (const j of joinCands) {
    if (!perTable.has(j.table)) perTable.set(j.table, { filters: [], joins: [] })
    perTable.get(j.table)!.joins.push(j)
  }

  for (const [table, group] of perTable) {
    const rows = (schemaOf(table)?.rowCount || 1000)
    const members: { col: string; cost: number; reason: 'filter' | 'join'; range: Range; weight: number }[] = []
    for (const f of group.filters) {
      members.push({ col: f.col, cost: rows * (f.weight / 10) * 0.5, reason: 'filter', range: f.range, weight: f.weight })
    }
    for (const j of group.joins) {
      if (members.some(m => m.col === j.col)) continue
      members.push({ col: j.col, cost: rows * 0.4, reason: 'join', range: j.range, weight: 8 })
    }
    // 单列建议
    for (const m of members) {
      indexAdvice.push({
        id: ++adviceId, table, kind: 'single', reason: m.reason, columns: [m.col],
        ddl: `CREATE INDEX idx_${table}_${m.col} ON ${table} (${m.col});`,
        rationale: m.reason === 'filter'
          ? `${table}.${m.col} 出现在 WHERE 过滤条件中，建索引后可把全表扫描收敛为索引范围扫描（约 ${rows.toLocaleString()} 行表）。`
          : `${table}.${m.col} 出现在 JOIN 连接条件中，为被驱动表建立索引可避免嵌套循环连接时的逐行扫描。`,
        cost: Math.round(m.cost),
        fragments: [{ range: m.range, label: m.col }],
      })
    }
    // 组合索引建议
    if (members.length >= 2) {
      const ordered = [...members].sort((a, b) => b.weight - a.weight || b.cost - a.cost)
      const cols = ordered.map(m => m.col)
      const uniq = Array.from(new Set(cols))
      const reasons = new Set(members.map(m => m.reason))
      indexAdvice.push({
        id: ++adviceId, table, kind: 'composite',
        reason: reasons.has('filter') && reasons.has('join') ? 'mixed' : reasons.has('join') ? 'join' : 'filter',
        columns: uniq,
        ddl: `CREATE INDEX idx_${table}_${uniq.join('_')} ON ${table} (${uniq.join(', ')});`,
        rationale: `同一张表 ${table} 上有 ${members.length} 个谓词/连接列，按等值列在前、范围列在后的顺序建立组合索引，可一次索引同时支撑${reasons.has('join') ? '连接' : ''}${reasons.has('filter') && reasons.has('join') ? '与' : ''}${reasons.has('filter') ? '过滤' : ''}，优于多个单列索引。`,
        cost: Math.round(members.reduce((s, m) => s + m.cost, 0) * 1.15),
        fragments: ordered.filter((m, i) => cols.indexOf(m.col) === i).map(m => ({ range: m.range, label: m.col })),
      })
    }
  }

  // ---- 不可走索引的写法（表达式/全文索引改写）----
  for (const f of rewriteFilters) {
    const rows = schemaOf(f.table)?.rowCount || 1000
    if (f.nonSargable === 'wrap') {
      indexAdvice.push({
        id: ++adviceId, table: f.table, kind: 'rewrite', reason: 'expression', columns: [f.col],
        ddl: `CREATE INDEX idx_${f.table}_${f.col}_expr ON ${f.table} ((${f.func?.toLowerCase()}(${f.col})));  -- 表达式索引，语法因数据库而异`,
        rationale: `${f.table}.${f.col} 被 ${f.func}() 函数包裹，普通索引无法用于该过滤；优先把条件改写为 ${f.col} >= ... AND ${f.col} < ... 的区间写法，或创建对应的表达式/函数索引。`,
        cost: Math.round(rows * 0.35),
        fragments: [{ range: f.range, label: `${f.func}(${f.col})` }],
      })
    } else {
      indexAdvice.push({
        id: ++adviceId, table: f.table, kind: 'rewrite', reason: 'expression', columns: [f.col],
        ddl: `CREATE FULLTEXT INDEX ft_${f.table}_${f.col} ON ${f.table} (${f.col});  -- 或改用后缀匹配 LIKE 'abc%'`,
        rationale: `${f.table}.${f.col} 的 LIKE 模式以通配符开头，B-Tree 索引完全失效；应改为后缀匹配或全文索引（FULLTEXT / GIN + pg_trgm）。`,
        cost: Math.round(rows * 0.35),
        fragments: [{ range: f.range, label: `LIKE %${f.col}%` }],
      })
    }
  }

  // 组内按代价从高到低（UI 分组时同样排序）
  indexAdvice.sort((a, b) => b.cost - a.cost)

  if (!indexAdvice.length) {
    if (!p.whereRefs.length && !p.joinCondRefs.length) {
      indexEmptyReason = '第 3、4 步未发现任何连接条件或过滤条件，没有需要索引支撑的谓词。'
    } else if (usableFilters.length + joinCands.length === 0 && unresolvedPredicates > 0) {
      indexEmptyReason = '第 4 步中谓词列无法定位到涉及的表（多表查询请写全 表.列），没有可匹配的索引列。'
    } else if (rewriteFilters.length === 0) {
      indexEmptyReason = '第 5 步比对发现所有谓词列均已被主键索引覆盖，无需再新增索引。'
    } else {
      indexEmptyReason = '现有谓词均无法通过普通二级索引支撑，仅给出改写类建议。'
    }
  }

  /* ---------------- 列粒度检查：通配符写法 ---------------- */

  let wildcardCount = 0
  for (const item of p.selectItems) {
    const t = item.text.replace(/^DISTINCT\s+/i, '')
    if (t === '*' || /^[a-zA-Z_]\w*\s*\.\s*\*$/.test(t)) {
      wildcardCount++
      const starLocal = t === '*' ? 0 : t.indexOf('*')
      columnIssues.push({
        id: ++issueId, type: 'select-star', clause: item.clause,
        title: '通配符 SELECT *',
        message: `选择列表直接使用了 ${t === '*' ? '*' : t}：会读取全部列、阻碍覆盖索引，并在表结构变更时放大结果集。请显式列出需要的列。`,
        range: { start: item.range.start + starLocal, end: item.range.start + (t === '*' ? starLocal + 1 : t.length) },
      })
    }
  }
  for (const m of sql.matchAll(/\bLIKE\s+'((?:[^']|'')*)'/gi)) {
    const pat = m[1]
    if (!pat.startsWith('%') && !pat.startsWith('_')) continue
    const quoteLocal = m[0].indexOf("'")
    const litStart = m.index! + quoteLocal
    columnIssues.push({
      id: ++issueId, type: 'leading-wildcard-like', clause: 'LIKE 条件',
      title: '前导通配符 LIKE',
      message: `LIKE '${pat}' 以通配符开头，优化器无法使用列上的普通索引，数据量大时会全表扫描；建议改为后缀匹配或全文检索。`,
      range: { start: litStart, end: litStart + m[0].length - quoteLocal },
    })
  }
  steps.push({
    title: '6. 通配符写法检查', status: wildcardCount ? 'warn' : 'ok',
    detail: wildcardCount
      ? `发现 ${wildcardCount} 处 SELECT * / 表名.* 写法，已在下方逐条列出并可点击定位。`
      : '选择列表未使用 SELECT * 或 表名.*，通配符检查通过。',
  })

  /* ---------------- 列粒度检查：未写全的列名 ---------------- */

  /** 各嵌套层级同层表数量（只有同层 ≥2 张表才存在列名歧义风险） */
  const tablesAtLevel = new Map<number, Set<string>>()
  for (const t of p.tableRefs) {
    if (!tablesAtLevel.has(t.depth)) tablesAtLevel.set(t.depth, new Set())
    tablesAtLevel.get(t.depth)!.add(t.name)
  }
  const hasMultiAtLevel = (depth: number) => (tablesAtLevel.get(depth)?.size || 0) >= 2
  const anyMultiLevel = [...tablesAtLevel.values()].some(s => s.size >= 2)

  // 各层级的选择列表别名
  const selectAliases = new Set<string>()
  for (const it of p.selectItems) {
    const am = /\bAS\s+([a-zA-Z_]\w*)\s*$/i.exec(it.text)
    if (am) selectAliases.add(am[1].toLowerCase())
  }
  const contexts: { text: string; base: number; clause: string; depth: number }[] = [
    ...p.selectItems.map(i => ({ text: i.text, base: i.range.start, clause: i.clause, depth: i.depth ?? 0 })),
    ...p.whereRefs.map(i => ({ text: i.text, base: i.range.start, clause: 'WHERE', depth: i.depth })),
    ...p.joinCondRefs.map(i => ({ text: i.text, base: i.range.start, clause: 'JOIN ON', depth: i.depth })),
    ...p.orderItems.map(i => ({ text: i.text, base: i.range.start, clause: 'ORDER BY', depth: i.depth ?? 0 })),
    ...p.groupItems.map(i => ({ text: i.text, base: i.range.start, clause: 'GROUP BY', depth: i.depth ?? 0 })),
  ]
  let unqCount = 0
  const pushed = new Set<number>()
  for (const ctx of contexts) {
    if (p.type !== 'SELECT' || !hasMultiAtLevel(ctx.depth)) continue
    const aliasMap = aliasMapAt(ctx.depth)
    // 跳过字符串字面量区间
    const litRanges: Range[] = []
    for (const lm of ctx.text.matchAll(/'(?:[^']|'')*'/g)) litRanges.push({ start: lm.index!, end: lm.index! + lm[0].length })
    const qualRanges: Range[] = []
    for (const qm of ctx.text.matchAll(/\b[a-zA-Z_]\w*\s*\.\s*[a-zA-Z_]\w*\b/g)) {
      qualRanges.push({ start: qm.index!, end: qm.index! + qm[0].length })
    }
    for (const m of ctx.text.matchAll(/\b[a-zA-Z_]\w*\b/g)) {
      const local = m.index!
      if (litRanges.some(r => local >= r.start && local < r.end)) continue
      if (qualRanges.some(r => local >= r.start && local + m[0].length <= r.end)) continue
      const word = m[0].toLowerCase()
      if (STOPWORDS.has(word) || selectAliases.has(word)) continue
      if (ctx.text[local + m[0].length] === '(') continue
      // 排除别名引用（u / o / p 这类）
      if (aliasMap.has(word) && !schemaOf(word)) continue
      // 歧义判断只看同一嵌套层级的表
      const owners = [...(tablesAtLevel.get(ctx.depth) || [])].filter(n =>
        schemaOf(n)?.columns.some(c => c.name === word))
      if (!owners.length) continue
      const abs = ctx.base + local
      if (pushed.has(abs)) continue
      pushed.add(abs)
      unqCount++
      const ambiguous = owners.length > 1
      columnIssues.push({
        id: ++issueId, type: 'unqualified-column', clause: ctx.clause,
        title: ambiguous ? '列名存在歧义' : '列名未限定表名',
        message: ambiguous
          ? `${ctx.clause} 中的列「${m[0]}」在 ${owners.join('、')} 表中都存在，未写全为 表.列，数据库可能直接报歧义错误。`
          : `${ctx.clause} 中的列「${m[0]}」当前可解析为 ${owners[0]}.${word}，但多表连接时未写表名限定，后续新增同名列会产生歧义。`,
        range: { start: abs, end: abs + m[0].length },
      })
    }
  }
  if (p.type !== 'SELECT') {
    steps.push({ title: '7. 列名完整性检查', status: 'skip', detail: '非 SELECT 语句不检查选择列表列名，本步跳过。' })
  } else if (anyMultiLevel) {
    steps.push({
      title: '7. 列名完整性检查', status: unqCount ? 'warn' : 'ok',
      detail: unqCount ? `发现 ${unqCount} 处未写全的列名（多表查询应使用 表.列），已逐条列出。` : '多表查询中的列均已使用 表.列 限定，检查通过。',
    })
  } else {
    steps.push({
      title: '7. 列名完整性检查', status: 'skip',
      detail: p.tableRefs.length <= 1 ? '语句只涉及一张表，裸列名无歧义风险，本步跳过。'
        : '多个表分别位于不同的子查询层级，每层都只有单表，裸列名可明确归属，本步跳过。',
    })
  }

  columnIssues.sort((a, b) => a.range.start - b.range.start)
  return { indexAdvice, columnIssues, steps, indexEmptyReason }
}

/* ------------------------------ 模板与 Schema ------------------------------ */

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
  { name: '列名与通配符', sql: `SELECT *, o.id AS order_id, u.username AS buyer, p.price * 0.9 AS sale_price
FROM users u
INNER JOIN orders o ON u.id = o.user_id
INNER JOIN products p ON o.product_id = p.id
WHERE status = 'paid' AND o.amount > 100 AND u.username LIKE '%tom%'
ORDER BY created_at DESC;` },
]

export const SCHEMA_TABLES = SCHEMA

/* ------------------------------ Pinia Store ------------------------------ */

let recordSeq = 0

export function buildRecord(sqlText: string): AnalysisRecord {
  const parsed = parseSQL(sqlText)
  const plan = buildPlan(parsed)
  const insights = analyzeInsights(sqlText, parsed)
  const label = `${parsed.type} · ${parsed.tables[0] || '无表'}`
  return { id: ++recordSeq, sql: sqlText, label, parsed, plan, ...insights }
}

export const useSQLStore = defineStore('sql', () => {
  const sql = ref(SQL_TEMPLATES[0].sql)
  const records = ref<AnalysisRecord[]>([])
  const activeId = ref<number | null>(null)
  const activeSchema = ref<SQLTable | null>(null)
  const selection = ref<Range | null>(null)
  const activeItemId = ref<string | null>(null)

  const activeRecord = computed(() => records.value.find(r => r.id === activeId.value) || null)
  const parsed = computed(() => activeRecord.value?.parsed || null)
  const plan = computed(() => activeRecord.value?.plan || null)

  function analyze() {
    const text = sql.value
    const dup = records.value.find(r => r.sql === text)
    if (dup) {
      activeId.value = dup.id
    } else {
      const record = buildRecord(text)
      records.value.push(record)
      if (records.value.length > 20) records.value.splice(0, records.value.length - 20)
      activeId.value = record.id
    }
    selection.value = null
    activeItemId.value = null
  }

  function switchRecord(id: number) {
    const r = records.value.find(x => x.id === id)
    if (!r) return
    activeId.value = id
    sql.value = r.sql
    selection.value = null
    activeItemId.value = null
  }

  function closeRecord(id: number) {
    const idx = records.value.findIndex(x => x.id === id)
    if (idx < 0) return
    records.value.splice(idx, 1)
    if (activeId.value === id) {
      const next = records.value[Math.min(idx, records.value.length - 1)]
      if (next) {
        switchRecord(next.id)
      } else {
        activeId.value = null
        selection.value = null
        activeItemId.value = null
      }
    }
  }

  function loadTemplate(sqlText: string) {
    sql.value = sqlText
    analyze()
  }

  function selectFragment(itemKey: string, range: Range) {
    activeItemId.value = itemKey
    selection.value = { start: range.start, end: range.end }
  }

  function clearHighlight() {
    activeItemId.value = null
    selection.value = null
  }

  const complexityLabel = computed(() => {
    const c = parsed.value?.complexity || 0
    if (c <= 2) return { label: '简单', color: 'text-green-400' }
    if (c <= 5) return { label: '中等', color: 'text-yellow-400' }
    if (c <= 8) return { label: '复杂', color: 'text-orange-400' }
    return { label: '非常复杂', color: 'text-red-400' }
  })

  /** 按表分组的索引建议：表组按组内最高代价排序，组内按代价从高到低 */
  const adviceGroups = computed(() => {
    const r = activeRecord.value
    if (!r) return [] as { table: string; items: IndexAdvice[] }[]
    const map = new Map<string, IndexAdvice[]>()
    for (const a of r.indexAdvice) {
      if (!map.has(a.table)) map.set(a.table, [])
      map.get(a.table)!.push(a)
    }
    return [...map.entries()]
      .map(([table, items]) => ({ table, items: items.sort((a, b) => b.cost - a.cost) }))
      .sort((a, b) => (b.items[0]?.cost || 0) - (a.items[0]?.cost || 0))
  })

  const wildcardIssues = computed(() => activeRecord.value?.columnIssues.filter(i => i.type !== 'unqualified-column') || [])
  const unqualifiedIssues = computed(() => activeRecord.value?.columnIssues.filter(i => i.type === 'unqualified-column') || [])

  return {
    sql, records, activeId, activeRecord, parsed, plan, activeSchema, selection, activeItemId,
    complexityLabel, adviceGroups, wildcardIssues, unqualifiedIssues,
    analyze, switchRecord, closeRecord, loadTemplate, selectFragment, clearHighlight,
  }
})
