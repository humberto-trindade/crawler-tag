import { ExecutionDashboard } from "../../../../components/ExecutionDashboard";
import { apiRequest } from "../../../../lib/api";

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
