/**
 * Short-lived "the task we're currently working on" memory, keyed by phone.
 *
 * When the user targets a task (views it, or runs an edit/reassign/relink on it),
 * we remember that task id for a few minutes. A follow-up action that doesn't name
 * a task — "ועכשיו תשנה עדיפות לגבוהה", "תוסיף תיאור" — then applies to the SAME
 * task, so the user can chain action-after-action without re-identifying it.
 *
 * In-memory by design: a convenience hint, safe to lose on restart, self-expiring.
 * (Not shared across instances — acceptable for a transient hint.)
 */
const TTL_MS = parseInt(process.env.TASK_CONTEXT_TTL_MINUTES ?? '10', 10) * 60_000;

interface ActiveTask {
  taskId: string;
  title?: string;
  expiresAt: number;
}

const store = new Map<string, ActiveTask>();

// Periodic sweep so the map doesn't grow unbounded for inactive phones.
setInterval(() => {
  const now = Date.now();
  for (const [phone, v] of store) {
    if (v.expiresAt <= now) store.delete(phone);
  }
}, 5 * 60_000).unref();

/** Remember the task the user is currently acting on (refreshes the TTL). */
export function setActiveTask(phone: string, taskId: string, title?: string): void {
  store.set(phone, { taskId, title, expiresAt: Date.now() + TTL_MS });
}

/** The task recently acted on, or null when none / expired. */
export function getActiveTask(phone: string): { taskId: string; title?: string } | null {
  const v = store.get(phone);
  if (!v) return null;
  if (v.expiresAt <= Date.now()) {
    store.delete(phone);
    return null;
  }
  return { taskId: v.taskId, title: v.title };
}

/** Forget the active-task hint. */
export function clearActiveTask(phone: string): void {
  store.delete(phone);
}
