export const runtime = "nodejs";

export async function GET() {
  return Response.json({ service: "Basecamp auth route" }, { status: 501 });
}

export async function POST() {
  return Response.json({ service: "Basecamp auth route" }, { status: 501 });
}
