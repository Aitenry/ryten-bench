/**
 * Turn guard for stream events.
 *
 * Background: when stream events (chunk / done / error) carry only a topic id, two
 * rounds of stream events on the same topic are all accepted by the same listener —
 * late events from the previous round, or in extreme cases a concurrent other round,
 * get written into the current bubble, showing up as "garbled output" or "ending
 * abruptly while still running".
 *
 * Usage: create one guard per stream listener and pass in the turn id of every event
 * it receives; events for which it returns false are dropped.
 *  - Turn id known at creation time (rounds initiated by the main process; the marker
 *    chunk carries it): accept only that round;
 *  - Unknown at creation time (local send, id assigned by the main process): lock onto
 *    the **first event that arrives**;
 *  - Event carries no turn id (older main process): always allow, fall back to
 *    per-topic handling.
 */

export type TurnGuard = (eventTurnId?: number | null) => boolean

export function createTurnGuard(expectedTurnId?: number | null): TurnGuard {
  let locked: number | null = expectedTurnId ?? null
  return (eventTurnId?: number | null): boolean => {
    if (eventTurnId == null) return true
    if (locked == null) {
      locked = eventTurnId
      return true
    }
    return locked === eventTurnId
  }
}
