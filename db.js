const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://eqyksnvfkjgyjutcixqs.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVxeWtzbnZma2pneWp1dGNpeHFzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3ODQxNjgsImV4cCI6MjA5MDM2MDE2OH0.carg01vjPjIcc7paPXOTj3n00ER_ny_K7cHQobr7nDk';

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = { supabase };
