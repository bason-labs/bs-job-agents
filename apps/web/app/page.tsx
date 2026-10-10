import { Bot } from "lucide-react";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-6 px-6">
      <div
        data-testid="brand-hero"
        className="bg-gradient-brand shadow-glow flex w-full flex-col items-center gap-3 rounded-3xl px-8 py-12 text-white"
      >
        <Bot aria-hidden className="size-12" />
        <h1 className="font-display text-4xl font-bold tracking-tight">bs-job-agents</h1>
        <p className="text-white/85">Your local job crew: Lead, Research, CV, QA, Apply.</p>
      </div>
      <p className="text-muted text-sm">
        Theme tokens are live: <span className="text-brand font-semibold">brand</span>,{" "}
        <span className="text-accent font-semibold">accent</span>,{" "}
        <span className="text-gradient-brand font-semibold">gradient</span>.
      </p>
    </main>
  );
}
