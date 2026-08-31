export namespace emptyLogger {
  export { empty as info };
  export { empty as debug };
  export { empty as warn };
  export { empty as error };
  export { empty as log };
}
/**
 * Generates a new correlation id to be used for message publication, or returns the correlation id from the options if one already exists.
 * @param options The options object for publishing a message.
 * @returns The correlation id.
 */
export function getCorrelationId(options: { correlationId?: string }): string;
declare function empty(): void;
export declare function timeoutPromise(timer: number): Promise<void>;
/**
 * Resolves with `promise`, or rejects once `timeoutMs` elapses - whichever happens first.
 * @param what Described in the timeout error message.
 */
export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T>;
export {};
