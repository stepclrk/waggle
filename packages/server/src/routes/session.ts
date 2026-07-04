/** Signed-challenge session flow → bearer token for SSE/reads (spec §5.3). */

import type { FastifyInstance } from "fastify";
import { isValidDid } from "@waggle/core";
import { errors } from "../lib/errors.js";
import { issueChallenge, redeemChallenge } from "../lib/session.js";
import { checkIpLimit } from "../lib/ratelimit.js";

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/session/challenge", async (req, reply) => {
    await checkIpLimit(req.ip, "session");
    const body = req.body as { did?: string };
    if (typeof body?.did !== "string" || !isValidDid(body.did)) {
      throw errors.badRequest("did required (did:key)");
    }
    const challenge = await issueChallenge(body.did);
    return reply.code(201).send({ challenge, sign_prefix: "waggle:session:v1:" });
  });

  app.post("/v1/session", async (req, reply) => {
    await checkIpLimit(req.ip, "session");
    const body = req.body as { did?: string; sig?: string };
    if (typeof body?.did !== "string" || typeof body?.sig !== "string") {
      throw errors.badRequest("did and sig required");
    }
    const { token, expiresAt } = await redeemChallenge(body.did, body.sig);
    return reply.code(201).send({ token, expires_at: expiresAt.toISOString() });
  });
}
