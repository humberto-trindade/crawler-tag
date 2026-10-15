import Link from "next/link";
import { apiRequest } from "../../lib/api";

type Audit = {
  id: string;
  name: string;
  createdAt: string;
};

type Execution = {
  id: string;
  version: number;
  status: string;
  createdAt: string;
  results?: { eventsCount?: number };
};

export default async function HistoryPage() {
  const audits = await apiRequest<Audit[]>("/api/audits");
  const rows = await Promise.all(
    audits.slice(0, 30).map(async (audit) => {
      const history = await apiRequest<Execution[]>(`/api/audits/${audit.id}/executions/history`);
      const latest = history[0] ?? null;
      return { audit, latest };
    }),
  );

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <header>
        <h1 className="text-2xl font-semibold">Histórico</h1>
        <p className="mt-1 text-sm text-slate-600">Resumo das últimas execuções por auditoria.</p>
      </header>

      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="px-3 py-2">Auditoria</th>
              <th className="px-3 py-2">Última versão</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Eventos</th>
              <th className="px-3 py-2">Executada em</th>
              <th className="px-3 py-2">Ações</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ audit, latest }) => (
              <tr key={audit.id} className="border-t">
                <td className="px-3 py-2">{audit.name}</td>
                <td className="px-3 py-2">{latest ? `v${latest.version}` : "-"}</td>
                <td className="px-3 py-2">{latest?.status ?? "sem execução"}</td>
                <td className="px-3 py-2">{latest?.results?.eventsCount ?? 0}</td>
                <td className="px-3 py-2">
                  {latest ? new Date(latest.createdAt).toLocaleString("pt-BR") : "-"}
                </td>
                <td className="px-3 py-2">
                  <Link href={`/audits/${audit.id}/history`} className="text-blue-700 underline">
                    Ver histórico completo
                  </Link>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-2 text-slate-500" colSpan={6}>
                  Nenhuma auditoria com histórico.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
