const RESUME_MAX_CHARS = 4000
const RESUME_HEAD_CHARS = 300
const RESUME_TAIL_CHARS = 2000

export function compactResume(text: string): string {
  if (text.length <= RESUME_MAX_CHARS) return text
  return `${text.slice(0, RESUME_HEAD_CHARS)}\n\n[...earlier reasoning abbreviated — re-derive key conclusions if needed...]\n\n${text.slice(-RESUME_TAIL_CHARS)}`
}

export function stripOverlap(existing: string, incoming: string, maxWindow = 2000): string {
  const a = existing.slice(-maxWindow)
  const b = incoming.slice(0, maxWindow)
  const max = Math.min(a.length, b.length)
  let best = 0
  for (let len = 1; len <= max; len++) {
    if (a.slice(a.length - len) === b.slice(0, len)) best = len
  }
  return incoming.slice(best)
}

export * as Resume from "./resume"
