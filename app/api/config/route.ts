export async function GET() {
  return Response.json({
    supabaseUrl: process.env.SUPABASE_URL ?? null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? null,
  }, { headers: { "cache-control": "no-store, max-age=0" } });
}
