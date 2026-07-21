// Provide dummy env vars so modules that import db/connection (which validates
// env at import time and creates a pg Pool) can load during pure-logic tests.
// The pool is never actually connected in these tests.
process.env.DATABASE_URL ??= 'postgresql://user:pass@127.0.0.1:5432/testdb';
process.env.SUPABASE_URL ??= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';

// AI-native agent loop defaults ON in production (fresh free-text → the
// conversational agent). The large legacy router suite asserts the OLD
// single-intent dispatch through handleAIMessage → parseIntent, so default the
// flag OFF for tests. Tests that specifically exercise the agent loop set/reset
// AI_AGENT_LOOP themselves (see agentLoop.test.ts).
process.env.AI_AGENT_LOOP ??= '0';
