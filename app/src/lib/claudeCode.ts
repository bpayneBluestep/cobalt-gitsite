/*
 * "Open in Claude Code" — a claude:// deep link into Claude Desktop.
 *
 * Following one of these hands the URL to the OS, which launches Claude Desktop (or
 * focuses it if already running) and opens its Claude Code area with `q` already typed
 * into the composer. It is NOT sent: the user reads it and presses Enter. Nothing here
 * executes on the server, and nothing reaches a model until that keypress.
 *
 * There are TWO schemes and they are not interchangeable — this is the trap worth
 * remembering if the target ever changes again:
 *
 *   claude://code/new    Claude Desktop's Code area.  directory key: `folder`   ~14,000 chars
 *   claude-cli://open    a new TERMINAL window.       directory key: `cwd`        5,000 chars
 *
 * Same idea, different prefix, different parameter name for the working directory, and
 * a very different budget for the prompt. Swapping only the prefix silently drops the
 * directory. Both are kept in SCHEMES so that stays visible rather than folded away.
 *
 * Cobalt targets DESKTOP because that is what the team uses; the terminal entry exists
 * so switching back is one argument, not a rewrite.
 *
 * Two more limits, both shaping the code below:
 *
 *   * Past the cap the handler truncates SILENTLY. Truncating here with an ellipsis
 *     means a long ticket produces a prompt that visibly stops rather than one that
 *     looks whole and isn't.
 *
 *   * If Claude Desktop isn't installed the link does nothing AT ALL — no error, no
 *     navigation, no event to catch, so the page cannot detect it. The prompt is copied
 *     to the clipboard first for exactly that case: a dead click still leaves the user
 *     able to paste, which is recoverable.
 *
 * A `folder` is treated as untrusted by Claude Desktop, which always shows a
 * confirmation dialog before adopting it. That is expected, not a failure.
 */

export type ClaudeTarget = 'desktop' | 'terminal'

const SCHEMES = {
  desktop: { url: 'claude://code/new', dirKey: 'folder', max: 14000 },
  terminal: { url: 'claude-cli://open', dirKey: 'cwd', max: 5000 },
} as const

/** The prompt ceiling for a target, so callers can budget before building one. */
export const promptMax = (target: ClaudeTarget = 'desktop'): number => SCHEMES[target].max

/**
 * Open Claude Code with `prompt` pre-filled, and leave it on the clipboard.
 *
 * `dir` is an absolute path to open in; omitted, the session starts wherever Claude
 * Desktop last was. It is deliberately not defaulted here — a path that is right for
 * one person is wrong for everyone else.
 *
 * Returns true if the prompt had to be shortened, so the caller can say so.
 */
export function openInClaudeCode(
  prompt: string,
  opts: { target?: ClaudeTarget; dir?: string } = {},
): boolean {
  const scheme = SCHEMES[opts.target || 'desktop']
  const truncated = prompt.length > scheme.max
  const q = truncated ? prompt.slice(0, scheme.max - 1) + '…' : prompt

  // Best-effort: the clipboard is the fallback for a missing handler, not the point of
  // the click, so a refusal here must not stop the link from being followed.
  navigator.clipboard?.writeText(q)?.catch(() => {})

  const params = new URLSearchParams({ q })
  if (opts.dir) params.set(scheme.dirKey, opts.dir)

  // Assigning location is what hands the URL to the OS. An unregistered scheme leaves
  // the page exactly where it is, so there is nothing to restore on failure.
  window.location.href = `${scheme.url}?${params.toString()}`

  return truncated
}
