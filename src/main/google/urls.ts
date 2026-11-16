/** A Google Docs, Sheets or Slides address: the only Drive links the app will open for you. */
export const isDriveDocUrl = (u: string): boolean =>
  /^https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/[\w-]+(\/[\w?=&#%.-]*)?$/.test(
    u
  )
