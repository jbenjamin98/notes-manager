import type { Db } from '../db'

/** Guests and Meet link for one event, scraped from its detail page and cached in `calendar_events`. */
export interface Guest {
  email: string
  /** Display name if the page showed one (often it doesn't). */
  name: string | null
}

export interface EventDetail {
  guests: Guest[]
  meetUrl: string | null
}

/** Only real Meet room links ever reach the "Join" button. */
export function cleanMeetUrl(href: string | null | undefined): string | null {
  if (!href) return null
  try {
    const u = new URL(href)
    if (u.protocol !== 'https:' || u.hostname !== 'meet.google.com') return null
    const room = u.pathname.split('/')[1] ?? ''
    return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(room) ? `https://meet.google.com/${room}` : null
  } catch {
    return null
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** De-duplicate by email (case-insensitive), drop junk, drop the user's own address. */
export function normalizeGuests(raw: Guest[], selfEmail: string | null): Guest[] {
  const seen = new Map<string, Guest>()
  for (const g of raw) {
    const email = g.email.trim().toLowerCase()
    if (!EMAIL.test(email) || email === selfEmail?.toLowerCase()) continue
    if (/@(group|resource)\.calendar\.google\.com$/.test(email)) continue // rooms / resources
    const name = g.name && !g.name.includes('@') && g.name.length < 80 ? g.name.trim() : null
    const prev = seen.get(email)
    seen.set(email, { email, name: prev?.name ?? name })
  }
  return [...seen.values()]
}

export function saveDetail(db: Db, eventId: string, d: EventDetail): void {
  db.prepare(
    `UPDATE calendar_events SET attendees_json = ?, meet_url = ?, detail_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(JSON.stringify(d.guests), d.meetUrl, eventId)
}

export function loadDetail(
  db: Db,
  eventId: string
): { fetched: boolean; detail: EventDetail } | null {
  const r = db
    .prepare(
      'SELECT attendees_json AS a, meet_url AS m, detail_at AS at FROM calendar_events WHERE id = ?'
    )
    .get(eventId) as { a: string; m: string | null; at: string | null } | undefined
  if (!r) return null
  let guests: Guest[]
  try {
    guests = JSON.parse(r.a || '[]') as Guest[]
  } catch {
    guests = []
  }
  return { fetched: r.at !== null, detail: { guests, meetUrl: r.m } }
}

/** "jane.doe@x.com" -> "Jane Doe": a readable fallback when no display name is known. */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0].replace(/\+.*$/, '')
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}
