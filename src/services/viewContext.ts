/**
 * Short-lived "what are we currently looking at" memory, keyed by phone.
 *
 * When a manager views a specific employee's tasks ("המשימות של דני"), we remember
 * those owner ids for a few minutes so an immediate follow-up like
 * "תן לי פרטים על המשימה X" resolves the name WITHIN that employee's tasks,
 * instead of searching the whole team and surfacing look-alike titles.
 *
 * In-memory by design: it's a convenience hint, safe to lose on restart, and it
 * self-expires. (Not shared across instances — acceptable for a transient hint.)
 */
const TTL_MS = parseInt(process.env.VIEW_CONTEXT_TTL_MINUTES ?? '10', 10) * 60_000;

interface ViewMemory {
  ownerIds: string[];
  ownerNames: string[];
  expiresAt: number;
}

const store = new Map<string, ViewMemory>();

// Periodic sweep so the map doesn't grow unbounded for inactive phones.
setInterval(() => {
  const now = Date.now();
  for (const [phone, v] of store) {
    if (v.expiresAt <= now) store.delete(phone);
  }
}, 5 * 60_000).unref();

/** Remember the employee(s) currently being viewed. */
export function setViewOwners(phone: string, ownerIds: string[], ownerNames: string[]): void {
  store.set(phone, { ownerIds, ownerNames, expiresAt: Date.now() + TTL_MS });
}

/** The employee(s) recently viewed, or null when none / expired. */
export function getViewOwners(phone: string): { ownerIds: string[]; ownerNames: string[] } | null {
  const v = store.get(phone);
  if (!v) return null;
  if (v.expiresAt <= Date.now()) {
    store.delete(phone);
    return null;
  }
  return { ownerIds: v.ownerIds, ownerNames: v.ownerNames };
}

/** Forget the viewed-employee hint (e.g. after viewing own / whole-team list). */
export function clearViewOwners(phone: string): void {
  store.delete(phone);
}
