/**
 * Observability: a dependency-free Prometheus registry (counters, gauges,
 * histograms) with text exposition at GET /metrics. Boring on purpose —
 * ~150 lines beats a client library for the platform's needs, and keeps the
 * §12 "audited, minimal dependencies" posture.
 */

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}="${String(labels[k]).replaceAll('"', '\\"')}"`).join(",");
}

class Counter {
  private values = new Map<string, number>();
  constructor(
    public readonly name: string,
    public readonly help: string,
  ) {}
  inc(labels: Labels = {}, v = 1): void {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + v);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) lines.push(`${this.name} 0`);
    for (const [k, v] of this.values) {
      lines.push(k ? `${this.name}{${k}} ${v}` : `${this.name} ${v}`);
    }
    return lines.join("\n");
  }
}

class Gauge {
  private value = 0;
  private collectFn: (() => number) | null = null;
  constructor(
    public readonly name: string,
    public readonly help: string,
  ) {}
  set(v: number): void {
    this.value = v;
  }
  collect(fn: () => number): void {
    this.collectFn = fn;
  }
  render(): string {
    const v = this.collectFn ? this.collectFn() : this.value;
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, `${this.name} ${v}`].join(
      "\n",
    );
  }
}

class Histogram {
  private counts: number[];
  private sum = 0;
  private total = 0;
  constructor(
    public readonly name: string,
    public readonly help: string,
    private readonly buckets: number[],
  ) {
    this.counts = new Array(buckets.length).fill(0);
  }
  observe(v: number): void {
    this.sum += v;
    this.total++;
    for (let i = 0; i < this.buckets.length; i++) {
      if (v <= this.buckets[i]!) this.counts[i] = this.counts[i]! + 1;
    }
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (let i = 0; i < this.buckets.length; i++) {
      lines.push(`${this.name}_bucket{le="${this.buckets[i]}"} ${this.counts[i]}`);
    }
    lines.push(`${this.name}_bucket{le="+Inf"} ${this.total}`);
    lines.push(`${this.name}_sum ${this.sum}`);
    lines.push(`${this.name}_count ${this.total}`);
    return lines.join("\n");
  }
}

const counters: Counter[] = [];
const gauges: Gauge[] = [];
const histograms: Histogram[] = [];

export function counter(name: string, help: string): Counter {
  const c = new Counter(name, help);
  counters.push(c);
  return c;
}
export function gauge(name: string, help: string): Gauge {
  const g = new Gauge(name, help);
  gauges.push(g);
  return g;
}
export function histogram(name: string, help: string, buckets: number[]): Histogram {
  const h = new Histogram(name, help, buckets);
  histograms.push(h);
  return h;
}

export function renderMetrics(): string {
  return [...counters, ...gauges, ...histograms].map((m) => m.render()).join("\n\n") + "\n";
}

// ── The platform's instruments ────────────────────────────────────────────────

export const httpRequests = counter(
  "waggle_http_requests_total",
  "HTTP requests by method, route, and status",
);
export const httpDuration = histogram(
  "waggle_http_request_duration_seconds",
  "HTTP request duration",
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
);
export const eventsIngested = counter(
  "waggle_events_total",
  "Signed events accepted at ingress, by type",
);
export const ingressRejections = counter(
  "waggle_ingress_rejections_total",
  "Envelopes rejected at ingress, by typed error code",
);
export const sseConnections = gauge(
  "waggle_sse_connections",
  "Currently connected SSE streams",
);
export const webhookDeliveries = counter(
  "waggle_webhook_deliveries_total",
  "Webhook delivery attempts by outcome",
);
export const sweeperTransitions = counter(
  "waggle_sweeper_transitions_total",
  "Sweeper state transitions (trades + bounties) by kind",
);
export const reputationRuns = counter(
  "waggle_reputation_runs_total",
  "Reputation batch passes by mode",
);
export const pgPoolTotal = gauge("waggle_pg_pool_total", "Postgres pool: total clients");
export const pgPoolIdle = gauge("waggle_pg_pool_idle", "Postgres pool: idle clients");
export const pgPoolWaiting = gauge("waggle_pg_pool_waiting", "Postgres pool: queued requests");
export const processRss = gauge("process_resident_memory_bytes", "Resident memory (RSS)");
export const processUptime = gauge("process_uptime_seconds", "Process uptime");

processRss.collect(() => process.memoryUsage().rss);
processUptime.collect(() => Math.round(process.uptime()));
