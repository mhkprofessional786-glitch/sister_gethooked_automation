'use strict';

/**
 * src/supabase/testConnection.js
 *
 * One-off connectivity check for the service_role Supabase client. Calls
 * the Auth admin API (service_role-only — anon or a wrong/expired key
 * would fail this) rather than querying a table, since no project tables
 * exist yet.
 *
 * Run directly: node src/supabase/testConnection.js
 */

const { supabase } = require('./client');

async function testConnection() {
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });

  if (error) {
    throw new Error(`Supabase connection test failed: ${error.message}`);
  }

  return { ok: true, userCount: data.users.length };
}

if (require.main === module) {
  testConnection()
    .then((result) => {
      console.log('Supabase connection OK.', result);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { testConnection };
