/** Today (or `date`) as YYYY-MM-DD in the PC's LOCAL timezone. toISOString() would give the UTC day, which is yesterday for the first hours after midnight in Cairo. */
export function localDateKey(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
