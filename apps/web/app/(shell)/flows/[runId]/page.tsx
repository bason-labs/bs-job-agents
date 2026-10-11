import type { Metadata } from "next";
import { FlowCanvas } from "@/components/flows/FlowCanvas";

interface Props {
  params: Promise<{ runId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: `Flow #${(await params).runId}` };
}

/** One run's live canvas (§11 Flow canvas, UC-22, UC-23). */
export default async function Page({ params }: Props) {
  const { runId } = await params;
  return <FlowCanvas runId={runId} />;
}
