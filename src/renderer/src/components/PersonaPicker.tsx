import { useEffect, useState } from 'react'
import { PERSONAS, PERSONA_IDS, type PersonaId } from '@shared/personas'
import { usePersona } from '../aiMode'
import PersonaAvatar from './PersonaAvatar'

/** Choose who you are talking to, and whether they message you first. */
export default function PersonaPicker(): React.JSX.Element {
  const [persona, setPersona] = usePersona()
  const [proactive, setProactive] = useState(true)

  useEffect(() => {
    void window.api
      .invoke('settings:get')
      .then((r) => r.ok && setProactive(r.data.assistant.proactive))
  }, [])

  const saveProactive = async (on: boolean): Promise<void> => {
    setProactive(on)
    const cur = await window.api.invoke('settings:get')
    if (cur.ok)
      await window.api.invoke('settings:update', {
        assistant: { ...cur.data.assistant, proactive: on }
      })
  }

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Assistant personality"
        className="grid grid-cols-2 gap-3 sm:grid-cols-4"
      >
        {PERSONA_IDS.map((id: PersonaId) => {
          const p = PERSONAS[id]
          const on = id === persona
          return (
            <button
              key={id}
              role="radio"
              aria-checked={on}
              onClick={() => void setPersona(id)}
              className={`flex flex-col items-center gap-2 rounded-2xl border p-3 text-center transition-all ${
                on
                  ? 'border-[var(--accent)] bg-accent-soft shadow-sm'
                  : 'border-line bg-surface hover:bg-hover'
              }`}
            >
              <PersonaAvatar id={id} size={56} />
              <span className="text-sm font-semibold">{p.name}</span>
              <span className="text-xs leading-snug text-muted">{p.tagline}</span>
            </button>
          )
        })}
      </div>
      <p className="mt-3 rounded-xl border border-line bg-surface px-3 py-2 text-sm">
        <span className="text-xs text-muted">{PERSONAS[persona].name} would say: </span>“
        {PERSONAS[persona].say.pre
          .replace('{title}', 'NextMRO Weekly')
          .replace('{mins}', '10')
          .replace('{prep}', '2 items still open from last time.')}
        ”
      </p>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={proactive}
          onChange={(e) => void saveProactive(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
        />
        <span>
          Let {PERSONAS[persona].name} message me first
          <span className="block text-xs text-muted">
            A morning brief, a heads-up before meetings, overdue work, replies you owe, and an
            end-of-day wrap-up. These cost no AI tokens.
          </span>
        </span>
      </label>
    </div>
  )
}
