'use strict';

/**
 * src/supabase/client.js
 *
 * Creates this project's Supabase client from environment variables only
 * (see .env.example) — never hardcoded, so the key never ends up in
 * source control.
 *
 * Uses the service_role key exclusively: this project's Data API is
 * currently configured to reject the anon key outright (confirmed live —
 * Supabase returns 401 UNAUTHORIZED_INVALID_API_KEY_TYPE for anon,
 * "Only the `service_role` API key can be used for this endpoint"), and
 * gethook-automation is a trusted, local, server-side script rather than
 * a browser app — so there's no anon/RLS-respecting client to maintain
 * here. service_role bypasses Row Level Security entirely; never expose
 * this client or its key to a browser context.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const missing = [
  ['SUPABASE_URL', SUPABASE_URL],
  ['SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY],
]
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}. ` +
      'Check your .env file against .env.example.'
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

module.exports = { supabase };
