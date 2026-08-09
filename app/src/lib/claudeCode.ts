/*
 * "Open in Claude Code" — the claude-cli:// deep link.
 *
 * Claude Code registers claude-cli:// with the operating system the same way an email
 * client registers mailto:, so following one of these links opens a NEW TERMINAL WINDOW
 * on the machine that clicked it, with Claude Code running and `q` already typed into
 * the prompt box. It is not sent: the user reads it and presses Enter. Nothing about
 * this executes on the server, and nothing reaches the model until that keypress.
 *
 * Three limits of the scheme, all of which shape the code below:
 *
 *   1. `q` is capped at 5,000 characters and the handler truncates silently past that.
 *      Truncating here instead, with an ellipsis, means a long ticket produces a prompt
 *      that visibly stops rather than one that appears whole and isn't.
 *
 *   2. If Claude Code isn't installed the link does nothing AT ALL — no error, no
 *      navigation, no event to catch, so there is no way to detect it from the page.
 *      The prompt is copied to the clipboard first for exactly that case: a dead click
 *      still leaves the caller able to say "paste it", which is a recoverable outcome.
 *
 *   3. Without `cwd` the session opens in the user's home directory. Passing one is a
 *      per-machine absolute path, so it is deliberately the caller's business and not
 *      hardcoded here — a path that is right for one person is wrong for everyone else.
 *
 * This is claude-cli://, NOT claude://. The latter is Claude Desktop — a different app,
 * a different scheme, and not what "Open in Claude Code" means.
 */

/** The scheme's own ceiling on `q`. Past this the handler cuts the prompt silently. */
export const CLAUDE_PROMPT_MAX = 5000

export interface ClaudeCodeTarget {
  /** Absolute path to open in. Omitted means the user's home directory. */
  cwd?: string
}

/**
 * Open Claude Code with `prompt` pre-filled, and leave it on the clipboard.
 *
 * Returns true if the prompt had to be shortened to fit, so the caller can say so.
 */
export function openInClaudeCode(prompt: string, target: ClaudeCodeTarget = {}): boolean {
  const truncated = prompt.length > CLAUDE_PROMPT_MAX
  const q = truncated ? prompt.slice(0, CLAUDE_PROMPT_MAX - 1) + '…' : prompt

  // Best-effort: the clipboard is the fallback for an uninstalled handler, not the
  // point of the click, so a refusal here must not stop the link from being followed.
  navigator.clipboard?.writeText(q)?.catch(() => {})

  const params = new URLSearchParams({ q })
  if (target.cwd) params.set('cwd', target.cwd)

  // Assigning location is what hands the URL to the OS. An unregistered scheme leaves
  // the page exactly where it is, so there is nothing to restore on failure.
  window.location.href = 'claude-cli://open?' + params.toString()

  return truncated
}
