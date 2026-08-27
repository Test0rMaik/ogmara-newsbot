/**
 * Strip terminal control sequences from text before printing it.
 *
 * Anything derived from a feed, AI output, or a downloaded image's filename
 * can carry ANSI escapes. That matters more here than in most CLIs: dry-run
 * review is this project's stated primary safety control, and an attacker
 * who can repaint the pane could show the operator a benign post while a
 * different one is what publishes — the same reasoning applies to any other
 * feed-derived text reaching a terminal or log (e.g. `pipeline.ts`'s
 * image-skip warning), not just the dry-run render. Removes C0/C1 controls
 * (keeping \n and \t) and CSI/OSC sequences.
 * (Audit 2026-08-26, SEC-W7; reused beyond index.ts as of the security audit
 * in 0.11.0, which is why this lives in its own module rather than index.ts.)
 */
export function stripControlSequences(text: string): string {
  return (
    text
      // OSC: ESC ] ... terminated by BEL or ST (ESC \\)
      .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, '')
      // CSI and other ESC-introduced sequences
      .replace(/\u001B[@-_][0-?]*[ -/]*[@-~]?/g, '')
      // Bare C0 controls except \t and \n, plus DEL and the C1 range
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
  );
}
