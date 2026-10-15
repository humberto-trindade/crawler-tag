import Link from "next/link";
import { apiRequest } from "../../../../lib/api";

type HistoryItem = {
  id: string;
  version: number;
  status: string;
  createdAt: string;
  results?: { eventsCount?: number; statesCount?: number };
};

export default async function HistoryPage({ params }: { params: Promise<{ auditId: string }> }) {
  const resolvedParams = await params;
  const history = await apiRequest<HistoryItem[]>(
    `/api/audits/${resolvedParams.auditId}/executions/history`,
  );

  return (
    <section className="max-w-6xl rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-2xl font-semibold">Histórico de execuções</h1>
      <div className="mt-4 overflow-x-auto rounded border">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="px-3 py-2">Versão</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Criado em</th>
              <th className="px-3 py-2">Eventos</th>
              <th className="px-3 py-2">Ações</th>
            </tr>
          </thead>
          <tbody>
            {history.map((item) => (
              <tr key={item.id} className="border-t">
                <td className="px-3 py-2">v{item.version}</td>
                <td className="px-3 py-2">{item.status}</td>
                <td className="px-3 py-2">{new Date(item.createdAt).toLocaleString("pt-BR")}</td>
                <td className="px-3 py-2">{item.results?.eventsCount ?? 0}</td>
                <td className="px-3 py-2">
                  <Link
                    className="text-blue-700 underline"
                    href={`/audits/${resolvedParams.auditId}/analysis/${item.id}`}
                  >
                    Ver análise
                  </Link>
                </td>
              </tr>
            ))}
            {history.length === 0 && (
              <tr>
                <td className="px-3 py-2 text-slate-500" colSpan={5}>
                  Nenhuma execução disponível.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
