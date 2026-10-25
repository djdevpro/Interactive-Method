import { parseProxy } from './parse.js';
import type {
  DirectPolicy,
  Proxy,
  ProxyConfig,
  ProxyHealth,
  ProxyOutcome,
  RotationStrategy,
} from './types.js';

/** Base cooldown after a failure of each kind; doubled at each consecutive failure. */
const COOLDOWN_MS: Record<Exclude<ProxyOutcome['type'], 'ok'>, number> = {
  bot: 5 * 60_000,
  blocked: 10 * 60_000,
  'rate-limited': 2 * 60_000,
  network: 30_000,
};
const MAX_COOLDOWN_MS = 60 * 60_000;
/** A route used this recently weighs half in the smart rotation: traffic spreads out. */
const RECENT_MS = 20_000;

/** The id under which the machine's own address is tracked. */
export const DIRECT_ID = 'direct';

/** `null` stands for the machine's own address. */
export type Route = Proxy | null;

export const routeId = (route: Route): string =>
  route === null ? DIRECT_ID : route.id;

export interface ProxyPoolOptions {
  proxies?: (string | ProxyConfig | Proxy)[];
  strategy?: RotationStrategy;
  direct?: DirectPolicy;
  now?: () => number;
  random?: () => number;
  /** Health saved by `snapshot()`, to carry it across restarts. */
  health?: ProxyHealth[];
}

const isProxy = (value: unknown): value is Proxy =>
  typeof value === 'object' &&
  value !== null &&
  'kind' in value &&
  'host' in value;

/**
 * The proxies a client rotates through, and what it learnt of each: which
 * ones YouTube flags, which are slow, which are cooling down. Each failure
 * puts a route aside for a while (longer when YouTube flags it as a bot
 * than when it merely times out), doubling while it keeps failing.
 */
export class ProxyPool {
  readonly strategy: RotationStrategy;
  readonly direct: DirectPolicy;
  private readonly proxies: Proxy[];
  private readonly health = new Map<string, ProxyHealth>();
  private readonly now: () => number;
  private readonly random: () => number;
  private cursor = 0;
  private lastId: string | null = null;

  constructor(options: ProxyPoolOptions = {}) {
    this.proxies = (options.proxies ?? []).map((p) =>
      isProxy(p) ? p : parseProxy(p),
    );
    this.strategy = options.strategy ?? 'smart';
    this.direct =
      options.direct ?? (this.proxies.length ? 'fallback' : 'first');
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    for (const saved of options.health ?? [])
      if (
        saved.id === DIRECT_ID ||
        this.proxies.some((proxy) => proxy.id === saved.id)
      )
        this.health.set(saved.id, { ...saved });
  }

  get size(): number {
    return this.proxies.length;
  }

  list(): readonly Proxy[] {
    return this.proxies;
  }

  /** How many different routes a call may try. */
  get routeCount(): number {
    return this.proxies.length + (this.direct === 'never' ? 0 : 1);
  }

  /**
   * The route for the next attempt, never one of `tried`; `undefined` when
   * none is left. A route cooling down is picked only when nothing else is.
   */
  pick(tried: ReadonlySet<string> = new Set()): Route | undefined {
    const now = this.now();
    const directFree = this.direct !== 'never' && !tried.has(DIRECT_ID);
    if (directFree && (this.direct === 'first' || this.proxies.length === 0))
      return this.chosen(null);
    const open = this.proxies.filter((proxy) => !tried.has(proxy.id));
    const ready = open.filter(
      (proxy) => this.stateOf(proxy.id).cooldownUntil <= now,
    );
    const mixDirect =
      directFree &&
      this.direct === 'mix' &&
      this.stateOf(DIRECT_ID).cooldownUntil <= now;
    if (ready.length === 0 && !mixDirect) {
      if (directFree) return this.chosen(null);
      // Everything cools down: the one that comes back first.
      const soonest = open.sort(
        (a, b) =>
          this.stateOf(a.id).cooldownUntil - this.stateOf(b.id).cooldownUntil,
      )[0];
      return soonest === undefined ? undefined : this.chosen(soonest);
    }
    const candidates: Route[] = mixDirect ? [...ready, null] : ready;
    return this.chosen(this.choose(candidates));
  }

  /** What the call through `route` brought. */
  report(route: Route, outcome: ProxyOutcome): void {
    const state = this.stateOf(routeId(route));
    const now = this.now();
    state.lastUsedAt = now;
    state.lastOutcome = outcome.type;
    if (outcome.type === 'ok') {
      state.successes++;
      state.consecutiveFailures = 0;
      state.cooldownUntil = 0;
      state.latencyMs =
        state.latencyMs === null
          ? outcome.latencyMs
          : Math.round(state.latencyMs * 0.7 + outcome.latencyMs * 0.3);
      return;
    }
    state.failures++;
    state.consecutiveFailures++;
    const base =
      outcome.type === 'rate-limited' && outcome.retryAfterMs
        ? outcome.retryAfterMs
        : COOLDOWN_MS[outcome.type];
    state.cooldownUntil =
      now +
      Math.min(MAX_COOLDOWN_MS, base * 2 ** (state.consecutiveFailures - 1));
  }

  /** The health of every route, the machine's own as `direct`. */
  snapshot(): ProxyHealth[] {
    return [DIRECT_ID, ...this.proxies.map((proxy) => proxy.id)].map((id) => ({
      ...this.stateOf(id),
    }));
  }

  /** Forgets every failure: all routes usable at once. */
  reset(): void {
    this.health.clear();
  }

  private chosen(route: Route): Route {
    this.lastId = routeId(route);
    return route;
  }

  private choose(candidates: Route[]): Route {
    if (candidates.length === 1) return candidates[0]!;
    if (this.strategy === 'round-robin') {
      const chosen = candidates[this.cursor % candidates.length]!;
      this.cursor++;
      return chosen;
    }
    const weights = candidates.map((route) => this.weightOf(route));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let at = this.random() * total;
    for (let index = 0; index < candidates.length; index++) {
      at -= weights[index]!;
      if (at <= 0) return candidates[index]!;
    }
    return candidates[candidates.length - 1]!;
  }

  private weightOf(route: Route): number {
    const weight = route === null ? 1 : route.weight;
    if (this.strategy === 'random') return weight;
    const id = routeId(route);
    const state = this.stateOf(id);
    // Laplace: a new route starts at one half, neither zero nor one.
    const success =
      (state.successes + 1) / (state.successes + state.failures + 2);
    const speed =
      state.latencyMs === null ? 1 : 1 / (1 + state.latencyMs / 2000);
    const recent =
      id === this.lastId || this.now() - state.lastUsedAt < RECENT_MS ? 0.5 : 1;
    return Math.max(0.0001, weight * success * speed * recent);
  }

  private stateOf(id: string): ProxyHealth {
    let state = this.health.get(id);
    if (state === undefined) {
      state = {
        id,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
        cooldownUntil: 0,
        latencyMs: null,
        lastUsedAt: 0,
        lastOutcome: null,
      };
      this.health.set(id, state);
    }
    return state;
  }
}
