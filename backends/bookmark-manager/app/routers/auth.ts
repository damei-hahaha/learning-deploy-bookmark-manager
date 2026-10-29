// Auth routes

import express from "express";

import prisma from "../database.js";
import {
  getCurrentToken,
  getCurrentUser,
  currentToken,
  currentUser,
  blocklistKey,
} from "../dependencies.js";
import { HttpError, asyncHandler } from "../exceptions.js";
import { limit } from "../rate_limit.js";
import { getRedis } from "../redis_client.js";
import { loginLogPath, makeLogger, makePinoLogger } from "../logging_config.js";
import { validateBody, validatedBody } from "../validate.js";
import { userCreate } from "../schemas/user.js";
import { userPublic, tokenResponse } from "../schemas/serializers.js";
import {
  createAccessToken,
  hashPassword,
  verifyPassword,
} from "../security.js";

const router = express.Router();
const logger = makeLogger("app.routers.auth");
// Login records fields (who, why, status) instead of a sentence. The same line
// goes to stdout and to logs/login.log. The password is never passed in;
// redact on the logger is the backstop if a later edit logs the body.
const loginLog = makePinoLogger("app.routers.auth", { file: loginLogPath }).child({
  route: "POST /auth/token",
});

router.post(
  "/register",
  limit(5),
  validateBody(userCreate),
  asyncHandler(async (req, res) => {
    const { email, username, password } = validatedBody(req, userCreate);

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });
    if (existing) {
      throw new HttpError(400, "A user with that email or username already exists");
    }

    const user = await prisma.user.create({
      data: { email, username, passwordHash: hashPassword(password) },
    });
    logger.info(`Registered new user: ${user.username}`);
    res.status(201).json(userPublic(user));
  })
);

// OAuth2 password flow: the token endpoint reads form-encoded username/password.
router.post(
  "/token",
  limit(15),
  asyncHandler(async (req, res) => {
    // This route deliberately skips validateBody, so the body is whatever the
    // client sent. Reading it as optional fields keeps that honest.
    const body: unknown = req.body ?? {};
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const username = typeof record.username === "string" ? record.username : "";
    const password = typeof record.password === "string" ? record.password : "";
    const credentialsError = new HttpError(
      401,
      "Incorrect username or password",
      { "WWW-Authenticate": "Bearer" },
      { code: "invalid_credentials" }
    );
    if (!username) {
      loginLog.warn({ event: "login_failed", reason: "missing_username", status: 401 });
      throw credentialsError;
    }
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      loginLog.warn({ event: "login_failed", reason: "invalid_credentials", username, status: 401 });
      throw credentialsError;
    }
    if (!user.isActive) {
      loginLog.warn({
        event: "login_failed",
        reason: "inactive_user",
        username: user.username,
        user_id: user.id,
        status: 400,
      });
      throw new HttpError(400, "Inactive user", null, { code: "inactive_user" });
    }

    const token = createAccessToken(user.username);
    loginLog.info({ event: "login_succeeded", username: user.username, user_id: user.id, status: 200 });
    res.json(tokenResponse(token));
  })
);

// Revoke the caller's token by adding its jti to the Redis blocklist.
router.post(
  "/logout",
  getCurrentToken,
  asyncHandler(async (req, res) => {
    const payload = currentToken(req);
    const remaining = Math.floor((payload.exp.getTime() - Date.now()) / 1000);
    if (remaining > 0) {
      await getRedis().setex(blocklistKey(payload.jti), remaining, "1");
    }
    logger.info(`User ${payload.sub} logged out (jti=${payload.jti})`);
    res.status(204).end();
  })
);

router.get(
  "/me",
  getCurrentUser,
  asyncHandler(async (req, res) => {
    res.json(userPublic(currentUser(req)));
  })
);

export default router;
