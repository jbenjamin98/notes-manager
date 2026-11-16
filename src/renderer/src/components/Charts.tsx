import { useId, useMemo, useState } from 'react'
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

const th = 'px-2 py-1 text-left text-xs font-semibold tracking-wide text-muted uppercase'
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
  customer: { label: 'Companies', color: 'var(--s2)' },
  system: { label: 'Systems', color: 'var(--s3)' },
  project: { label: 'Projects', color: 'var(--accent)' },
  place: { label: 'Places', color: 'var(--warn)' },
  topic: { label: 'Topics', color: 'var(--muted)' },
  event: { label: 'Events', color: 'var(--muted)' }
}

/** Star colours for the night sky (bright on the dark panel in both themes). */
const STAR: Record<string, string> = {
  person: '#6db4ff',
  customer: '#ff9a6b',
  system: '#52e3ab',
  project: '#b9b5ff',
  place: '#ffd35e',
  topic: '#b4bcdf',
  event: '#b4bcdf'
}

/** Spikes per category: hue alone isn't enough (CVD), so the star's shape carries the category too. */
const SPIKES: Record<string, number> = {
  person: 4,
  customer: 5,
  project: 6,
  system: 8,
  place: 3,
  topic: 0,
  event: 0
}

/** A sharp n-pointed star with its points straight up (topics and events are plain soft dots). */
function starPoints(n: number, outer: number, inner: number): string {
  return Array.from({ length: n * 2 }, (_, i) => {
    const a = (Math.PI * i) / n - Math.PI / 2
    const r = i % 2 === 0 ? outer : inner
    return `${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`
  }).join(' ')
}

function Shape({
  cat,
  r,
  ...rest
}: { cat: EntityCategory; r: number } & React.SVGProps<SVGElement>): React.JSX.Element {
  const p = rest as Record<string, unknown>
  const n = SPIKES[cat] ?? 0
  const fill = STAR[cat] ?? STAR.topic
  if (n === 0) return <circle r={r * 0.8} fill={fill} {...p} />
  // More spikes means a rounder star; few spikes make a long, sharp sparkle.
  const inner = n <= 4 ? 0.34 : n <= 6 ? 0.46 : 0.58
  return (
    <polygon
      points={starPoints(n, r * 1.55, r * 1.55 * inner)}
      fill={fill}
      strokeLinejoin="round"
      {...p}
    />
  )
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

  const uid = useId().replace(/:/g, '')
  // A fixed scatter of faint background stars (same every render).
  const dust = useMemo(
    () =>
      Array.from({ length: 70 }, (_, i) => {
        const h = hash(`dust${i}`)
        return {
          x: h % W,
          y: (h >>> 9) % H,
          r: 0.5 + ((h >>> 5) % 10) / 10,
          o: 0.25 + ((h >>> 3) % 50) / 100,
          delay: (h % 60) / 10,
          dur: 2.5 + ((h >>> 7) % 40) / 10
        }
      }),
    []
  )
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
  const present = (
    ['person', 'customer', 'project', 'system', 'place', 'topic', 'event'] as const
  ).filter((c) => nodes.some((n) => n.category === c))
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
            <svg width="20" height="20" viewBox="-11 -11 22 22" aria-hidden>
              <circle r="10.5" fill="#0a0e2c" />
              <Shape cat={c} r={5} />
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
            className="w-full rounded-2xl"
            onMouseLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id={`${uid}-sky`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#0a0e2c" />
                <stop offset="1" stopColor="#171446" />
              </linearGradient>
              <radialGradient id={`${uid}-neb1`}>
                <stop offset="0" stopColor="#6a4fe0" stopOpacity="0.32" />
                <stop offset="1" stopColor="#6a4fe0" stopOpacity="0" />
              </radialGradient>
              <radialGradient id={`${uid}-neb2`}>
                <stop offset="0" stopColor="#1f9bd6" stopOpacity="0.24" />
                <stop offset="1" stopColor="#1f9bd6" stopOpacity="0" />
              </radialGradient>
              {Object.entries(STAR).map(([c, col]) => (
                <radialGradient key={c} id={`${uid}-halo-${c}`}>
                  <stop offset="0" stopColor={col} stopOpacity="0.7" />
                  <stop offset="0.35" stopColor={col} stopOpacity="0.22" />
                  <stop offset="1" stopColor={col} stopOpacity="0" />
                </radialGradient>
              ))}
              {edges.map((e) => {
                const a = byId.get(e.a)
                const b = byId.get(e.b)
                if (!a || !b) return null
                return (
                  <linearGradient
                    key={`${e.a}|${e.b}`}
                    id={`${uid}-e-${e.a}-${e.b}`}
                    gradientUnits="userSpaceOnUse"
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                  >
                    <stop offset="0" stopColor={STAR[a.category] ?? STAR.topic} />
                    <stop offset="1" stopColor={STAR[b.category] ?? STAR.topic} />
                  </linearGradient>
                )
              })}
            </defs>
            <rect width={W} height={H} fill={`url(#${uid}-sky)`} />
            <ellipse cx={W * 0.25} cy={H * 0.3} rx={300} ry={190} fill={`url(#${uid}-neb1)`} />
            <ellipse cx={W * 0.78} cy={H * 0.72} rx={320} ry={200} fill={`url(#${uid}-neb2)`} />
            {dust.map((d, i) => (
              <circle
                key={i}
                cx={d.x}
                cy={d.y}
                r={d.r}
                fill="#dfe6ff"
                className="nm-twinkle"
                style={{ animationDelay: `${d.delay}s`, animationDuration: `${d.dur}s` }}
                opacity={d.o}
              />
            ))}
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
                  stroke={`url(#${uid}-e-${e.a}-${e.b})`}
                  strokeLinecap="round"
                  strokeWidth={(hover && on ? 1.6 : 0.8) + Math.min(e.weight, 4) * 0.3}
                  opacity={on ? (hover ? 0.95 : 0.4) : 0.06}
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
                <circle
                  r={n.r * (hover === n.id ? 4.4 : 3.3)}
                  fill={`url(#${uid}-halo-${n.category})`}
                  className="nm-twinkle"
                  style={{
                    animationDelay: `${(hash(n.id) % 50) / 10}s`,
                    animationDuration: `${3 + (hash(n.id) % 30) / 10}s`
                  }}
                />
                <Shape cat={n.category} r={n.r} stroke="#0a0e2c" strokeWidth={0.8} />
                <circle r={Math.max(1.6, n.r * 0.22)} fill="#fff" opacity={0.92} />
                {(labelTop.has(n.id) ||
                  hover === n.id ||
                  (hover && neighbors.get(hover)?.has(n.id))) && (
                  <text
                    y={n.r + 15}
                    textAnchor="middle"
                    fontSize={12}
                    fontWeight={hover === n.id ? 650 : 500}
                    fill="#eef0ff"
                    stroke="#0a0e2c"
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
