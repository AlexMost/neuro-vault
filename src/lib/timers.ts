/** The timer seam: production passes the globals, tests a fake. Shared by the daemon and the vault entries. */
export interface Timers {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}
