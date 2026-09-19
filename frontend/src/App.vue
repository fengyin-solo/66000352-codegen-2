<template>
  <div class="min-h-screen bg-slate-900 text-slate-200">
    <header class="border-b border-slate-700 px-6 py-4">
      <h1 class="text-2xl font-bold text-cyan-400">SQL 查询可视化与执行计划分析器</h1>
      <p class="text-sm text-slate-500 mt-1">SQL语法解析 · 执行计划树 · ER图 · 复杂度评分 · 索引/列粒度建议</p>
    </header>
    <div class="flex flex-col lg:flex-row gap-4 p-4">
      <div class="lg:w-2/5 space-y-4">
        <div class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold text-slate-400">SQL 编辑器</h3>
            <div class="flex gap-2">
              <select @change="(e) => { store.sql = SQL_TEMPLATES[+(e.target as HTMLSelectElement).value].sql }" class="text-xs bg-slate-900 border border-slate-600 rounded px-2 py-1 text-slate-300">
                <option v-for="(t, i) in SQL_TEMPLATES" :key="i" :value="i">{{ t.name }}</option>
              </select>
            </div>
          </div>
          <textarea ref="editorRef" v-model="store.sql" rows="14"
            class="editor-ta w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-green-400 focus:outline-none focus:border-cyan-500 resize-none leading-5"></textarea>
          <button @click="store.analyze" class="w-full mt-3 py-2 bg-cyan-600 hover:bg-cyan-500 rounded text-sm font-bold">分析查询</button>
          <p class="text-[11px] text-slate-500 mt-2">支持分号分隔的多段语句；点击右侧任意建议条目可在编辑区定位并选中对应片段。</p>
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
        <!-- 多语句切换：索引卡与列粒度卡共用同一当前语句 -->
        <div v-if="store.results.length > 1" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">语句切换（共 {{ store.results.length }} 段，建议条目与语句一一对应）</h3>
          <div class="flex flex-wrap gap-2">
            <button v-for="r in store.results" :key="r.index" @click="store.setActiveStmt(r.index)"
              :class="['text-xs rounded px-3 py-1.5 border font-mono transition-all', store.activeStmt === r.index ? 'border-cyan-400 bg-cyan-900/40 text-cyan-300' : 'border-slate-600 text-slate-400 hover:border-slate-400']">
              语句 {{ r.index + 1 }}
              <span class="ml-1 opacity-70">{{ r.isEmpty ? '空' : r.parsed.type }}</span>
              <span v-if="r.indexAdvices.length" class="text-cyan-400"> · 索引{{ r.indexAdvices.length }}</span>
              <span v-if="r.wildcardIssues.length" class="text-amber-400"> · 通配{{ r.wildcardIssues.length }}</span>
              <span v-if="r.incompleteIssues.length" class="text-orange-400"> · 列名{{ r.incompleteIssues.length }}</span>
            </button>
          </div>
        </div>

        <template v-if="current">
          <div class="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-bold text-slate-400">查询解析结果</h3>
              <span class="text-[11px] text-slate-500 font-mono">当前：语句 {{ current.index + 1 }} / {{ store.results.length }}{{ current.isEmpty ? '（空语句）' : '' }}</span>
            </div>
            <div class="grid grid-cols-4 gap-3 text-sm mb-4">
              <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">类型</div><div class="text-cyan-400 font-bold">{{ store.parsed?.type }}</div></div>
              <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">复杂度</div><div class="font-bold" :class="store.complexityLabel.color">{{ store.complexityLabel.label }}</div></div>
              <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">JOIN数</div><div class="text-orange-400 font-bold">{{ store.parsed?.joins.length ?? 0 }}</div></div>
              <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">预估行数</div><div class="text-purple-400 font-bold">{{ store.parsed?.estimatedCost ?? 0 }}</div></div>
            </div>
            <div v-if="store.parsed?.suggestions.length" class="space-y-1">
              <div class="text-xs text-slate-500 mb-1">优化建议</div>
              <div v-for="(s, i) in store.parsed.suggestions" :key="i" class="text-xs flex items-start gap-2 bg-orange-900/30 border border-orange-700 rounded p-2">
                <span class="text-orange-400">⚠</span><span class="text-orange-300">{{ s }}</span>
              </div>
            </div>
            <div v-else class="text-xs text-green-400 bg-green-900/20 border border-green-700 rounded p-2">✓ 未发现明显性能问题</div>
          </div>

          <!-- 索引建议：按涉及的表归组，同表多条按代价从高到低 -->
          <div class="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-bold text-cyan-400">索引建议（过滤条件 / 连接条件）</h3>
              <span class="text-[11px] text-slate-500 font-mono">当前：语句 {{ current.index + 1 }}</span>
            </div>
            <template v-if="current.indexGroups.length">
              <div v-for="g in current.indexGroups" :key="g.table" class="mb-3 last:mb-0 border border-slate-700 rounded-lg overflow-hidden">
                <div class="flex items-center justify-between bg-slate-900/70 px-3 py-2">
                  <span class="text-xs font-bold text-cyan-300">📦 {{ g.table }}</span>
                  <span class="text-[11px] text-slate-500">{{ g.rowCount.toLocaleString() }} 行 · {{ g.advices.length }} 条建议（代价从高到低）</span>
                </div>
                <div class="divide-y divide-slate-700/60">
                  <div v-for="a in g.advices" :key="a.id"
                    :class="['px-3 py-2.5 transition-all cursor-pointer', isActive('idx-row-' + a.id) ? 'bg-cyan-900/30 ring-1 ring-cyan-500' : 'hover:bg-slate-700/30']"
                    @click="locateSnippet(current.index, a.reasons[0].snippet, 'idx-row-' + a.id)">
                    <div class="flex items-center gap-2 flex-wrap mb-1">
                      <code class="text-xs text-green-400 bg-slate-950 rounded px-2 py-0.5">{{ a.ddl }}</code>
                      <span :class="['text-[10px] rounded px-1.5 py-0.5', a.kind === 'join' ? 'bg-orange-900/60 text-orange-300' : a.kind === 'mixed' ? 'bg-purple-900/60 text-purple-300' : 'bg-blue-900/60 text-blue-300']">
                        {{ a.kind === 'join' ? '连接条件' : a.kind === 'mixed' ? '过滤+连接' : '过滤条件' }}
                      </span>
                      <span class="text-[11px] text-slate-400">{{ a.costLabel }}</span>
                    </div>
                    <div class="flex flex-wrap gap-1.5">
                      <button v-for="(r, ri) in a.reasons" :key="ri" @click.stop="locateSnippet(current.index, r.snippet, 'idx-' + a.id + '-' + ri)"
                        :class="['text-[11px] rounded border px-1.5 py-0.5 font-mono transition-all', isActive('idx-' + a.id + '-' + ri) ? 'border-cyan-400 bg-cyan-900/50 text-cyan-200' : 'border-slate-600 text-slate-400 hover:border-cyan-500 hover:text-cyan-300']">
                        <span class="mr-1">{{ r.kind === 'join' ? '🔗' : '🔎' }}</span>{{ r.snippet.text.length > 46 ? r.snippet.text.slice(0, 46) + '…' : r.snippet.text }}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </template>
            <div v-else class="text-xs bg-slate-900/60 border border-slate-700 rounded p-3 space-y-1">
              <div class="text-slate-400 font-bold">暂无可建议的索引。</div>
              <div class="text-slate-500">未找到依据：{{ current.steps[3]?.message }}</div>
              <div v-if="current.steps[2]?.status !== 'ok'" class="text-slate-500">上游步骤：{{ current.steps[2]?.message }}</div>
            </div>
          </div>

          <!-- 列粒度检查：通配符写法 / 未写全的列名单，两类单独列出 -->
          <div class="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-bold text-amber-400">列粒度检查</h3>
              <span class="text-[11px] text-slate-500 font-mono">当前：语句 {{ current.index + 1 }}</span>
            </div>

            <div class="mb-3">
              <div class="text-xs font-bold text-amber-300 mb-1.5">① 仍在使用的通配符写法（{{ current.wildcardIssues.length }}）</div>
              <div v-if="current.wildcardIssues.length" class="space-y-1.5">
                <div v-for="iss in current.wildcardIssues" :key="iss.id"
                  :class="['rounded border p-2 cursor-pointer transition-all', isActive(iss.id) ? 'border-amber-400 bg-amber-900/30' : 'border-amber-800/60 bg-amber-900/10 hover:bg-amber-900/20']"
                  @click="locateSnippet(current.index, iss.snippet, iss.id)">
                  <div class="flex items-center gap-2 flex-wrap">
                    <code class="text-[11px] text-amber-200 font-mono bg-slate-950 rounded px-1.5 py-0.5">{{ iss.snippet.text }}</code>
                    <span v-if="iss.table" class="text-[10px] text-slate-500">表：{{ iss.table }}</span>
                  </div>
                  <div class="text-[11px] text-amber-200/90 mt-1">{{ iss.detail }}</div>
                  <div class="text-[11px] text-green-400/90 mt-0.5">建议：{{ iss.suggestion }}</div>
                </div>
              </div>
              <div v-else class="text-[11px] text-slate-500 bg-slate-900/60 border border-slate-700 rounded p-2">{{ current.steps[4]?.message }}</div>
            </div>

            <div>
              <div class="text-xs font-bold text-orange-300 mb-1.5">② 没有写全的列名（{{ current.incompleteIssues.length }}）</div>
              <div v-if="current.incompleteIssues.length" class="space-y-1.5">
                <div v-for="iss in current.incompleteIssues" :key="iss.id"
                  :class="['rounded border p-2 cursor-pointer transition-all', isActive(iss.id) ? 'border-orange-400 bg-orange-900/30' : 'border-orange-800/60 bg-orange-900/10 hover:bg-orange-900/20']"
                  @click="locateSnippet(current.index, iss.snippet, iss.id)">
                  <div class="flex items-center gap-2 flex-wrap">
                    <code class="text-[11px] text-orange-200 font-mono bg-slate-950 rounded px-1.5 py-0.5">{{ iss.snippet.text }}</code>
                    <span v-if="iss.table" class="text-[10px] text-slate-500">表：{{ iss.table }}</span>
                  </div>
                  <div class="text-[11px] text-orange-200/90 mt-1">{{ iss.detail }}</div>
                  <div class="text-[11px] text-green-400/90 mt-0.5">完整列名单：{{ iss.suggestion.replace(/^[^：]*：?/, '') }}</div>
                </div>
              </div>
              <div v-else class="text-[11px] text-slate-500 bg-slate-900/60 border border-slate-700 rounded p-2">{{ current.steps[5]?.message }}</div>
            </div>
          </div>

          <!-- 分步依据：说明是哪一步没找到依据 -->
          <div class="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <details>
              <summary class="text-sm font-bold text-slate-400 cursor-pointer select-none">分析步骤依据（{{ current.steps.length }} 步）</summary>
              <div class="mt-2 space-y-1">
                <div v-for="(st, i) in current.steps" :key="i" class="flex items-start gap-2 text-[11px] rounded border p-2"
                  :class="st.status === 'ok' ? 'border-green-800/60 bg-green-900/10' : st.status === 'skip' ? 'border-slate-700 bg-slate-900/40 text-slate-500' : 'border-red-800/60 bg-red-900/10'">
                  <span>{{ st.status === 'ok' ? '✓' : st.status === 'skip' ? '—' : '✗' }}</span>
                  <div>
                    <div class="font-bold text-slate-300">第 {{ i + 1 }} 步 · {{ st.name }}</div>
                    <div :class="st.status === 'ok' ? 'text-slate-400' : st.status === 'skip' ? 'text-slate-600' : 'text-red-300/90'">{{ st.message }}</div>
                  </div>
                </div>
              </div>
            </details>
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
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, defineComponent, h, nextTick } from 'vue'
import { useSQLStore, SQL_TEMPLATES, SCHEMA_TABLES, type Snippet } from './store/sql'

