/** The calendar event shape shared by every source (the Apps Script bridge and the Google API). */
export type EventKind = 'meeting' | 'working_location' | 'task' | 'allday'
export type RsvpStatus = 'accepted' | 'declined' | 'tentative' | 'needs_action'

export interface CalEvent {
  id: string
  /** YYYY-MM-DD in the calendar's own timezone. */
  date: string
  /** HH:mm (24h), null for all-day. */
  startTime: string | null
  endTime: string | null
  allDay: boolean
  title: string
  status: RsvpStatus | null
  kind: EventKind
}
