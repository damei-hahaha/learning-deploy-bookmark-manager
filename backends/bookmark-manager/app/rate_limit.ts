// Rate limiting. Each call returns a fresh express-rate-limit middleware. We set
// skipFailedRequests so that requests rejected before the handler (e.g. failed
// validation) don't consume a slot.

import rateLimit from "express-rate-limit";
import type { RateLimitRequestHandler } from "express-rate-limit";

import { sendError } from "./exceptions.js";

function limit(maxPerMinute: number): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60 * 1000,
    max: maxPerMinute,
    skipFailedRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    statusCode: 429,
    handler: (_req, res, _next, _options) => {
      sendError(res, 429, "Rate limit exceeded", { code: "too_many_requests" });
    },
  });
}

export { limit };
