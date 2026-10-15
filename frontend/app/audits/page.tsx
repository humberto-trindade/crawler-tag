import Link from "next/link";
import { apiRequest } from "../../lib/api";

type Audit = {
  id: string;
  name: string;
  objective: string;
  createdAt: string;
};

export default async function AuditsPage() {
  const audits = await apiRequest<Audit[]>("/api/audits");

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Execuções</h1>
        <Link href="/" className="rounded bg-slate-900 px-3 py-2 text-sm text-white">
          Nova execução rápida
        </Link>
      </header>

      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="px-3 py-2">Auditoria</th>
              <th className="px-3 py-2">Objetivo</th>
              <th className="px-3 py-2">Criada em</th>
              <th className="px-3 py-2">Ações</th>
            </tr>
          </thead>
          <tbody>
            {audits.map((audit) => (
              <tr key={audit.id} className="border-t">
                <td className="px-3 py-2">{audit.name}</td>
                <td className="px-3 py-2">{audit.objective}</td>
                <td className="px-3 py-2">{new Date(audit.createdAt).toLocaleString("pt-BR")}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-3">
                    <Link href={`/audits/${audit.id}/execute?new=1`} className="text-blue-700 underline">
                      Executar agora
                    </Link>
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
            {audits.length === 0 && (
              <tr>
                <td className="px-3 py-2 text-slate-500" colSpan={4}>
                  Nenhuma auditoria disponível.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
