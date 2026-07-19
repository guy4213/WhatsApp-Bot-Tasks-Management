/**
 * nameResolvers.ts — pure, dependency-free name/self-reference resolution
 * helpers used by the "smart picker escape" flow (UX-T1).
 *
 * NO I/O, NO imports from router/services — these are plain string-matching
 * utilities so they can be unit tested in isolation and reused by both the
 * picker-escape classifier and router merge handlers.
 */

import type { ResolvedUser } from '../types';

export interface NamedCandidate {
  id: string;
  name: string;
}

export interface LeadCandidate {
  id: string;
  name: string;
  subject?: string | null;
}

export type NameMatch =
  | { status: 'none' }
  | { status: 'unique'; id: string; name: string }
  | { status: 'ambiguous'; matches: NamedCandidate[] };

// ── Tokenizing helpers ────────────────────────────────────────────────────────

// Split on whitespace and common punctuation (incl. Hebrew geresh/gershayim and
// maqaf). Hebrew has no letter case, so this is purely a boundary splitter —
// word boundaries via \b in JS regex are unreliable for Hebrew, so we split
// explicitly instead of relying on \b.
const WORD_SPLIT_REGEX = /[\s.,:;!?()"'`״׳\-־]+/u;

function splitWords(text: string): string[] {
  return text
    .split(WORD_SPLIT_REGEX)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

// ── Self-reference detection ─────────────────────────────────────────────────

// Whole-word Hebrew self-reference tokens. Matched as EXACT tokens (after
// splitting on whitespace/punctuation) so that a real name which merely
// contains these letters (e.g. "אלירן", "אליהו", "עצמון") is never mistaken
// for a self-reference.
const SELF_REFERENCE_TOKENS = new Set(['אלי', 'אליי', 'לי', 'אותי', 'עצמי', 'לעצמי']);

/**
 * Detect a first-person self-reference in the ASSIGNEE/OWNER slot.
 * Tokens (whole-word, Hebrew): אלי, אליי, לי, אותי, עצמי, לעצמי.
 * Returns user.id when the text clearly refers to the speaker, else null.
 * Must NOT fire on unrelated words that merely contain these letters
 * (use word boundaries / token split, not naive substring).
 */
export function resolveSelfReference(text: string, user: Pick<ResolvedUser, 'id'>): string | null {
  if (!text) return null;
  const words = splitWords(text);
  for (const word of words) {
    if (SELF_REFERENCE_TOKENS.has(word)) {
      return user.id;
    }
  }
  return null;
}

// ── Fragment-match candidate resolution ──────────────────────────────────────

const MIN_TOKEN_LEN = 2; // avoid single-letter noise

/**
 * Fragment-match rules (case-insensitive):
 *  - the text contains the candidate's full name, OR
 *  - any single name-token of the candidate (>= 2 chars) appears in the text, OR
 *  - the candidate's name contains a >= 2-char token taken from the text.
 */
function nameMatchesText(text: string, candidateName: string): boolean {
  const normText = normalize(text);
  const normName = normalize(candidateName);
  if (!normText || normName.length < MIN_TOKEN_LEN) return false;

  if (normText.includes(normName)) return true;

  const nameTokens = splitWords(normName).filter((t) => t.length >= MIN_TOKEN_LEN);
  for (const token of nameTokens) {
    if (normText.includes(token)) return true;
  }

  const textTokens = splitWords(normText).filter((t) => t.length >= MIN_TOKEN_LEN);
  for (const token of textTokens) {
    if (normName.includes(token)) return true;
  }

  return false;
}

function toNameMatch(matches: NamedCandidate[]): NameMatch {
  if (matches.length === 0) return { status: 'none' };
  if (matches.length === 1) return { status: 'unique', id: matches[0].id, name: matches[0].name };
  return { status: 'ambiguous', matches };
}

/** Filter candidates whose own match-relevant text(s) fragment-match `text`. */
function filterByFragment<T>(text: string, candidates: T[], namesOf: (c: T) => string[]): T[] {
  return candidates.filter((c) => namesOf(c).some((n) => nameMatchesText(text, n)));
}

/**
 * Shared tier-priority resolution: try the on-screen candidates first; only
 * if none match do we fall back to the wider (optional) list. Ambiguity is
 * reported only within whichever tier actually produced matches — an
 * on-screen unique match always wins even if the wider tier would also match.
 */
function resolveTiered<T extends NamedCandidate>(
  text: string,
  candidates: T[],
  namesOf: (c: T) => string[],
  wider?: T[],
): NameMatch {
  const onScreen = filterByFragment(text, candidates, namesOf);
  if (onScreen.length > 0) return toNameMatch(onScreen);

  if (wider && wider.length > 0) {
    const widerMatches = filterByFragment(text, wider, namesOf);
    if (widerMatches.length > 0) return toNameMatch(widerMatches);
  }

  return { status: 'none' };
}

/**
 * Fragment-match a Hebrew NAME appearing anywhere in `text` against the
 * on-screen candidate list FIRST, then (optionally) the wider userTable.
 * On-screen candidates take priority: if exactly one on-screen candidate
 * matches, return it even if userTable would add more. Return 'ambiguous'
 * only within the winning tier.
 */
export function resolveWorkerName(
  text: string,
  candidates: NamedCandidate[],
  userTable?: NamedCandidate[],
): NameMatch {
  return resolveTiered(text, candidates, (c) => [c.name], userTable);
}

/**
 * Match a lead reference in `text` against on-screen lead candidates (by name
 * and, if present, subject), then optionally a wider pendingQueue. Same
 * tier-priority + fragment rules as resolveWorkerName. Returns NameMatch
 * (id = lead id, name = lead display name).
 */
export function resolveLeadReference(
  text: string,
  candidates: LeadCandidate[],
  pendingQueue?: LeadCandidate[],
): NameMatch {
  return resolveTiered(
    text,
    candidates,
    (c) => (c.subject ? [c.name, c.subject] : [c.name]),
    pendingQueue,
  );
}
