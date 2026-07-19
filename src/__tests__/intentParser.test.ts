/**
 * intentParser.test.ts
 *
 * UX-T1: asserts that buildSystemPrompt injects the SELF-REFERENCE guidance
 * (so the AI keeps the literal "אלי" token in params.assigneeName instead of
 * inventing a Hebrew name) for BOTH worker and manager roles.
 *
 * Fixture pattern (makeManager/makeWorker/makeCtx) mirrors managerIntents.test.ts
 * so both suites stay consistent.
 */
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, type ParseContext } from '../ai/intentParser';
import type { ResolvedUser } from '../types';

// ── Test helpers (mirrors managerIntents.test.ts) ────────────────────────────

function makeManager(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-mgr',
    name: 'מנהל',
    phone: '97250000001',
    role: 'MANAGER',
    isElevated: true,
    canViewAllRecords: true,
    canManageUsers: true,
    canManagePermissions: true,
    ...overrides,
  };
}

function makeWorker(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-worker',
    name: 'דני',
    phone: '97250000002',
    role: 'TECHNICIAN',
    isElevated: false,
    canViewAllRecords: false,
    canManageUsers: false,
    canManagePermissions: false,
    ...overrides,
  };
}

function makeCtx(user: ResolvedUser, overrides: Partial<ParseContext> = {}): ParseContext {
  return { user, allowedTypes: [], allowedPriorities: [], ...overrides };
}

const SELF_REFERENCE_GUIDANCE_SNIPPET = 'SELF-REFERENCE: When the user says "אלי" / "לי" / "אותי" / "עצמי" / "לעצמי"';

describe('buildSystemPrompt — UX-T1 self-reference guidance', () => {
  it('worker prompt contains the self-reference guidance line', () => {
    const prompt = buildSystemPrompt(makeCtx(makeWorker()));
    expect(prompt).toContain(SELF_REFERENCE_GUIDANCE_SNIPPET);
    expect(prompt).toContain('keep the LITERAL string "אלי" in params.assigneeName');
    expect(prompt).toContain('do NOT invent a Hebrew name');
  });

  it('manager prompt contains the self-reference guidance line', () => {
    const prompt = buildSystemPrompt(makeCtx(makeManager()));
    expect(prompt).toContain(SELF_REFERENCE_GUIDANCE_SNIPPET);
    expect(prompt).toContain('keep the LITERAL string "אלי" in params.assigneeName');
    expect(prompt).toContain('do NOT invent a Hebrew name');
  });
});
