import type { ResolvedUser, TaskListItem } from '../types';
import { listTasks } from '../services/tasks';
import { canViewAllTasks } from '../auth/permissions';

export interface ResolveResult {
  match: TaskListItem | null;        // confident single match
  candidates: TaskListItem[];        // ranked candidates (for disambiguation when not confident)
  ambiguous: boolean;                // true when several plausible matches
}

// ── String similarity (dependency-free) ───────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/["'`.,:;!?()\-־]/g, ' ')   // strip punctuation incl. Hebrew maqaf
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s).split(' ').filter((t) => t.length > 1);
}

/** 0..1 similarity: token overlap (Jaccard) with a substring bonus. */
export function similarity(reference: string, candidate: string): number {
  const refN = normalize(reference);
  const candN = normalize(candidate);
  if (!refN || !candN) return 0;
  if (candN.includes(refN) || refN.includes(candN)) return 1;

  const a = new Set(tokens(reference));
  const b = new Set(tokens(candidate));
  if (a.size === 0 || b.size === 0) return 0;

  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  const jaccard = inter / union;

  // Bonus when any reference token appears as a substring of the candidate
  let substr = 0;
  for (const t of a) if (candN.includes(t)) substr++;
  const substrBonus = (substr / a.size) * 0.3;

  return Math.min(1, jaccard + substrBonus);
}

// ── Resolution ────────────────────────────────────────────────────────────────

const MATCH_THRESHOLD = 0.4;   // minimum score to consider a candidate at all
const CONFIDENT_GAP   = 0.2;   // top must beat 2nd by this much to be unambiguous

export async function resolveTask(
  user: ResolvedUser,
  reference: string,
  ownerIds?: string[],
): Promise<ResolveResult> {
  // Managers/admins can resolve a task across the whole team (e.g. details of an
  // employee's task); regular employees resolve only their own (service re-clamps).
  // When ownerIds is given (the employee we're currently viewing), narrow to them.
  const scope = canViewAllTasks(user) ? 'all' : 'own';
  const { tasks } = await listTasks(user, { filter: 'all', scope, ownerIds, limit: 200 });

  const scored = tasks
    .map((t) => ({ task: t, score: similarity(reference, t.title) }))
    .filter((s) => s.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { match: null, candidates: [], ambiguous: false };
  }

  const top = scored[0];
  const second = scored[1];

  // Confident when there's a single strong match, or a clear gap to the runner-up
  const confident =
    top.score >= 0.8 ||
    !second ||
    top.score - second.score >= CONFIDENT_GAP;

  if (confident) {
    return { match: top.task, candidates: scored.slice(0, 5).map((s) => s.task), ambiguous: false };
  }

  return { match: null, candidates: scored.slice(0, 5).map((s) => s.task), ambiguous: true };
}
