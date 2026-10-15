import { EventsAnalysis } from "../../../../../components/EventsAnalysis";

export default async function AnalysisPage({
  params,
}: {
  params: Promise<{ auditId: string; executionId: string }>;
}) {
  const resolvedParams = await params;
  return (
    <div className="max-w-7xl">
      <EventsAnalysis auditId={resolvedParams.auditId} executionId={resolvedParams.executionId} />
    </div>
  );
}
