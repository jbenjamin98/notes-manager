/** A recurring meeting's identity: its title without dates, numbers and weekday/month words. */
export function seriesKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\d{0,2}\b/g, ' ')
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/g, ' ')
    .replace(/\b\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,4})?\b/g, ' ')
    .replace(/[\d()#:]+/g, ' ')
    .replace(/[^a-z\s/&-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
