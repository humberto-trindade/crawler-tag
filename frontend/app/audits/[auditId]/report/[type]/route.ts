import { NextRequest, NextResponse } from "next/server";

const BACKEND = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

// Proxy server-side para os relatórios HTML de auditoria completa (todas as execuções).
// Acesso: /audits/{auditId}/report/{type}?urlFilter=...
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ auditId: string; type: string }> },
) {
  const { auditId, type } = await params;

  if (type !== "management") {
    return new NextResponse("Tipo inválido. Use management.", { status: 400 });
  }

  // Forward all query params (urlFilter, etc.) to the backend
  const qs = req.nextUrl.searchParams.toString();
  const backendUrl = `${BACKEND}/api/audits/${auditId}/report/${type}${qs ? `?${qs}` : ""}`;

  let backendRes: Response;
  try {
    backendRes = await fetch(backendUrl, { cache: "no-store" });
  } catch {
    return new NextResponse("Erro ao conectar ao backend.", { status: 502 });
  }

  if (!backendRes.ok) {
    return new NextResponse(await backendRes.text(), { status: backendRes.status });
  }

  const html = await backendRes.text();

  // Reescreve links internos para execuções individuais para passarem pelo proxy.
  const rewritten = html
    .replace(
      /href="\.\/executions\/([^/]+)\/report\/management"/g,
      `href="/audits/${auditId}/analysis/$1/report/management"`,
    )
    .replace(
      /href="\.\/executions\/([^/]+)\/report\/analyst"/g,
      `href="/audits/${auditId}/analysis/$1/report/analyst"`,
    );

  return new NextResponse(rewritten, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
