/**
 * The stable event identifier an unreachable database is reported under.
 *
 * Fixed, and carrying nothing from the error it describes. A connection failure's own
 * message names the host, the port and the database, quotes the statement that failed,
 * and its stack maps out this application; a log line is read by everyone who can read
 * the log, is captured verbatim by log shipping and outlives the incident. The
 * identifier is what makes the outage searchable and countable, which is exactly what
 * was missing while these failures were being reported to callers as expired sessions
 * and as internal errors.
 */
export const DATABASE_UNAVAILABLE_EVENT = 'GF-DATABASE-UNAVAILABLE';

/**
 * The Prisma error codes that mean "the database could not be reached or opened", as
 * opposed to "the query was refused" or "the row is not there".
 *
 * A closed set, taken from Prisma's own documented `P1xxx` initialisation range:
 * P1000 authentication against the database failed, P1001 the server is unreachable,
 * P1002 the connection timed out, P1008 an operation timed out, P1010 access denied,
 * P1011 TLS could not be established, P1017 the server closed the connection.
 */
const DATABASE_UNAVAILABLE_ERROR_CODES = [
  'P1000',
  'P1001',
  'P1002',
  'P1008',
  'P1010',
  'P1011',
  'P1017'
];

/**
 * Whether a caught error describes an unreachable database rather than a rejected
 * caller or a rejected query.
 *
 * The distinction earns its own function because two endpoints answer very
 * differently once they can make it: an authenticated request becomes a retryable 503
 * with the session intact instead of a 401 that discards a valid credential, and the
 * public bootstrap endpoint becomes a 503 instead of a 500 whose default handling
 * prints the whole Prisma failure - statement, host and port included - into the log.
 *
 * Recognised by Prisma's own error CODE, and by the constructor name of the
 * initialisation error it raises when the client cannot connect at all, since a client
 * that never connected has no code to report. Neither the message nor the stack is
 * read, so the classification cannot be influenced by anything a request supplied and
 * nothing from the error can leak into a log line.
 */
export function isDatabaseUnavailableError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;

  if (
    typeof code === 'string' &&
    DATABASE_UNAVAILABLE_ERROR_CODES.includes(code)
  ) {
    return true;
  }

  return (
    (error as { name?: unknown })?.name === 'PrismaClientInitializationError'
  );
}
