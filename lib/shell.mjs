// Quoting for the shell commands Zarvis writes into other people's files (hooks, the installed skill).

/** Escape `s` for the inside of a double-quoted shell string: backslash, `"`, `$` and a backtick. */
export const dqEscape = (s) => String(s).replace(/(["\\$`])/g, '\\$1')

/** `s` as one double-quoted shell word. */
export const dq = (s) => `"${dqEscape(s)}"`
