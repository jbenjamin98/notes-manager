import { useMemo, useState } from 'react'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY
} from 'd3-force'
import type { EntityCategory, Insights } from '@shared/contract'
import { shortDate } from '../format'

/* Chart rules (dataviz skill): thin marks, 4px rounded data ends on the baseline, recessive
   grid, legend for >=2 series, direct labels, hover tooltip, and a table view for every chart.
   Colours come from the validated --s1..--s3 slots; topics use neutral --muted. */

// ------------------------------------------------------------------ shared bits

function ViewToggle({
  table,
  onToggle
}: {
  table: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onToggle}
      className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
    >
      {table ? 'View as chart' : 'View as table'}
    </button>
  )
}

const th = 'px-2 py-1 text-left text-[11px] font-semibold tracking-wide text-muted uppercase'
const td = 'px-2 py-1 text-sm'

// -------------------------------------------------------------- activity columns

export function ActivityChart({
  weeks,
  unit = 'note'
}: {
  weeks: { weekStart: string; notes: number }[]
  unit?: string
}): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const [table, setTable] = useState(false)
  const W = 640
  const H = 150
  const m = { l: 30, r: 8, t: 10, b: 24 }
  const pw = W - m.l - m.r
  const ph = H - m.t - m.b
  const max = Math.max(1, ...weeks.map((w) => w.notes))
  const niceMax = max <= 4 ? max : Math.ceil(max / 2) * 2
  const bw = pw / weeks.length
  const barW = Math.max(8, bw - 8)
  const y = (v: number): number => m.t + ph - (v / niceMax) * ph
  const ticks =
    niceMax <= 4 ? Array.from({ length: niceMax + 1 }, (_, i) => i) : [0, niceMax / 2, niceMax]
  const total = weeks.reduce((s, w) => s + w.notes, 0)

  const bar = (i: number, v: number): string => {
    const x = m.l + i * bw + (bw - barW) / 2
    const top = y(v)
    const base = m.t + ph
    const r = Math.min(4, (base - top) / 2, barW / 2)
    // Rounded top corners only: data ends round, the baseline end stays square.
    return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${base} Z`
  }
  const plural = (n: number): string => `${n} ${unit}${n === 1 ? '' : 's'}`

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs text-muted">
          {plural(total)} in the last {weeks.length} weeks
        </span>
        <ViewToggle table={table} onToggle={() => setTable(!table)} />
      </div>
      {table ? (
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>Week of</th>
              <th className={th}>{unit}s</th>
            </tr>
          </thead>
          <tbody>
            {[...weeks].reverse().map((w) => (
              <tr key={w.weekStart} className="border-t border-line">
                <td className={td}>{shortDate(w.weekStart)}</td>
                <td className={`${td} tabular-nums`}>{w.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`${plural(total)} over the last ${weeks.length} weeks, by week`}
            className="w-full"
            onMouseLeave={() => setHover(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={m.l}
                  x2={W - m.r}
                  y1={y(t)}
                  y2={y(t)}
                  stroke="var(--line)"
                  strokeWidth={1}
                  strokeDasharray={t === 0 ? undefined : '2 4'}
                />
                <text x={m.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
                  {t}
                </text>
              </g>
            ))}
            {weeks.map((w, i) => (
              <g key={w.weekStart}>
                {w.notes > 0 && (
                  <path
                    d={bar(i, w.notes)}
                    fill="var(--s1)"
                    opacity={hover === null || hover === i ? 1 : 0.55}
                  />
                )}
                {i % 3 === weeks.length % 3 && (
                  <text
                    x={m.l + i * bw + bw / 2}
                    y={H - 6}
                    textAnchor="middle"
                    fontSize={11}
                    fill="var(--muted)"
                  >
                    {shortDate(w.weekStart)}
                  </text>
                )}
                {/* Hit target is the full column, much larger than the mark. */}
                <rect
                  x={m.l + i * bw}
                  y={m.t}
                  width={bw}
                  height={ph}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                />
              </g>
            ))}
          </svg>
          {hover !== null && (
            <div
              role="status"
              className="pointer-events-none absolute -translate-x-1/2 rounded-lg border border-line bg-sticky px-2.5 py-1.5 text-xs shadow-lg backdrop-blur-md"
              style={{ left: `${((m.l + hover * bw + bw / 2) / W) * 100}%`, top: 0 }}
            >
              <div className="text-muted">Week of {shortDate(weeks[hover].weekStart)}</div>
              <div className="font-medium tabular-nums">{plural(weeks[hover].notes)}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------- word cloud

export function WordCloud({ words }: { words: Insights['words'] }): React.JSX.Element {
  const [table, setTable] = useState(false)
  const max = Math.max(1, ...words.map((w) => w.count))
  const min = Math.min(...words.map((w) => w.count), max)
  const size = (c: number): number => 13 + 27 * Math.pow((c - min) / (max - min || 1), 0.75)
  // Emphasis form: the few dominant words carry the hue, the rest stay in ink.
  const hot = new Set(words.slice(0, 5).map((w) => w.word))
  // Stable pseudo-shuffle so the cloud reads as a cloud, not a ranked list, without re-jumping on hover.
  const shuffled = useMemo(() => [...words].sort((a, b) => hash(a.word) - hash(b.word)), [words])

  return (
    <div>
      <div className="mb-2 flex justify-end">
        <ViewToggle table={table} onToggle={() => setTable(!table)} />
      </div>
      {table ? (
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>Word</th>
              <th className={th}>Mentions</th>
              <th className={th}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {words.map((w) => (
              <tr key={w.word} className="border-t border-line">
                <td className={td}>{w.word}</td>
                <td className={`${td} tabular-nums`}>{w.count}</td>
                <td className={`${td} tabular-nums`}>{w.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul
          className="flex flex-wrap items-baseline justify-center gap-x-4 gap-y-1 py-2"
          aria-label="Most frequent words"
        >
          {shuffled.map((w) => (
            <li
              key={w.word}
              title={`${w.word}: ${w.count} mentions in ${w.notes} note${w.notes === 1 ? '' : 's'}`}
              className="leading-tight transition-opacity hover:opacity-70"
              style={{
                fontSize: size(w.count),
                fontWeight: hot.has(w.word) ? 650 : 500,
                color: hot.has(w.word)
                  ? 'var(--s1)'
                  : w.count > (max + min) / 2
                    ? 'var(--fg)'
                    : 'var(--muted)'
              }}
            >
              {w.word}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

// -------------------------------------------------------------------- network

const CAT: Record<string, { label: string; color: string }> = {
  person: { label: 'People', color: 'var(--s1)' },
  customer: { label: 'Accounts', color: 'var(--s2)' },
  system: { label: 'Systems', color: 'var(--s3)' },
  topic: { label: 'Topics', color: 'var(--muted)' },
  event: { label: 'Events', color: 'var(--muted)' }
}

/** Hue alone isn't enough (3-hue all-pairs cap, CVD, contrast WARN on light): shape encodes category too. */
function Shape({
  cat,
  r,
  ...rest
}: { cat: EntityCategory; r: number } & React.SVGProps<SVGElement>): React.JSX.Element {
  const common = { fill: CAT[cat].color, stroke: 'var(--app)', strokeWidth: 2 }
  const p = rest as Record<string, unknown>
  switch (cat) {
    case 'customer':
      return <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={r * 0.3} {...common} {...p} />
    case 'system':
      return (
        <polygon
          points={`0,${-r * 1.25} ${r * 1.25},0 0,${r * 1.25} ${-r * 1.25},0`}
          {...common}
          {...p}
        />
      )
    case 'topic':
      return (
        <polygon
          points={`0,${-r * 1.15} ${r * 1.1},${r * 0.85} ${-r * 1.1},${r * 0.85}`}
          {...common}
          {...p}
        />
      )
    default:
      return <circle r={r} {...common} {...p} />
  }
}

interface LayoutNode {
  id: string
  name: string
  category: EntityCategory
  notes: number
  x: number
  y: number
  r: number
}

export function Network({
  nodes,
  edges,
  onOpen
}: {
  nodes: Insights['nodes']
  edges: Insights['edges']
  onOpen: (id: string) => void
}): React.JSX.Element {
  const [hover, setHover] = useState<string | null>(null)
  const [table, setTable] = useState(false)
  const W = 860
  const H = 520

  // Settle the layout once (no continuous animation: static, cheap, and stable between renders).
  const layout = useMemo(() => {
    const ns = nodes.map((n, i) => ({
      ...n,
      r: Math.min(26, 8 + Math.sqrt(n.notes) * 3.2),
      x: W / 2 + Math.cos(i) * 120,
      y: H / 2 + Math.sin(i) * 90
    }))
    const sim = forceSimulation(ns)
      .force(
        'link',
        forceLink<(typeof ns)[number], { source: string; target: string; weight: number }>(
          edges.map((e) => ({ source: e.a, target: e.b, weight: e.weight }))
        )
          .id((d) => d.id)
          .distance((l) => 110 - Math.min(l.weight * 8, 45))
          .strength(0.35)
      )
      .force('charge', forceManyBody().strength(-260))
      .force('center', forceCenter(W / 2, H / 2))
      .force('x', forceX(W / 2).strength(0.06))
      .force('y', forceY(H / 2).strength(0.09))
      .force(
        'collide',
        forceCollide<(typeof ns)[number]>().radius((d) => d.r + 16)
      )
      .stop()
    for (let i = 0; i < 320; i++) sim.tick()
    // The settled cluster is usually compact; scale it up to use the canvas (keeps proportions).
    const pad = 44
    const xs = ns.map((n) => n.x ?? 0)
    const ys = ns.map((n) => n.y ?? 0)
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
    const [y0, y1] = [Math.min(...ys), Math.max(...ys)]
    const k = Math.min(
      2.4,
      (W - 2 * pad) / Math.max(1, x1 - x0),
      (H - 2 * pad - 10) / Math.max(1, y1 - y0)
    )
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    for (const n of ns) {
      n.x = W / 2 + ((n.x ?? 0) - cx) * k
      n.y = H / 2 - 5 + ((n.y ?? 0) - cy) * k
    }
    const out: LayoutNode[] = ns.map((n) => ({
      id: n.id,
      name: n.name,
      category: n.category,
      notes: n.notes,
      r: n.r,
      x: Math.max(pad, Math.min(W - pad, n.x ?? W / 2)),
      y: Math.max(pad, Math.min(H - pad - 10, n.y ?? H / 2))
    }))
    return out
  }, [nodes, edges])

  const byId = useMemo(() => new Map(layout.map((n) => [n.id, n])), [layout])
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const e of edges) {
      m.set(e.a, (m.get(e.a) ?? new Set()).add(e.b))
      m.set(e.b, (m.get(e.b) ?? new Set()).add(e.a))
    }
    return m
  }, [edges])
  // Fixed legend order (colour slots are assigned per category, never by rank or appearance).
  const present = (['person', 'customer', 'system', 'topic', 'event'] as const).filter((c) =>
    nodes.some((n) => n.category === c)
  )
  const labelTop = new Set(
    [...layout]
      .sort((a, b) => b.notes - a.notes)
      .slice(0, 16)
      .map((n) => n.id)
  )
  const active = hover ? byId.get(hover) : null
  const lit = (id: string): boolean => !hover || id === hover || !!neighbors.get(hover)?.has(id)

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {present.map((c) => (
          <span key={c} className="flex items-center gap-1.5 text-xs text-muted">
            <svg width="14" height="14" viewBox="-9 -9 18 18" aria-hidden>
              <Shape cat={c} r={6} />
            </svg>
            {CAT[c].label}
          </span>
        ))}
        <span className="ml-auto">
          <ViewToggle table={table} onToggle={() => setTable(!table)} />
        </span>
      </div>
      {table ? (
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Type</th>
              <th className={th}>Notes</th>
              <th className={th}>Strongest links</th>
            </tr>
          </thead>
          <tbody>
            {layout.map((n) => {
              const links = edges
                .filter((e) => e.a === n.id || e.b === n.id)
                .sort((a, b) => b.weight - a.weight)
                .slice(0, 3)
                .map((e) => `${byId.get(e.a === n.id ? e.b : e.a)?.name} (${e.weight})`)
              return (
                <tr key={n.id} className="border-t border-line">
                  <td className={td}>
                    <button
                      className="hover:text-accent hover:underline"
                      onClick={() => onOpen(n.id)}
                    >
                      {n.name}
                    </button>
                  </td>
                  <td className={`${td} text-muted`}>{CAT[n.category].label.replace(/s$/, '')}</td>
                  <td className={`${td} tabular-nums`}>{n.notes}</td>
                  <td className={`${td} text-muted`}>{links.join(', ') || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            role="group"
            aria-label="Relationship graph: items that appear in the same notes are connected"
            className="w-full"
            onMouseLeave={() => setHover(null)}
          >
            {edges.map((e) => {
              const a = byId.get(e.a)
              const b = byId.get(e.b)
              if (!a || !b) return null
              const on = !hover || e.a === hover || e.b === hover
              return (
                <line
                  key={`${e.a}|${e.b}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="var(--muted)"
                  strokeWidth={1 + Math.min(e.weight, 4) * 0.6}
                  opacity={on ? (hover ? 0.7 : 0.35) : 0.07}
                />
              )
            })}
            {layout.map((n) => (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                opacity={lit(n.id) ? 1 : 0.22}
                tabIndex={0}
                role="button"
                aria-label={`${n.name}, ${CAT[n.category].label.replace(/s$/, '')}, ${n.notes} notes. Open details`}
                className="cursor-pointer outline-none focus-visible:[&_*]:stroke-[var(--accent)]"
                onMouseEnter={() => setHover(n.id)}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover(null)}
                onClick={() => onOpen(n.id)}
                onKeyDown={(e) => e.key === 'Enter' && onOpen(n.id)}
              >
                <Shape cat={n.category} r={n.r} />
                {(labelTop.has(n.id) ||
                  hover === n.id ||
                  (hover && neighbors.get(hover)?.has(n.id))) && (
                  <text
                    y={n.r + 15}
                    textAnchor="middle"
                    fontSize={12}
                    fontWeight={hover === n.id ? 650 : 500}
                    fill="var(--fg)"
                    stroke="var(--sticky)"
                    strokeWidth={3.5}
                    paintOrder="stroke"
                    style={{ pointerEvents: 'none' }}
                  >
                    {n.name}
                  </text>
                )}
              </g>
            ))}
          </svg>
          {active && (
            <div
              role="status"
              className="pointer-events-none absolute rounded-lg border border-line bg-sticky px-2.5 py-1.5 text-xs shadow-lg backdrop-blur-md"
              style={{
                left: `${(active.x / W) * 100}%`,
                top: `${(active.y / H) * 100}%`,
                transform: `translate(-50%, calc(-100% - ${active.r + 10}px))`
              }}
            >
              <div className="font-medium">{active.name}</div>
              <div className="text-muted">
                {CAT[active.category].label.replace(/s$/, '')} · {active.notes} note
                {active.notes === 1 ? '' : 's'} · {neighbors.get(active.id)?.size ?? 0} connection
                {(neighbors.get(active.id)?.size ?? 0) === 1 ? '' : 's'}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
