import { FOLIO_API_GENERATION, FOLIO_MIN_SUPPORTED_GENERATION } from "../../folio-version";

export async function GET() {
  return Response.json({
    buildId: process.env.NEXT_PUBLIC_FOLIO_BUILD_ID || "development",
    apiGeneration: FOLIO_API_GENERATION,
    minSupportedGeneration: FOLIO_MIN_SUPPORTED_GENERATION,
  }, { headers: { "cache-control": "no-store, max-age=0" } });
}
