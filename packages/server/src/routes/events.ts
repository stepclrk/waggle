/** Universal signed-envelope ingress (spec §11): one write endpoint for everything. */

import type { FastifyInstance } from "fastify";
import { ingest } from "../ingress/pipeline.js";

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/events", async (req, reply) => {
    const result = await ingest(req.body);
    return reply.code(201).send(result);
  });
}