const store = useSQLStore()
const erCanvasRef = ref<HTMLCanvasElement | null>(null)
const editorRef = ref<HTMLTextAreaElement | null>(null)
const current = store.active

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

function isActive(id: string) {
  return store.activeFragment?.id === id
}

/** 点击建议：切换到对应语句（如需要）并在编辑区选中片段 */
function locateSnippet(stmt: number, snip: Snippet, id: string) {
  store.locate(stmt, snip, id)
}

watch(() => store.activeFragment, async (frag) => {
  if (!frag) return
  await nextTick()
  const ta = editorRef.value
  if (!ta) return
  ta.focus()
  ta.setSelectionRange(frag.start, frag.end)
  const linesBefore = (store.sql.slice(0, frag.start).match(/\n/g) || []).length
  const lineHeight = 20
  ta.scrollTop = Math.max(0, linesBefore * lineHeight - ta.clientHeight / 2)
}, { flush: 'post' })

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

watch(() => store.activeStmt, () => setTimeout(drawER, 100))
watch(() => store.parsed, () => setTimeout(drawER, 100), { deep: true })
onMounted(() => { store.analyze(); setTimeout(drawER, 200) })
</script>

<style>
.editor-ta::selection,
.editor-ta ::selection {
  background: rgba(34, 211, 238, 0.35);
  color: #a5f3fc;
}
</style>
