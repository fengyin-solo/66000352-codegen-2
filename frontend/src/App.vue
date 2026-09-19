<template>
  <div class="min-h-screen bg-slate-900 text-slate-200">
    <header class="border-b border-slate-700 px-6 py-4">
      <h1 class="text-2xl font-bold text-cyan-400">SQL 查询可视化与执行计划分析器</h1>
      <p class="text-sm text-slate-500 mt-1">SQL语法解析 · 执行计划树 · ER图 · 复杂度评分 · 优化建议 · 索引与列粒度检查</p>
    </header>
    <div class="flex flex-col lg:flex-row gap-4 p-4">
      <div class="lg:w-2/5 space-y-4">
        <div class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold text-slate-400">SQL 编辑器</h3>
            <div class="flex gap-2">
              <select @change="(e) => { store.loadTemplate(SQL_TEMPLATES[+(e.target as HTMLSelectElement).value].sql); (e.target as HTMLSelectElement).selectedIndex = -1 }" class="text-xs bg-slate-900 border border-slate-600 rounded px-2 py-1 text-slate-300">
                <option disabled selected>选择模板…</option>
                <option v-for="(t, i) in SQL_TEMPLATES" :key="i" :value="i">{{ t.name }}</option>
              </select>
            </div>
          </div>
          <textarea ref="editorRef" v-model="store.sql" rows="12"
            @input="store.clearHighlight()"
            class="w-full bg-slate-900 border rounded px-3 py-2 text-sm font-mono text-green-400 focus:outline-none resize-none"
            :class="store.activeItemId ? 'border-yellow-500' : 'border-slate-600 focus:border-cyan-500'"></textarea>
          <button @click="store.analyze" class="w-full mt-3 py-2 bg-cyan-600 hover:bg-cyan-500 rounded text-sm font-bold">分析查询</button>
          <div v-if="store.records.length" class="mt-3">
            <div class="text-xs text-slate-500 mb-1">已分析语句（{{ store.records.length }}）— 切换后建议条目与语句一一对应</div>
            <div class="flex flex-wrap gap-1.5">
              <div v-for="r in store.records" :key="r.id"
                @click="store.switchRecord(r.id)"
                :class="['group flex items-center gap-1 text-xs rounded-full pl-3 pr-1.5 py-1 border cursor-pointer transition-all',
                  r.id === store.activeId ? 'bg-cyan-900/40 border-cyan-500 text-cyan-300' : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500']">
                <span>{{ r.label }}</span>
                <span class="text-slate-600">#{{ r.id }}</span>
                <span @click.stop="store.closeRecord(r.id)" class="ml-1 w-4 h-4 flex items-center justify-center rounded-full hover:bg-red-500 hover:text-white text-slate-500">×</span>
              </div>
            </div>
          </div>
        </div>
        <div class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">数据库 Schema</h3>
          <div class="space-y-2">
            <div v-for="t in SCHEMA_TABLES" :key="t.name" @click="store.activeSchema = store.activeSchema?.name === t.name ? null : t"
              :class="['cursor-pointer rounded border p-2 text-xs transition-all', store.activeSchema?.name === t.name ? 'border-cyan-500 bg-cyan-900/20' : 'border-slate-700 hover:border-slate-500']">
              <div class="flex justify-between items-center">
                <span class="font-bold text-slate-200">{{ t.name }}</span>
                <span class="text-slate-500">{{ t.rowCount.toLocaleString() }} 行</span>
              </div>
              <div v-if="store.activeSchema?.name === t.name" class="mt-2 space-y-0.5">
                <div v-for="c in t.columns" :key="c.name" class="flex gap-2">
                  <span :class="c.pk ? 'text-yellow-400' : c.fk ? 'text-blue-400' : 'text-slate-400'">{{ c.pk ? '🔑 ' : c.fk ? '🔗 ' : '  ' }}{{ c.name }}</span>
                  <span class="text-slate-600">{{ c.type }}</span>
                  <span v-if="c.fk" class="text-blue-600">→ {{ c.fk }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="lg:w-3/5 space-y-4">
        <div v-if="store.parsed" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">查询解析结果</h3>
          <div class="grid grid-cols-4 gap-3 text-sm mb-4">
            <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">类型</div><div class="text-cyan-400 font-bold">{{ store.parsed.type }}</div></div>
            <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">复杂度</div><div class="font-bold" :class="store.complexityLabel.color">{{ store.complexityLabel.label }}</div></div>
            <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">JOIN数</div><div class="text-orange-400 font-bold">{{ store.parsed.joins.length }}</div></div>
            <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">预估行数</div><div class="text-purple-400 font-bold">{{ store.parsed.estimatedCost }}</div></div>
          </div>
          <div v-if="store.parsed.suggestions.length" class="space-y-1">
            <div class="text-xs text-slate-500 mb-1">优化建议</div>
            <div v-for="(s, i) in store.parsed.suggestions" :key="i" class="text-xs flex items-start gap-2 bg-orange-900/30 border border-orange-700 rounded p-2">
              <span class="text-orange-400">⚠</span><span class="text-orange-300">{{ s }}</span>
            </div>
          </div>
          <div v-else class="text-xs text-green-400 bg-green-900/20 border border-green-700 rounded p-2">✓ 未发现明显性能问题</div>
        </div>

        <!-- 索引与列粒度检查 -->
        <div v-if="store.activeRecord" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold text-slate-400">索引与列粒度检查</h3>
            <span class="text-xs text-slate-600">点击条目可在编辑器选中对应片段</span>
          </div>

          <!-- 检查依据（分步） -->
          <details class="mb-3 bg-slate-900/60 rounded border border-slate-700">
            <summary class="text-xs text-slate-400 cursor-pointer px-3 py-2 select-none">检查依据（{{ store.activeRecord.steps.length }} 步分析过程，展开查看每一步找到了/没找到什么）</summary>
            <div class="px-3 pb-2 space-y-1">
              <div v-for="(st, i) in store.activeRecord.steps" :key="i" class="text-xs flex items-start gap-2">
                <span :class="stepColor(st.status).icon">{{ stepColor(st.status).mark }}</span>
                <div>
                  <span class="text-slate-300 font-bold">{{ st.title }}</span>
                  <span :class="['ml-1', stepColor(st.status).text]">[{{ stepColor(st.status).word }}]</span>
                  <div class="text-slate-500">{{ st.detail }}</div>
                </div>
              </div>
            </div>
          </details>

          <!-- 索引建议（按表分组，组内按代价降序） -->
          <div class="text-xs text-slate-500 mb-1">索引建议（按涉及表分组，同表多条按代价从高到低）</div>
          <div v-if="store.adviceGroups.length" class="space-y-3">
            <div v-for="g in store.adviceGroups" :key="g.table" class="border border-slate-700 rounded">
              <div class="flex items-center justify-between bg-slate-900/70 px-3 py-1.5 rounded-t">
                <span class="font-bold text-cyan-300">📋 {{ g.table }}</span>
                <span class="text-slate-500">{{ schemaRows(g.table) }} 行 · {{ g.items.length }} 条建议</span>
              </div>
              <div class="p-2 space-y-1.5">
                <div v-for="a in g.items" :key="a.id"
                  @click="pick(`idx-${a.id}`, a.fragments[0].range)"
                  :class="['cursor-pointer rounded border p-2 transition-all',
                    store.activeItemId === `idx-${a.id}` ? 'border-yellow-500 bg-yellow-900/20' : 'border-slate-700 bg-slate-900/40 hover:border-slate-500']">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span :class="kindBadge(a.kind).cls">{{ kindBadge(a.kind).text }}</span>
                    <span class="text-slate-200 font-bold">{{ a.columns.join(', ') }}</span>
                    <span class="text-slate-600">·</span>
                    <span class="text-purple-400">代价权重 {{ a.cost }}</span>
                    <span class="text-slate-600">·</span>
                    <span class="text-slate-500">{{ reasonWord(a.reason) }}</span>
                    <span class="ml-auto text-slate-600">点击定位 ⤢</span>
                  </div>
                  <div class="text-slate-400 mt-1">{{ a.rationale }}</div>
                  <code class="block mt-1 text-green-400 bg-slate-950/60 rounded px-2 py-1 font-mono">{{ a.ddl }}</code>
                  <div v-if="a.fragments.length > 1" class="mt-1 flex flex-wrap gap-1">
                    <span v-for="(f, fi) in a.fragments" :key="fi" @click.stop="pick(`idx-${a.id}-${fi}`, f.range)"
                      :class="['text-[10px] px-1.5 py-0.5 rounded border border-slate-600 hover:border-yellow-500 hover:text-yellow-300',
                        store.activeItemId === `idx-${a.id}-${fi}` ? 'border-yellow-500 text-yellow-300' : 'text-slate-400']">
                      定位 {{ f.label }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="text-xs text-slate-400 bg-slate-900/50 border border-slate-700 rounded p-2 mb-3">
            <span class="text-slate-500">暂无可建议的索引：</span>{{ store.activeRecord.indexEmptyReason }}
          </div>

          <!-- 列粒度：通配符写法 -->
          <div class="text-xs text-slate-500 mb-1 mt-4">仍在使用的通配符写法</div>
          <div v-if="store.wildcardIssues.length" class="space-y-1.5">
            <div v-for="iss in store.wildcardIssues" :key="iss.id"
              @click="pick(`col-${iss.id}`, iss.range)"
              :class="['cursor-pointer rounded border p-2 transition-all',
                store.activeItemId === `col-${iss.id}` ? 'border-yellow-500 bg-yellow-900/20' : 'border-slate-700 bg-slate-900/40 hover:border-slate-500']">
              <div class="flex items-center gap-2">
                <span class="text-red-400">✱</span>
                <span class="text-red-300 font-bold">{{ iss.title }}</span>
                <span class="text-slate-600">·</span>
                <span class="text-slate-500">{{ iss.clause }}</span>
                <code class="ml-2 text-yellow-300 font-mono">{{ snippet(iss.range) }}</code>
                <span class="ml-auto text-slate-600">点击定位 ⤢</span>
              </div>
              <div class="text-slate-400 mt-1">{{ iss.message }}</div>
            </div>
          </div>
          <div v-else class="text-xs text-green-400 bg-green-900/20 border border-green-700 rounded p-2 mb-2">✓ 未发现 SELECT * / 表名.* / 前导通配符 LIKE</div>

          <!-- 列粒度：未写全的列名 -->
          <div class="text-xs text-slate-500 mb-1 mt-4">没有写全的列名（多表查询应写 表.列）</div>
          <div v-if="store.unqualifiedIssues.length" class="space-y-1.5">
            <div v-for="iss in store.unqualifiedIssues" :key="iss.id"
              @click="pick(`col-${iss.id}`, iss.range)"
              :class="['cursor-pointer rounded border p-2 transition-all',
                store.activeItemId === `col-${iss.id}` ? 'border-yellow-500 bg-yellow-900/20' : 'border-slate-700 bg-slate-900/40 hover:border-slate-500']">
              <div class="flex items-center gap-2">
                <span class="text-orange-400">⚠</span>
                <span class="text-orange-300 font-bold">{{ iss.title }}</span>
                <span class="text-slate-600">·</span>
                <span class="text-slate-500">{{ iss.clause }}</span>
                <code class="ml-2 text-yellow-300 font-mono">{{ snippet(iss.range) }}</code>
                <span class="ml-auto text-slate-600">点击定位 ⤢</span>
              </div>
              <div class="text-slate-400 mt-1">{{ iss.message }}</div>
            </div>
          </div>
          <div v-else class="text-xs text-green-400 bg-green-900/20 border border-green-700 rounded p-2">✓ 相关列均已限定表名（或本步骤不适用，见上方检查依据第 7 步）</div>
        </div>

        <div v-if="store.plan" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">执行计划树</h3>
          <div class="overflow-x-auto">
            <div class="font-mono text-xs text-slate-300 space-y-1">
              <PlanNode :node="store.plan" :depth="0" />
            </div>
          </div>
        </div>
        <div v-if="store.parsed" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">涉及表与关联关系</h3>
          <canvas ref="erCanvasRef" class="w-full bg-slate-900 rounded" style="height:200px"></canvas>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, defineComponent, h } from 'vue'
