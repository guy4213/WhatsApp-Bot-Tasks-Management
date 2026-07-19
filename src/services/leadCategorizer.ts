/**
 * D3-T6 — Deterministic keyword-based lead enrichment (no AI call).
 *
 * Classifies an IncomingLead into one of the inspection families by scanning
 * the combined text of subject + body + fromName + fromEmail.  When a clear
 * single InspectionType match is found within the family it is returned too.
 *
 * No AI calls are made in the normal path.  The InspectionType catalog is
 * loaded once from the DB and then cached in-process for the lifetime of the
 * module (reset via `_resetCacheForTests()` in tests).
 */

import { pool } from '../db/connection';
import type { IncomingLeadRow } from './incomingLeads';

// ── Public types ──────────────────────────────────────────────────────────────

export type Category =
  | 'radiation'
  | 'noise'
  | 'air'
  | 'asbestos'
  | 'radon'
  | 'soil'
  | 'water'
  | 'odor'
  | 'occupational'
  | null;

export interface LeadEnrichment {
  category: Category;
  categoryHe: string;
  inspectionType: {
    id: string;
    code: string;
    labelHe: string;
  } | null;
  location: string | null;
}

// ── Category → Hebrew user-facing label ──────────────────────────────────────
// Never use the word "משפחה" in user-facing text.

const CATEGORY_HE: Record<NonNullable<Category>, string> = {
  radiation:    'קרינה',
  noise:        'רעש',
  air:          'איכות אוויר',
  asbestos:     'אסבסט',
  radon:        'ראדון',
  soil:         'קרקע',
  water:        'מים',
  odor:         'ריחות',
  occupational: 'היגיינה תעסוקתית',
};

// ── Keyword buckets ───────────────────────────────────────────────────────────
// Case-insensitive match against the combined haystack.

export const CATEGORY_KEYWORDS: Record<NonNullable<Category>, string[]> = {
  radiation: [
    'קרינה', 'אלקטרומגנטית', 'ELF', 'EMF', 'שדה מגנטי', 'מיקרוגל',
    'מק"ט קרינה', 'רשת החשמל', 'לוח חשמל', 'סלולר', 'רכב חשמלי', 'היברידי',
  ],
  noise: [
    'רעש', 'אקוסטי', 'החזרי קול', 'מעלית', 'מזגן', 'מפוח', 'רעידות', 'dB',
  ],
  air: [
    'איכות אוויר', 'IAQ', 'זיהום אוויר', 'PM10', 'PM2.5', 'VOC', 'פורמלדהיד',
  ],
  asbestos: [
    'אסבסט', 'גל אסבסטי',
  ],
  radon: [
    'ראדון', 'radon',
  ],
  water: [
    'מים', 'שתייה', 'מקווה', 'בריכה', 'ברז',
  ],
  soil: [
    'קרקע', 'אדמה', 'זיהום קרקע',
  ],
  odor: [
    'ריח', 'ריחות', 'מטרד ריח',
  ],
  occupational: [
    'תעסוקתי', 'חשיפה', 'מפעל', 'היגיינה תעסוקתית', 'טפסי 205',
  ],
};

// ── Israeli city hints for location extraction ────────────────────────────────

const LOCATION_HINTS = [
  'תל אביב', 'ירושלים', 'חיפה', 'רמת גן', 'נתניה', 'הרצליה', 'ראשון לציון',
  'פתח תקווה', 'רעננה', 'אשדוד', 'באר שבע', 'חולון', 'בת ים', 'רחובות',
  'כפר סבא', 'הוד השרון', 'רמלה', 'לוד', 'מודיעין', 'קרית אונו', 'רמת השרון',
];

// ── Stopwords stripped before token-matching InspectionType labels ─────────────

const LABEL_STOPWORDS = new Set(['בדיקת', 'של', 'מן', 'מ', 'ה']);

// ── InspectionType row shape from the DB query ───────────────────────────────

interface InspectionTypeRow {
  id: string;
  code: string;
  labelHe: string;
  family: string;
}

// ── Module-level lazy singleton ───────────────────────────────────────────────

let _cachePromise: Promise<InspectionTypeRow[]> | null = null;

function loadInspectionTypes(): Promise<InspectionTypeRow[]> {
  if (_cachePromise) return _cachePromise;
  _cachePromise = (async () => {
    try {
      const { rows } = await pool.query<InspectionTypeRow>(
        `SELECT id::text AS id, code, "labelHe", family
         FROM "InspectionType"
         WHERE "isActive" = true AND "isFieldInspection" = true`,
      );
      return rows;
    } catch {
      // Tests that mock pool.query to throw or return empty should not crash.
      return [];
    }
  })();
  return _cachePromise;
}

/** Reset the cache — ONLY for use in unit tests. */
export function _resetCacheForTests(): void {
  _cachePromise = null;
}

