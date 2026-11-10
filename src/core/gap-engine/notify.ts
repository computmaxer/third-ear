/** A failing UI listener must never stop the meeting's analysis. */
export function notifySafely<T>(listener: (value: T) => void, value: T): void {
  try {
    listener(value);
  } catch {
    // Listener errors are the listener's concern; the engine keeps running.
  }
}