import { useSQLStore, SQL_TEMPLATES, SCHEMA_TABLES } from './store/sql'
import type { Range, IndexAdvice, AnalysisStep } from './store/sql'

const store = useSQLStore()
const erCanvasRef = ref<HTMLCanvasElement | null>(null)
const editorRef = ref<HTMLTextAreaElement | null>(null)

const PlanNode = defineComponent({
  props: { node: Object, depth: Number },
  setup(props) {
    return () => {
      if (!props.node) return null
      const n = props.node as any
      const indent = '  '.repeat(props.depth || 0)
      const opColor = n.operation.includes('Scan') ? '#22c55e' : n.operation.includes('Join') ? '#f97316' : n.operation.includes('Sort') ? '#8b5cf6' : '#06b6d4'
      return h('div', [
        h('div', { style: `padding-left: ${(props.depth || 0) * 20}px` }, [
          h('span', { style: 'color: #475569' }, indent.replace(/\s\s/g, '│ ').replace(/│ $/, '└─')),
          h('span', { style: `color: ${opColor}; font-weight: bold` }, n.operation),
          n.table ? h('span', { style: 'color: #94a3b8' }, ` on ${n.table}`) : null,
          n.index ? h('span', { style: 'color: #eab308' }, ` [${n.index}]`) : null,
          h('span', { style: 'color: #64748b' }, ` cost=${n.cost.toFixed(1)} rows=${n.rows}`),
        ]),
        ...(n.children || []).map((child: any) => h(PlanNode, { node: child, depth: (props.depth || 0) + 1 }))
      ])
    }
  }
})

