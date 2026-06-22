// Provide dummy env vars so modules that import db/connection (which validates
// env at import time and creates a pg Pool) can load during pure-logic tests.
// The pool is never actually connected in these tests.
process.env.DATABASE_URL ??= 'postgresql://user:pass@127.0.0.1:5432/testdb';
process.env.SUPABASE_URL ??= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
