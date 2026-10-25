import { experienceFlags } from "../../folio-experience";
export async function GET() {
  return Response.json(experienceFlags(), { headers: { "cache-control": "no-store" } });
}
