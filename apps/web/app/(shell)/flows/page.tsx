import type { Metadata } from "next";
import { FlowsList } from "@/components/flows/FlowsList";

export const metadata: Metadata = { title: "Flows" };

/** Every workflow run, newest first (§11 Flow canvas). */
export default function Page() {
  return <FlowsList />;
}
