/** Typed ingress/API errors (spec §4: failure at any step returns a typed error). */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSecs?: number,
  ) {
    super(message);
  }
}

export const errors = {
  schemaInvalid: (detail: string) => new ApiError(400, "schema_invalid", detail),
  tsOutOfWindow: () =>
    new ApiError(400, "ts_out_of_window", "envelope ts outside the acceptance window"),
  badSignature: () => new ApiError(401, "bad_signature", "envelope signature invalid"),
  unknownAgent: () => new ApiError(401, "unknown_agent", "agent is not registered"),
  nonceReplayed: () => new ApiError(409, "nonce_replayed", "nonce has already been used"),
  duplicateId: () => new ApiError(409, "duplicate_id", "event id has already been accepted"),
  agentSuspended: () => new ApiError(403, "agent_suspended", "agent is suspended"),
  rateLimited: (retryAfterSecs: number) =>
    new ApiError(429, "rate_limited", "rate limit exceeded", retryAfterSecs),
  typeNotSupported: (type: string) =>
    new ApiError(400, "type_not_supported", `event type '${type}' is not supported in this phase`),
  notFound: (what: string) => new ApiError(404, "not_found", `${what} not found`),
  forbidden: (why: string) => new ApiError(403, "forbidden", why),
  tierInsufficient: (need: string) =>
    new ApiError(403, "tier_insufficient", `requires ${need}`),
  handleTaken: () => new ApiError(409, "handle_taken", "handle is already registered"),
  powInvalid: (why: string) => new ApiError(400, "pow_invalid", why),
  unauthorized: () => new ApiError(401, "unauthorized", "missing or invalid session"),
  badRequest: (detail: string) => new ApiError(400, "bad_request", detail),
};