// ── Core detection ────────────────────────────────────────────────────────────

/**
 * Decode any URL-encoded Hebrew (or other percent-escaped tokens) so that
 * form-submission leads whose only inspection hint lives in a URL segment
 * — e.g. Elementor's "קישור לעמוד: https://galit.co.il/%D7%9E%D7%99%D7%9D/…"
 * where `%D7%9E%D7%99%D7%9D` is the URL-encoded form of "מים" — are still
 * categorized. Failing sequences (partial / malformed) fall through as-is.
 * Real observed case: lead e6d139a1 (Noga, 2026-07-19) — body had no
 * inspection keywords but the URL contained "מים" URL-encoded.
 */
function decodePercentEscapes(s: string): string {
  // Match one or more consecutive %HH bytes and decode them together
  // (a Hebrew char is 2 UTF-8 bytes → 2 %HH pairs).
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
    try {
      return decodeURIComponent(seq);
    } catch {
      return seq;
    }
  });
}

/**
 * Build a combined haystack from lead fields (skip nulls). URL-encoded
 * tokens are decoded and APPENDED (not replaced) so the raw form stays
 * searchable too — a lead whose body already has both `מים` and
 * `%D7%9E%D7%99%D7%9D` still matches, no double-counting harm.
 */
function buildHaystack(lead: IncomingLeadRow): string {
  const raw = [lead.subject, lead.body, lead.fromName, lead.fromEmail]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ');
  const decoded = decodePercentEscapes(raw);
  return decoded === raw ? raw : `${raw} ${decoded}`;
}

/** Count how many entries in `keywords` appear (case-insensitive) in `haystack`. */
function countHits(haystack: string, keywords: string[]): number {
  const lower = haystack.toLowerCase();
  return keywords.reduce((acc, kw) => {
    return acc + (lower.includes(kw.toLowerCase()) ? 1 : 0);
  }, 0);
}

/** Extract a known Israeli city from the haystack (first substring match). */
function extractCity(haystack: string): string | null {
  for (const city of LOCATION_HINTS) {
    if (haystack.includes(city)) return city;
  }
  return null;
}

/**
 * Tokenise an InspectionType labelHe for matching:
 * split on whitespace, remove stopwords, keep tokens ≥ 3 chars.
 */
function labelTokens(labelHe: string): string[] {
  return labelHe
    .split(/\s+/)
    .map((t) => t.replace(/["""׳'"]/g, ''))
    .filter((t) => t.length >= 3 && !LABEL_STOPWORDS.has(t));
}

/** Count how many label tokens appear in `haystack` (case-insensitive). */
function countLabelHits(haystack: string, tokens: string[]): number {
  const lower = haystack.toLowerCase();
  return tokens.reduce((acc, t) => acc + (lower.includes(t.toLowerCase()) ? 1 : 0), 0);
}

// ── Main exported function ────────────────────────────────────────────────────

export async function enrichLead(lead: IncomingLeadRow): Promise<LeadEnrichment> {
  const types = await loadInspectionTypes();
  const haystack = buildHaystack(lead);
  const location = haystack ? extractCity(haystack) : null;

  // 1. Determine category via keyword buckets.
  const categories = Object.keys(CATEGORY_KEYWORDS) as NonNullable<Category>[];
  let bestCategory: NonNullable<Category> | null = null;
  let bestCount = 0;

  for (const cat of categories) {
    const hits = countHits(haystack, CATEGORY_KEYWORDS[cat]);
    if (hits > bestCount || (hits > 0 && hits === bestCount && cat < (bestCategory ?? ''))) {
      bestCount = hits;
      bestCategory = cat;
    }
  }

  if (!bestCategory || bestCount === 0) {
    return { category: null, categoryHe: 'לא זוהתה', inspectionType: null, location };
  }

  // 2. Find a single clear InspectionType match within the category.
  const familyTypes = types.filter((t) => t.family === bestCategory);
  let matchedType: InspectionTypeRow | null = null;

  if (familyTypes.length > 0) {
    // Score each type.
    const scored = familyTypes.map((t) => ({
      type: t,
      score: countLabelHits(haystack, labelTokens(t.labelHe)),
    }));

    const maxScore = Math.max(...scored.map((s) => s.score));

    if (maxScore >= 2) {
      const topMatches = scored.filter((s) => s.score === maxScore);
      if (topMatches.length === 1) {
        matchedType = topMatches[0].type;
      }
      // Tie among multiple → null (ambiguous)
    }
    // Single 1-token match or zero → null
  }

  return {
    category: bestCategory,
    categoryHe: CATEGORY_HE[bestCategory],
    inspectionType: matchedType
      ? { id: matchedType.id, code: matchedType.code, labelHe: matchedType.labelHe }
      : null,
    location,
  };
}
