/**
 * routerStaleHistory.test.ts — Layer 3 history-trimming tests.
 *
 * Verifies that for very short inputs (≤3 chars), the AI parser receives
 * trimmed history (at most the last BOT turn) rather than the full stale
 * conversation window that could cause the LLM to recycle old search terms.
 *
 * Also verifies the Layer 3 system-prompt rule is present for both manager
 * and worker prompt builds.
 */
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../ai/intentParser';
import type { ResolvedUser } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAdmin(): ResolvedUser {
  return {
    id: 'u-admin', name: 'מנהל', phone: '97250000001',
    role: 'ADMIN', isElevated: true,
    canViewAllRecords: true, canManageUsers: true, canManagePermissions: true,
  };
}

function makeWorker(): ResolvedUser {
  return {
    id: 'u-worker', name: 'דני', phone: '97250000002',
    role: 'SALES', isElevated: false,
    canViewAllRecords: false, canManageUsers: false, canManagePermissions: false,
  };
}

const staleChatHistory = [
  { role: 'user' as const,      content: 'חפש בדיקות של יאיר' },
  { role: 'assistant' as const, content: 'מציג 3 בדיקות עבור יאיר: ...' },
  { role: 'user' as const,      content: 'תציג את הבדיקה הראשונה' },
  { role: 'assistant' as const, content: 'פרטי בדיקה tf-99: לקוח כהן, עיר תל אביב' },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Layer 3 — history trimming for very short inputs', () => {
  it('short input (1 char) — stale USER history is NOT included in the prompt', () => {
    const prompt = buildSystemPrompt(
      {
        user: makeAdmin(),
        allowedTypes: [],
        allowedPriorities: [],
        history: staleChatHistory,
      },
      '2', // very short — 1 char
    );

    // "יאיר" is a user-turn stale search term. It must NOT appear in the prompt.
    expect(prompt).not.toContain('יאיר');
    // The last BOT turn IS allowed (minimal anchor).
    expect(prompt).toContain('פרטי בדיקה tf-99');
    // The stale user search query must be absent.
    expect(prompt).not.toContain('חפש בדיקות של יאיר');
    expect(prompt).not.toContain('תציג את הבדיקה הראשונה');
  });

  it('short input (2 chars Hebrew) — stale user history is NOT included', () => {
    const prompt = buildSystemPrompt(
      {
        user: makeAdmin(),
        allowedTypes: [],
        allowedPriorities: [],
        history: staleChatHistory,
      },
      'כן', // 2 chars
    );
    expect(prompt).not.toContain('יאיר');
    expect(prompt).not.toContain('חפש בדיקות של יאיר');
  });

  it('short input (3 chars) — stale user history is NOT included', () => {
    const prompt = buildSystemPrompt(
      {
        user: makeAdmin(),
        allowedTypes: [],
        allowedPriorities: [],
        history: staleChatHistory,
      },
      'כן ', // 3 chars with trailing space
    );
    expect(prompt).not.toContain('יאיר');
  });

  it('longer input (4+ chars) — full history IS included (reference resolution still works)', () => {
    const prompt = buildSystemPrompt(
      {
        user: makeAdmin(),
        allowedTypes: [],
        allowedPriorities: [],
        history: staleChatHistory,
      },
      'תראה לי פרטים', // 14 chars — normal-length message
    );
    // Full history should be included for normal-length messages.
    expect(prompt).toContain('יאיר');
    expect(prompt).toContain('חפש בדיקות של יאיר');
    expect(prompt).toContain('פרטי בדיקה tf-99');
  });

  it('short input with NO history — no RECENT CONVERSATION block in prompt', () => {
    const prompt = buildSystemPrompt(
      {
        user: makeAdmin(),
        allowedTypes: [],
        allowedPriorities: [],
        history: [],
      },
      '3',
    );
    expect(prompt).not.toContain('RECENT CONVERSATION');
  });

  it('short input — applies to workers too (not just manager)', () => {
    const prompt = buildSystemPrompt(
      {
        user: makeWorker(),
        allowedTypes: [],
        allowedPriorities: [],
        history: staleChatHistory,
      },
      '1',
    );
    expect(prompt).not.toContain('יאיר');
    expect(prompt).not.toContain('חפש בדיקות של יאיר');
  });

  it('empty history and short input — no crash, no RECENT CONVERSATION block', () => {
    const prompt = buildSystemPrompt(
      {
        user: makeAdmin(),
        allowedTypes: [],
        allowedPriorities: [],
        history: undefined,
      },
      '5',
    );
    expect(prompt).not.toContain('RECENT CONVERSATION');
  });
});

describe('Layer 3 — system prompt anti-stale-history rule', () => {
  it('manager prompt contains the "do not recycle history" safety rule', () => {
    const prompt = buildSystemPrompt(
      { user: makeAdmin(), allowedTypes: [], allowedPriorities: [] },
      'תציג בדיקות היום', // normal length so rules block is generated
    );
    // The rule must be present in both manager and worker prompts.
    expect(prompt).toMatch(/do not recycle/i);
    expect(prompt).toMatch(/bare digit/i);
  });

  it('worker prompt also contains the anti-stale-history rule', () => {
    const prompt = buildSystemPrompt(
      { user: makeWorker(), allowedTypes: [], allowedPriorities: [] },
      'יצאתי לרעננה',
    );
    expect(prompt).toMatch(/do not recycle/i);
    expect(prompt).toMatch(/bare digit/i);
  });
});
