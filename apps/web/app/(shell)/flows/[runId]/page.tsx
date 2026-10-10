import { Workflow } from "lucide-react";
import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shell/Page";

interface Props {
  params: Promise<{ runId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: `Flow #${(await params).runId}` };
}

// Phase 1 placeholder; the real screen is built in Phase 3.
export default async function Page({ params }: Props) {
  const { runId } = await params;
  return (
    <PlaceholderPage
      width="full"
      icon={<Workflow aria-hidden />}
      heading={`Job scan #${runId}`}
      description="The live flow canvas for this run arrives in Phase 3: step nodes, live output, pause and re-run."
    />
  );
}
