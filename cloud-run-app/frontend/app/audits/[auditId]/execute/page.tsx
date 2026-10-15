import { ExecutionDashboard } from "../../../../components/ExecutionDashboard";
import { apiRequest } from "../../../../lib/api";
import Link from "next/link";

type Execution = {
  id: string;
  status: string;
  platform: string;
  environment: string;
  ignoredFields: Array<{ fieldName: string; reason: string }>;
  warnings: Array<{ type: string; message: string }>;
  results?: { eventsCount?: number; statesCount?: number; actionsCount?: number };
};

type ExecutePageProps = {
  params: Promise<{ auditId: string }>;
  searchParams: Promise<{ new?: string }>;
};

export default async function ExecutePage({ params, searchParams }: ExecutePageProps) {
  const resolvedParams = await params;
  const resolvedSearchParams = await searchParams;
  const forceNewExecution = resolvedSearchParams.new === "1";
  try {
    await apiRequest(`/api/audits/${resolvedParams.auditId}`);
  } catch {
    return (
      <div className="max-w-2xl rounded-lg border border-amber-200 bg-amber-50 p-6">
        <h1 className="text-xl font-semibold text-amber-900">Auditoria não encontrada</h1>
        <p className="mt-2 text-sm text-amber-800">
          Esta auditoria foi criada em uma instância anterior ou ainda não foi salva.
          Com a persistência mockada, os dados são removidos quando o backend reinicia.
        </p>
        <Link href="/" className="mt-4 inline-block rounded bg-slate-900 px-4 py-2 text-sm text-white">
          Voltar para Início Rápido
        </Link>
      </div>
    );
  }

  const history = await apiRequest<Execution[]>(`/api/audits/${resolvedParams.auditId}/executions/history`);
  const latest = history[0];
  let execution = latest;

  if (forceNewExecution || !execution) {
    execution = await apiRequest<Execution>(`/api/audits/${resolvedParams.auditId}/executions`, {
      method: "POST",
      body: { platform: "web", environment: "local" },
    });
  }

  return (
    <div className="max-w-6xl">
      <ExecutionDashboard auditId={resolvedParams.auditId} initialExecution={execution} />
    </div>
  );
}
