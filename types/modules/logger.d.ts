/**
 * Sets the logger for the application.
 * Will set a new logger when the application configuration changes.
 * @param logger The logger object.
 */
export function setLogger(logger: Logger): void;
export let logger: Logger;

interface LogEvent {
  /** A message describing the event. */
  message: string;
  /** An 'Error' object if one is present. */
  error?: Error;
  /** An object containing additional context for the event. */
  params?: unknown;
}

type Logger = Readonly<{
  /**
   * Log a debug event.
   * @param event The log event.
   */
  debug(event: LogEvent): void;
  /**
   * Log an info event.
   * @param event The log event.
   */
  info(event: LogEvent): void;
  /**
   * Log a warning event.
   * @param event The log event.
   */
  warn(event: LogEvent): void;
  /**
   * Log an error event.
   * @param event The log event.
   */
  error(event: LogEvent): void;
}>;
