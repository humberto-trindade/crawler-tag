import Link from "next/link";
import { apiRequest } from "../../lib/api";

type Audit = {
  id: string;
  name: string;
};

type Execution = {
  id: string;
  version: number;
  status: string;
  createdAt: string;
  results?: { eventsCount?: number };
};

type AnalysisRow = {
  auditId: string;
  auditName: string;
  execution: Execution;
};

export default async function AnalysisIndexPage() {
  const audits = await apiRequest<Audit[]>("/api/audits");
  const rows = await Promise.all(
    audits.slice(0, 30).map(async (audit): Promise<AnalysisRow | null> => {
      const history = await apiRequest<Execution[]>(`/api/audits/${audit.id}/executions/history`);
      const latest = history[0];
      if (!latest) return null;
      return { auditId: audit.id, auditName: audit.name, execution: latest };
    }),
  );
  const executions = rows.filter((row): row is AnalysisRow => Boolean(row));

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <header>
        <h1 className="text-2xl font-semibold">Análise</h1>
        <p className="mt-1 text-sm text-slate-600">
          Selecione uma execução para abrir os detalhes, tabela e grafos da jornada.
        </p>
      </header>

      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="px-3 py-2">Auditoria</th>
              <th className="px-3 py-2">Versão</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Eventos</th>
              <th className="px-3 py-2">Criada em</th>
              <th className="px-3 py-2">Ação</th>
              <th className="px-3 py-2">Relatórios</th>
            </tr>
          </thead>
          <tbody>
            {executions.map((row) => (
              <tr key={row.execution.id} className="border-t">
                <td className="px-3 py-2">{row.auditName}</td>
                <td className="px-3 py-2">v{row.execution.version}</td>
                <td className="px-3 py-2">{row.execution.status}</td>
                <td className="px-3 py-2">{row.execution.results?.eventsCount ?? 0}</td>
                <td className="px-3 py-2">{new Date(row.execution.createdAt).toLocaleString("pt-BR")}</td>
                <td className="px-3 py-2">
                  <Link
                    href={`/audits/${row.auditId}/analysis/${row.execution.id}`}
                    className="text-blue-700 underline"
                  >
                    Abrir análise
                  </Link>
                </td>
                <td className="flex gap-2 px-3 py-2">
                  <Link
                    href={`/audits/${row.auditId}/report/management`}
                    target="_blank"
                    className="rounded bg-violet-700 px-2 py-1 text-xs font-medium text-white hover:bg-violet-600"
                    title="Relatório consolidado de todas as execuções desta auditoria"
                  >
                    Consolidado
                  </Link>
                  <Link
                    href={`/audits/${row.auditId}/analysis/${row.execution.id}/report/management`}
                    target="_blank"
                    className="rounded bg-slate-800 px-2 py-1 text-xs font-medium text-white hover:bg-slate-700"
                    title="Relatório gerencial com condição de parada e screenshots"
                  >
                    Gerencial
                  </Link>
                  <Link
                    href={`/audits/${row.auditId}/analysis/${row.execution.id}/report/analyst`}
                    target="_blank"
                    className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-500"
                    title="Relatório analítico detalhado por URL"
                  >
                    Analítico
                  </Link>
                </td>
              </tr>
            ))}
            {executions.length === 0 && (
              <tr>
                <td className="px-3 py-2 text-slate-500" colSpan={6}>
                  Nenhuma execução disponível para análise.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
