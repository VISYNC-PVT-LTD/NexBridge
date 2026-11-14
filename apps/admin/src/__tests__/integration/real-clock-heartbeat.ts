import mongoose from 'mongoose';

/**
 * Keep Mongoose's stale-connection check on ONE clock while tests fake `Date`.
 *
 * Mongoose 8 reports `connection.readyState === 0` when the last server
 * heartbeat is older than 2 × heartbeatFrequencyMS. Under Jest fake timers the
 * heartbeat listener stamps `_lastHeartbeatAt` with the FAKE `Date` (e.g. a
 * March 2026 test date) while the `readyState` getter compares it against the
 * real clock, so a heartbeat landing inside a fake-clock test makes a healthy
 * connection look months stale. The test-DB guard in jest.setup.ts then
 * (correctly) refuses `connectDB()`, and because the stale stamp survives until
 * the next real heartbeat (≤10 s) the failure can leak into the following test.
 * Whether a heartbeat lands in that window depends on timing, which made the
 * real-DB suites fail intermittently.
 *
 * This re-stamps each heartbeat from the un-faked clock (`performance` is in
 * every suite's `doNotFake` list), so the heuristic keeps working — a really
 * silent server is still reported as disconnected. Call once, right after
 * `mongoose.connect()`, so this listener runs after Mongoose's own.
 */
export function stampHeartbeatsWithRealClock(conn: mongoose.Connection = mongoose.connection): void {
  const realNow = () => performance.timeOrigin + performance.now();
  conn.getClient().on('serverHeartbeatSucceeded', () => {
    (conn as unknown as { _lastHeartbeatAt: number | null })._lastHeartbeatAt = realNow();
  });
}
