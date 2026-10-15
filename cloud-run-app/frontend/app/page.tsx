import Link from "next/link";
import { apiRequest } from "../lib/api";
import { QuickStartAudit } from "../components/QuickStartAudit";

type Audit = {
  id: string;
  name: string;
  createdAt: string;
};

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let recentAudits: Audit[] = [];
  try {
    const audits = await apiRequest<Audit[]>("/api/audits");
    recentAudits = audits.slice(0, 5);
  } catch (err) {
    console.error("Erro ao carregar audits:", err);
    // Continua mesmo se falhar
  }

  return (
    <div className="space-y-6">
      <QuickStartAudit />

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Últimas auditorias</h2>
          <Link href="/audits" className="text-sm text-blue-700 underline">
            Ver todas
          </Link>
        </header>
        <div className="mt-3 overflow-x-auto rounded border">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="px-3 py-2">Nome</th>
                <th className="px-3 py-2">Criada em</th>
                <th className="px-3 py-2">Ações</th>
              </tr>
            </thead>
            <tbody>
              {recentAudits.map((audit) => (
                <tr key={audit.id} className="border-t">
                  <td className="px-3 py-2">{audit.name}</td>
                  <td className="px-3 py-2">{new Date(audit.createdAt).toLocaleString("pt-BR")}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-3">
                      <Link href={`/audits/${audit.id}/execute`} className="text-blue-700 underline">
                        Abrir execução
                      </Link>
                      <Link href={`/audits/${audit.id}/history`} className="text-blue-700 underline">
                        Histórico
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
              {recentAudits.length === 0 && (
                <tr>
                  <td className="px-3 py-2 text-slate-500" colSpan={3}>
                    Nenhuma auditoria criada.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-slate-600">
          Precisa ajustar personas de preenchimento? Acesse{" "}
          <Link href="/templates" className="text-blue-700 underline">
            Personas & Templates
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
