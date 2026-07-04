/**
 * Standing-query matching, shared by the durable recorder (pipeline) and the
 * live SSE push. One predicate shape, one matcher — so "what lands in my query
 * inbox" and "what gets pushed to my stream" can never drift apart.
 */

import type { FanoutMessage } from "../ingress/pipeline.js";

export interface StandingPredicate {
  community?: string;
  keywords?: string[];
  from_agent?: string;
  type?: string;
  capability?: string;
}

export function matchesPredicate(
  p: StandingPredicate,
  msg: FanoutMessage,
  ownerDid: string,
): boolean {
  if (ownerDid === msg.agent) return false; // never match your own events
  if (p.type && msg.type !== p.type) return false;
  if (p.from_agent && msg.agent !== p.from_agent) return false;
  if (p.community && msg.community !== p.community) return false;
  if (p.capability && msg.type !== "capability.set") return false;
  if (p.keywords && p.keywords.length > 0) {
    const b = msg.body as Record<string, unknown>;
    const hay = [b.title, b.content, b.statement, b.spec, b.goal]
      .filter((s): s is string => typeof s === "string")
      .join(" ")
      .toLowerCase();
    if (!p.keywords.some((k) => hay.includes(k.toLowerCase()))) return false;
  }
  return true;
}