function pick(key: string, range: Range) {
  store.selectFragment(key, range)
}

function snippet(range: Range) {
  return store.sql.slice(range.start, range.end)
}

function schemaRows(table: string) {
  return SCHEMA_TABLES.find(s => s.name === table)?.rowCount.toLocaleString() ?? '未知'
}

function kindBadge(kind: IndexAdvice['kind']) {
  if (kind === 'composite') return { text: '组合索引', cls: 'text-[10px] px-1.5 py-0.5 rounded bg-cyan-900/50 text-cyan-300 border border-cyan-700' }
  if (kind === 'rewrite') return { text: '改写/表达式', cls: 'text-[10px] px-1.5 py-0.5 rounded bg-red-900/50 text-red-300 border border-red-700' }
  return { text: '单列索引', cls: 'text-[10px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300 border border-blue-700' }
}

function reasonWord(reason: IndexAdvice['reason']) {
  return reason === 'filter' ? '支撑过滤条件' : reason === 'join' ? '支撑连接条件' : reason === 'mixed' ? '同时支撑过滤与连接' : '写法需改写'
}

function stepColor(status: AnalysisStep['status']) {
  switch (status) {
    case 'ok': return { mark: '✓', word: '找到依据', icon: 'text-green-400', text: 'text-green-400' }
    case 'warn': return { mark: '!', word: '依据不足', icon: 'text-yellow-400', text: 'text-yellow-400' }
    case 'skip': return { mark: '–', word: '跳过', icon: 'text-slate-500', text: 'text-slate-500' }
    default: return { mark: 'i', word: '信息', icon: 'text-cyan-400', text: 'text-cyan-400' }
  }
}

