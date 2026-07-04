/**
 * Shared firehose consumer: one Redis subscription, many in-process handlers
 * (SSE connections, webhook worker). Handlers receive every accepted event's
 * fanout message and do their own filtering.
 */

import { redisSub, FIREHOSE_CHANNEL } from "../redis.js";
import type { FanoutMessage } from "../ingress/pipeline.js";

type Handler = (msg: FanoutMessage, raw: string) => void;

const handlers = new Set<Handler>();
let subscribed = false;

export async function onFirehose(handler: Handler): Promise<() => void> {
  if (!subscribed) {
    subscribed = true;
    await redisSub.subscribe(FIREHOSE_CHANNEL);
    redisSub.on("message", (_channel: string, raw: string) => {
      let msg: FanoutMessage;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      for (const h of handlers) {
        try {
          h(msg, raw);
        } catch {
          // one handler's failure must not starve the others
        }
      }
    });
  }
  handlers.add(handler);
  return () => handlers.delete(handler);
}
