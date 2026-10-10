import { SearchX } from "lucide-react";
import Link from "next/link";
import { PlaceholderPage } from "@/components/shell/Page";

export default function NotFound() {
  return (
    <PlaceholderPage
      icon={<SearchX aria-hidden />}
      heading="Not found"
      description={
        <>
          This page doesn&apos;t exist. <Link href="/chat" className="text-accent hover:underline">Back to chat</Link>
        </>
      }
    />
  );
}