/** 在编辑器中选中指定区间并滚动到该处 */
function revealInEditor(range: Range) {
  const ta = editorRef.value
  if (!ta) return
  ta.focus()
  ta.setSelectionRange(range.start, range.end)
  const before = ta.value.slice(0, range.start)
  const line = before.split('\n').length
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight || '20')
  ta.scrollTop = Math.max(0, (line - 3) * lineHeight)
}

watch(() => store.selection, (range) => {
  if (range) revealInEditor(range)
})

function drawER() {
  const canvas = erCanvasRef.value
  if (!canvas || !store.parsed) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const tables = store.parsed.tables
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  canvas.width = canvas.clientWidth
  canvas.height = 200
  const W = canvas.width, H = 200
  const spacing = W / (tables.length + 1)
  const positions: Record<string, { x: number; y: number }> = {}
  tables.forEach((t, i) => { positions[t] = { x: spacing * (i + 1), y: H / 2 } })

  // Draw joins
  store.parsed.joins.forEach(j => {
    const src = positions[tables[0]]
    const dst = positions[j.table]
    if (!src || !dst) return
    ctx.beginPath()
    ctx.moveTo(src.x, src.y)
    ctx.lineTo(dst.x, dst.y)
    ctx.strokeStyle = '#f97316'
    ctx.lineWidth = 2
    ctx.setLineDash([4, 4])
    ctx.stroke()
    ctx.setLineDash([])
    const mx = (src.x + dst.x) / 2, my = (src.y + dst.y) / 2
    ctx.fillStyle = '#f97316'
    ctx.font = '10px monospace'
    ctx.textAlign = 'center'
    ctx.fillText(j.type, mx, my - 5)
  })

  // Draw table boxes
  tables.forEach((t) => {
    const pos = positions[t]
    if (!pos) return
    const x = pos.x, y = pos.y
    ctx.fillStyle = '#1e293b'
    ctx.strokeStyle = '#3b82f6'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.roundRect(x - 50, y - 30, 100, 60, 6)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#06b6d4'
    ctx.font = 'bold 13px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(t, x, y - 10)
    const schema = SCHEMA_TABLES.find(s => s.name === t)
    if (schema) {
      ctx.fillStyle = '#64748b'
      ctx.font = '10px monospace'
      ctx.fillText(schema.rowCount.toLocaleString() + ' rows', x, y + 10)
    }
  })
}

onMounted(() => { store.analyze(); setTimeout(drawER, 200) })
watch(() => store.parsed, () => setTimeout(drawER, 100), { deep: true })
</script>
