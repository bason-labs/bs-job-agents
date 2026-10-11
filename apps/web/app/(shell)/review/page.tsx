import type { Metadata } from "next";
import { ReviewScreen } from "@/components/review/ReviewScreen";

export const metadata: Metadata = { title: "Review" };

/** Review queue (§11): approve & submit, request changes, or skip with a reason. */
export default function Page() {
  return <ReviewScreen />;
}
