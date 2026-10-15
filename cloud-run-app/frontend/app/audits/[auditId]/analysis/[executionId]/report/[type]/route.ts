import { NextRequest, NextResponse } from "next/server";

const BACKEND = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

// Proxy server-side para os relatórios HTML do backend.
// O browser acessa /audits/{id}/analysis/{execId}/report/{type}
// e este handler busca do backend via DNS interno do Docker.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ auditId: string; executionId: string; type: string }> },
) {
  const { auditId, executionId, type } = await params;

  if (type !== "management" && type !== "analyst" && type !== "visual") {
    return new NextResponse("Tipo inválido. Use management, analyst ou visual.", { status: 400 });
  }

  const searchParams = req.nextUrl.searchParams.toString();

  // visual maps to /visual endpoint (not /report/visual)
  const backendPath = type === "visual"
    ? `${BACKEND}/api/audits/${auditId}/executions/${executionId}/visual`
    : `${BACKEND}/api/audits/${auditId}/executions/${executionId}/report/${type}${searchParams ? `?${searchParams}` : ""}`;

  let backendRes: Response;
  try {
    backendRes = await fetch(backendPath, { cache: "no-store" });
  } catch {
    return new NextResponse("Erro ao conectar ao backend.", { status: 502 });
  }

  if (!backendRes.ok) {
    const text = await backendRes.text();
    return new NextResponse(text, { status: backendRes.status });
  }

  const html = await backendRes.text();

  // Reescreve os links internos para que apontem para esta mesma rota proxy.
  // O backend gera hrefs relativos como "../{execId}/report/analyst";
  // dentro do Next.js eles precisam ser absolutos para funcionar corretamente.
  const baseProxy = `/audits/${auditId}/analysis/${executionId}/report`;
  const rewritten = html
    .replace(
      /href="\.\.\/[^/]+\/report\/management"/g,
      `href="${baseProxy}/management"`,
    )
    .replace(
      /href="\.\.\/[^/]+\/report\/analyst"/g,
      `href="${baseProxy}/analyst"`,
    );

  return new NextResponse(rewritten, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
