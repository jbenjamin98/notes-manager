import { useEffect, useId, useRef, useState } from 'react'
import { PERSONAS, type PersonaId } from '@shared/personas'
import { pickQuirk, type Mood, type Quirk } from '@shared/avatarMood'

/**
 * The assistants, drawn as illustrated people in the app's own palette. No image files: they scale
 * crisply. In `live` mode they are alive: they breathe, blink at random, follow your pointer with
 * their eyes, change expression with what is happening (listening, thinking, talking, pleased,
 * concerned, surprised, sleepy) and each has a signature move. All motion respects reduced-motion.
 */
interface Look {
  skin: string
  skinShade: string
  hair: string
  shirt: string
  lip: string
  bg: [string, string]
}

const LOOK: Record<PersonaId, Look> = {
  nova: {
    skin: '#e9bd9a',
    skinShade: '#d9a582',
    hair: '#2a2230',
    shirt: '#4f46e5',
    lip: '#b4544a',
    bg: ['#c7d2fe', '#a78bfa']
  },
  pip: {
    skin: '#f3cba8',
    skinShade: '#e2b18a',
    hair: '#b4532a',
    shirt: '#f59e0b',
    lip: '#b4544a',
    bg: ['#fde68a', '#f9a8d4']
  },
  sage: {
    skin: '#d8a67c',
    skinShade: '#c48c63',
    hair: '#d3d6dc',
    shirt: '#0f766e',
    lip: '#a24a40',
    bg: ['#a7f3d0', '#6ee7b7']
  },
  rook: {
    skin: '#8f5d3d',
    skinShade: '#7a4b2f',
    hair: '#17171b',
    shirt: '#334155',
    lip: '#5a2e22',
    bg: ['#cbd5e1', '#94a3b8']
  }
}

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** Where the eyes look (in face units), following the pointer while it moves. */
function usePointerGaze(ref: React.RefObject<SVGSVGElement | null>, on: boolean): [number, number] {
  const [gaze, setGaze] = useState<[number, number]>([0, 0])
  useEffect(() => {
    if (!on || reducedMotion()) return
    let raf = 0
    let last: PointerEvent | null = null
    const apply = (): void => {
      raf = 0
      const el = ref.current
      if (!el || !last) return
      const r = el.getBoundingClientRect()
      const dx = last.clientX - (r.left + r.width / 2)
      const dy = last.clientY - (r.top + r.height * 0.45)
      const d = Math.hypot(dx, dy) || 1
      const reach = clamp(d / 220, 0, 1) // close to the face = small move
      setGaze([(dx / d) * 1.6 * reach, (dy / d) * 1.3 * reach])
    }
    const move = (e: PointerEvent): void => {
      last = e
      if (!raf) raf = requestAnimationFrame(apply)
    }
    const leave = (): void => setGaze([0, 0])
    window.addEventListener('pointermove', move)
    document.addEventListener('pointerleave', leave)
    return () => {
      window.removeEventListener('pointermove', move)
      document.removeEventListener('pointerleave', leave)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [ref, on])
  return gaze
}

/** Natural blinking: every 2-6 s, sometimes twice. */
function useBlink(on: boolean, double: boolean): boolean {
  const [closed, setClosed] = useState(false)
  useEffect(() => {
    if (!on || reducedMotion()) return
    let t: ReturnType<typeof setTimeout>
    const blink = (times: number): void => {
      setClosed(true)
      t = setTimeout(() => {
        setClosed(false)
        if (times > 1) t = setTimeout(() => blink(times - 1), 160)
        else t = setTimeout(() => blink(Math.random() < 0.18 ? 2 : 1), 2000 + Math.random() * 4000)
      }, 120)
    }
    t = setTimeout(() => blink(1), 1200 + Math.random() * 2000)
    return () => clearTimeout(t)
  }, [on])
  // A requested double blink (a quirk) plays on top.
  const [extra, setExtra] = useState(false)
  useEffect(() => {
    if (!double) return
    const a = setTimeout(() => setExtra(true), 0)
    const b = setTimeout(() => setExtra(false), 120)
    const c = setTimeout(() => setExtra(true), 280)
    const d = setTimeout(() => setExtra(false), 400)
    return () => [a, b, c, d].forEach(clearTimeout)
  }, [double])
  return closed || extra
}

/** Plays one little move now and then, each with its own cool-down. */
function useQuirks(on: boolean, mood: Mood): Quirk | null {
  const [quirk, setQuirk] = useState<Quirk | null>(null)
  const last = useRef<Partial<Record<Quirk, number>>>({})
  const moodRef = useRef(mood)
  useEffect(() => {
    moodRef.current = mood
  }, [mood])
  useEffect(() => {
    if (!on || reducedMotion()) return
    let t: ReturnType<typeof setTimeout>
    const schedule = (): void => {
      t = setTimeout(
        () => {
          const now = Date.now()
          const q = pickQuirk(moodRef.current, last.current, now)
          if (q) {
            last.current[q] = now
            setQuirk(q)
            t = setTimeout(() => {
              setQuirk(null)
              schedule()
            }, QUIRK_MS[q])
          } else schedule()
        },
        3500 + Math.random() * 5000
      )
    }
    schedule()
    return () => clearTimeout(t)
  }, [on])
  return quirk
}

const QUIRK_MS: Record<Quirk, number> = {
  wink: 650,
  glance: 1300,
  signature: 1400,
  'double-blink': 500
}

/** Mouth shapes centred under the nose. */
function Mouth({ mood, id, l }: { mood: Mood; id: PersonaId; l: Look }): React.JSX.Element {
  const line = { fill: 'none', stroke: l.lip, strokeWidth: 1.5, strokeLinecap: 'round' as const }
  if (mood === 'talking')
    return (
      <g className="av-talk">
        <ellipse cx="32" cy="41.6" rx="2.9" ry="2" fill="#5b2a26" />
        <ellipse cx="32" cy="42.6" rx="1.6" ry="0.7" fill="#d9706a" />
      </g>
    )
  if (mood === 'surprised') return <ellipse cx="32" cy="42" rx="1.9" ry="2.3" fill="#5b2a26" />
  if (mood === 'sleepy' || mood === 'waking')
    return (
      <ellipse
        className={mood === 'waking' ? 'av-yawn' : ''}
        cx="32"
        cy="42"
        rx="1.6"
        ry="1.2"
        fill="#5b2a26"
      />
    )
  if (mood === 'concerned') return <path d="M28 43 q4 -2.4 8 0" {...line} />
  if (mood === 'thinking') return <path d="M29.5 42 q2.5 0.9 5.5 -0.8" {...line} />
  if (mood === 'happy')
    return (
      <path
        d="M26.5 40 q5.5 6.2 11 0 Z"
        fill="#fff"
        stroke={l.lip}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    )
  // Resting expressions carry the personality.
  if (id === 'pip')
    return (
      <path
        d="M26.5 40 q5.5 6 11 0 Z"
        fill="#fff"
        stroke={l.lip}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    )
  if (id === 'rook') return <path d="M27.5 41.5 q4.5 1.6 9 -0.9" {...line} />
  if (id === 'sage') return <path d="M27 41.5 q5 2 10 0" {...line} />
  return <path d="M27.5 41 q4.5 3.2 9 0" {...line} />
}

export default function PersonaAvatar({
  id,
  size = 36,
  thinking = false,
  mood: moodProp,
  live = false,
  className = ''
}: {
  id: PersonaId
  size?: number
  /** Static mode: a gentle bob while waiting. */
  thinking?: boolean
  /** Live mode: the expression to show. */
  mood?: Mood
  /** Breathing, blinking, pointer-following eyes, moods and little surprises. */
  live?: boolean
  className?: string
}): React.JSX.Element {
  const uid = useId().replace(/:/g, '')
  const p = PERSONAS[id]
  const l = LOOK[id]
  const svg = useRef<SVGSVGElement>(null)
  const mood: Mood = moodProp ?? (thinking ? 'thinking' : 'idle')
  const quirk = useQuirks(live, mood)
  const pointer = usePointerGaze(svg, live)
  const blinking = useBlink(live, quirk === 'double-blink')

  // Where the eyes point: the pointer, unless the mood or a quirk says otherwise.
  const gaze: [number, number] =
    mood === 'thinking'
      ? [-1.3, -1.5]
      : mood === 'sleepy'
        ? [0, 0.8]
        : quirk === 'glance'
          ? [1.5, -0.4]
          : mood === 'talking' || mood === 'surprised'
            ? [pointer[0] * 0.4, pointer[1] * 0.4]
            : pointer

  // Brows: [left dy, right dy, left tilt, right tilt]
  const browMove: [number, number, number, number] =
    mood === 'surprised'
      ? [-2.2, -2.2, 0, 0]
      : mood === 'listening'
        ? [-1.1, -1.1, 0, 0]
        : mood === 'concerned'
          ? [-0.6, -0.6, -9, 9]
          : mood === 'thinking'
            ? [-1.6, 0.2, 0, 0]
            : mood === 'happy'
              ? [-0.7, -0.7, 0, 0]
              : mood === 'sleepy'
                ? [0.6, 0.6, 0, 0]
                : id === 'rook' && quirk === 'signature'
                  ? [0, -2, 0, -8]
                  : [0, 0, 0, 0]

  const eyeY = id === 'rook' ? 31.5 : 31
  const lid = blinking ? 0.1 : mood === 'sleepy' ? 0.35 : mood === 'surprised' ? 1.2 : 1
  const happyEyes = live && mood === 'happy'
  const eye = (cx: number, side: 'l' | 'r'): React.JSX.Element => {
    const winking = quirk === 'wink' && side === 'r'
    if (happyEyes || winking)
      return (
        <path
          d={`M${cx - 2.2} ${eyeY + 0.6} q2.2 -2.6 4.4 0`}
          fill="none"
          stroke="#2a1f1a"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      )
    return (
      <g
        className={live ? 'av-eye' : 'avatar-eye'}
        style={live ? { transform: `scaleY(${lid})` } : undefined}
      >
        <ellipse cx={cx} cy={eyeY} rx="2.6" ry="2.9" fill="#fff" opacity={live ? 0.9 : 0} />
        <g
          className="av-pupil"
          style={live ? { transform: `translate(${gaze[0]}px, ${gaze[1]}px)` } : undefined}
        >
          <ellipse cx={cx} cy={eyeY} rx="1.9" ry="2.3" fill="#2a1f1a" />
          <circle cx={cx + 0.6} cy={eyeY - 0.8} r="0.6" fill="#fff" />
        </g>
      </g>
    )
  }
  const brow = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    side: 'l' | 'r',
    w = 1.3
  ): React.JSX.Element => {
    const [dy, tilt] = side === 'l' ? [browMove[0], browMove[2]] : [browMove[1], browMove[3]]
    return (
      <line
        className="av-brow"
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={l.hair}
        strokeWidth={w}
        strokeLinecap="round"
        style={
          live
            ? {
                transform: `translateY(${dy}px) rotate(${tilt}deg)`,
                transformOrigin: `${(x1 + x2) / 2}px ${(y1 + y2) / 2}px`
              }
            : undefined
        }
      />
    )
  }
  const browW = id === 'rook' ? 1.7 : 1.3
  const brows =
    id === 'nova' ? (
      <>
        {brow(24, 26, 29, 25.5, 'l')}
        {brow(35, 25.5, 40, 26, 'r')}
      </>
    ) : id === 'pip' ? (
      <>
        {brow(23.5, 25.5, 29, 24.5, 'l')}
        {brow(35, 24.5, 40.5, 25.5, 'r')}
      </>
    ) : id === 'sage' ? (
      <>
        {brow(23.5, 25.5, 29.5, 25, 'l')}
        {brow(34.5, 25, 40.5, 25.5, 'r')}
      </>
    ) : (
      <>
        {brow(23.5, 26.5, 29.5, 25, 'l', browW)}
        {brow(34.5, 25, 40.5, 26.5, 'r', browW)}
      </>
    )
  const nose = (
    <path
      d={`M32 ${id === 'sage' ? 34 : 33} q-1.2 4 0.6 4.6`}
      fill="none"
      stroke={l.skinShade}
      strokeWidth="1.1"
      strokeLinecap="round"
    />
  )

  const sig = quirk === 'signature'
  const rootClass = [
    live ? `av-live av-${mood}` : thinking ? 'avatar-think' : '',
    live && sig ? `av-sig-${id}` : '',
    className
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <svg
      ref={svg}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={rootClass}
      role="img"
      aria-label={`${p.name}, your assistant`}
      data-mood={live ? mood : undefined}
    >
      <defs>
        <linearGradient id={`b${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={l.bg[0]} />
          <stop offset="1" stopColor={l.bg[1]} />
        </linearGradient>
        <clipPath id={`c${uid}`}>
          <circle cx="32" cy="32" r="31" />
        </clipPath>
      </defs>
      <g clipPath={`url(#c${uid})`}>
        <rect width="64" height="64" fill={`url(#b${uid})`} />
        {/* Nova's halo sparkle drifts around her */}
        {live && id === 'nova' && (
          <g className="av-orbit">
            <path d="M32 3.5 l1 2.4 2.4 1 -2.4 1 -1 2.4 -1 -2.4 -2.4 -1 2.4 -1Z" fill="#fff" />
          </g>
        )}

        <g className="av-body">
          {/* hair behind the head */}
          {id === 'nova' && (
            <path
              d="M16 34 Q14 12 32 12 Q50 12 48 34 Q48 46 44 50 L20 50 Q16 46 16 34Z"
              fill={l.hair}
            />
          )}
          {id === 'nova' && <circle cx="32" cy="9" r="6.5" fill={l.hair} />}

          {/* shoulders and neck */}
          <path d="M6 66 Q8 49 23 46 L41 46 Q56 49 58 66Z" fill={l.shirt} />
          <path d="M26 46 L32 55 L38 46Z" fill={l.skin} />
          <rect x="27.5" y="38" width="9" height="10" rx="3" fill={l.skinShade} />

          <g className="av-head">
            {/* ears and head */}
            <ellipse cx="19.5" cy="32" rx="2.3" ry="3.4" fill={l.skinShade} />
            <ellipse cx="44.5" cy="32" rx="2.3" ry="3.4" fill={l.skinShade} />
            <ellipse cx="32" cy="30" rx="12.5" ry="14.5" fill={l.skin} />

            {/* hair on top */}
            {id === 'nova' && (
              <path d="M19 31 Q18 15 32 15 Q46 15 45 31 Q43 22 34 21 Q25 22 19 31Z" fill={l.hair} />
            )}
            {id === 'pip' && (
              <g fill={l.hair} className="av-hair">
                <circle cx="22" cy="19" r="6" />
                <circle cx="29" cy="15" r="6.5" />
                <circle cx="37" cy="15" r="6.5" />
                <circle cx="43" cy="20" r="6" />
                <path d="M19 28 Q19 18 32 18 Q45 18 45 28 Q42 22 32 22 Q22 22 19 28Z" />
              </g>
            )}
            {id === 'sage' && (
              <path
                d="M19 30 Q17 14 32 14 Q47 14 45 30 Q44 22 36 20 Q28 19 22 24 Q20 26 19 30Z"
                fill={l.hair}
              />
            )}
            {id === 'rook' && (
              <path
                d="M19.5 29 Q19 15 32 15 Q45 15 44.5 29 Q42 21 32 21 Q22 21 19.5 29Z"
                fill={l.hair}
              />
            )}

            {/* cheeks warm up when pleased */}
            {live && (mood === 'happy' || id === 'pip') && (
              <g fill="#f47c7c" opacity={mood === 'happy' ? 0.35 : 0.18}>
                <ellipse cx="23.5" cy="37" rx="2.4" ry="1.4" />
                <ellipse cx="40.5" cy="37" rx="2.4" ry="1.4" />
              </g>
            )}

            {brows}
            {eye(26.5, 'l')}
            {eye(37.5, 'r')}
            {id === 'pip' && (
              <g fill={l.skinShade}>
                <circle cx="24" cy="36" r="0.7" />
                <circle cx="27" cy="37" r="0.7" />
                <circle cx="37" cy="37" r="0.7" />
                <circle cx="40" cy="36" r="0.7" />
              </g>
            )}
            {id === 'sage' && (
              <g fill="none" stroke="#3f3f46" strokeWidth="1.2" className="av-glasses">
                <rect x="22" y="27.5" width="9" height="7" rx="2.5" />
                <rect x="33" y="27.5" width="9" height="7" rx="2.5" />
                <line x1="31" y1="30.5" x2="33" y2="30.5" />
              </g>
            )}
            {nose}
            <Mouth mood={live ? mood : 'idle'} id={id} l={l} />
            {id === 'sage' && (
              <path
                className="av-beard"
                d="M21.5 34 Q21 47 32 50 Q43 47 42.5 34 Q41 43 32 44 Q23 43 21.5 34Z"
                fill={l.hair}
                opacity="0.9"
              />
            )}
          </g>
        </g>

        {/* thought bubble while thinking; z's while asleep */}
        {live && mood === 'thinking' && (
          <g className="av-bubble" fill="#fff">
            <circle cx="47" cy="17" r="1.3" />
            <circle cx="51" cy="12.5" r="1.8" />
            <g>
              <ellipse cx="55" cy="7" rx="5.5" ry="3.8" />
              <circle className="av-dot" cx="52.6" cy="7" r="0.8" fill="#6b7280" />
              <circle className="av-dot" cx="55" cy="7" r="0.8" fill="#6b7280" />
              <circle className="av-dot" cx="57.4" cy="7" r="0.8" fill="#6b7280" />
            </g>
          </g>
        )}
        {live && mood === 'sleepy' && (
          <g className="av-zzz" fill="#fff" fontWeight="700" fontFamily="system-ui">
            <text x="46" y="18" fontSize="6">
              z
            </text>
            <text x="51" y="12" fontSize="8">
              z
            </text>
          </g>
        )}
        {live && (mood === 'happy' || mood === 'surprised') && (
          <g className="av-sparkles" fill="#fff">
            <path d="M10 14 l0.8 2 2 0.8 -2 0.8 -0.8 2 -0.8 -2 -2 -0.8 2 -0.8Z" />
            <path d="M54 22 l0.6 1.5 1.5 0.6 -1.5 0.6 -0.6 1.5 -0.6 -1.5 -1.5 -0.6 1.5 -0.6Z" />
          </g>
        )}
      </g>
      <circle
        cx="32"
        cy="32"
        r="31"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.5"
        strokeWidth="1.2"
      />
    </svg>
  )
}
