/**
 * Cron scheduling.
 *
 * Wraps `croner` so the rest of the bot never touches the scheduling library
 * directly, and so an invalid cron expression is caught at config-validation
 * time rather than at the first tick — an unattended bot that dies six hours in
 * because of a typo is much worse than one that refuses to start.
 */

import { Cron } from 'croner';

/** A running scheduled job. */
export interface ScheduledJob {
  /** Stop the job. Safe to call more than once. */
  stop(): void;
  /** Next scheduled run, or null if there is none. */
  nextRun(): Date | null;
}

/** Whether a cron expression is valid. */
export function isValidCron(expression: string): boolean {
  try {
    // Constructed without a handler so it never fires; this is purely a parse
    // check. `croner` throws on malformed patterns.
    const probe = new Cron(expression, { paused: true });
    probe.stop();
    return true;
  } catch {
    return false;
  }
}

/** Options for {@link schedule}. */
export interface ScheduleOptions {
  /** IANA timezone, e.g. "Europe/Berlin". Defaults to the system zone. */
  timezone?: string;
}

/**
 * Run `task` on a cron schedule.
 *
 * Overlapping runs are prevented: if a tick arrives while the previous run is
 * still going, it is skipped rather than queued. A slow feed poll must not be
 * able to stack up concurrent runs that then race on the ledger.
 *
 * A task that throws is caught and reported — one bad run should never kill
 * the schedule.
 */
export function schedule(
  expression: string,
  task: () => Promise<void>,
  options: ScheduleOptions = {},
): ScheduledJob {
  let running = false;

  const job = new Cron(
    expression,
    { ...(options.timezone !== undefined ? { timezone: options.timezone } : {}) },
    () => {
      if (running) {
        console.warn('  previous run still in progress — skipping this tick');
        return;
      }
      running = true;
      // Promise.resolve().then(task) rather than task(): a synchronous throw
      // from task() would escape before .finally attached and leave `running`
      // stuck true forever — a silent permanent stop. Latent today (the caller
      // is async) but a whole class of bug removed for free.
      void Promise.resolve()
        .then(task)
        .catch((err: unknown) => {
          console.error('  scheduled run failed:', err instanceof Error ? err.message : err);
        })
        .finally(() => {
          running = false;
        });
    },
  );

  return {
    stop: (): void => {
      job.stop();
    },
    nextRun: (): Date | null => job.nextRun(),
  };
}
