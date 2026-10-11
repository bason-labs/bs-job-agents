import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToastProvider, TooltipProvider } from "@/components/ui";
import { testMock } from "@/lib/api/mock/testing";
import { ApiProvider } from "@/lib/api/react";
import { BotsLive, BotsScreen } from "./BotsScreen";
import { createBotsData } from "./data";

function live(only?: string) {
  const mock = testMock();
  const user = userEvent.setup();
  render(
    <ApiProvider mode="mock" api={mock}>
      <TooltipProvider>
        <ToastProvider>
          <BotsLive only={only} />
        </ToastProvider>
      </TooltipProvider>
    </ApiProvider>,
  );
  return { mock, user };
}

async function setup(only?: string) {
  const data = createBotsData(testMock());
  const initial = await data.list();
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <ToastProvider>
        <BotsScreen initial={initial} only={only} data={data} />
      </ToastProvider>
    </TooltipProvider>,
  );
  return { user, data };
}

const card = (name: string) => screen.getByTestId(`bot-card-${name}`);

describe("BotsScreen (§11 Bots)", () => {
  it("shows every bot's role, engine, trust level, track record and prompt version", async () => {
    await setup();
    expect(screen.getByTestId("bots-grid").children).toHaveLength(5);
    const research = card("research");
    expect(within(research).getByText("Finds jobs, scores fit, profiles companies (read-only browser).")).toBeInTheDocument();
    expect(within(research).getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "true");
    expect(within(research).getByRole("img", { name: /Trust level L2/ })).toBeInTheDocument();
    expect(within(research).getByText("Track record: 41 tasks · 95% self-check pass")).toBeInTheDocument();
    expect(within(research).getByTestId("bot-prompt-version")).toHaveTextContent("prompt v2");
    expect(within(research).getByTestId("bot-residual-risk")).toBeInTheDocument();
  });

  it("disables Apply's and CV's engine switch and says why (PM S25)", async () => {
    await setup();
    for (const name of ["apply", "cv"]) {
      const radios = within(card(name)).getAllByRole("radio");
      for (const r of radios) expect(r).toBeDisabled();
      expect(within(card(name)).getByTestId("bot-engine-lock")).toHaveTextContent(/^Locked to Claude/);
    }
    expect(within(card("research")).getByRole("radio", { name: "Claude" })).toBeEnabled();
  });

  it("switches an unlocked bot's engine, and warns when QA would share CV's engine", async () => {
    const { user, data } = await setup();
    await user.click(within(card("qa")).getByRole("radio", { name: "Claude" }));
    expect(await screen.findByText("QA now runs on Claude. Queued tasks keep their engine.")).toBeInTheDocument();
    expect((await data.get("qa"))!.engine).toBe("claude");
    expect(within(card("qa")).getByTestId("bot-engine-warning")).toHaveTextContent("different engine from CV");
  });

  it("shows Apply's promotion suggestion with the promote button disabled (UC-19)", async () => {
    const { user } = await setup();
    const promo = within(card("apply")).getByTestId("bot-promotion");
    expect(promo).toHaveTextContent("System suggests promoting Apply to L2 (10 approved in a row without edits).");
    expect(within(promo).getByRole("button", { name: "Promote (disabled in Phase 1 for Apply)" })).toBeDisabled();
    await user.click(within(promo).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(within(card("apply")).queryByTestId("bot-promotion")).toBeNull());
  });

  it("restores a demoted bot one level (§5.3, PM S21)", async () => {
    const { user } = await setup();
    const demotion = within(card("cv")).getByTestId("bot-demotion");
    expect(demotion).toHaveTextContent("Demoted from L2 to L1 on 2026-10-10 18:20");
    await user.click(within(demotion).getByRole("button", { name: "Restore to L2" }));
    expect(await screen.findByText("CV restored to L2")).toBeInTheDocument();
    expect(within(card("cv")).queryByTestId("bot-demotion")).toBeNull();
    expect(within(card("cv")).getByRole("img", { name: /Trust level L2/ })).toBeInTheDocument();
  });

  it("words an engine demotion reason code (F3 DEMOTION_REASON_LABELS) and restores to the level it came from", async () => {
    const mock = testMock({ state: (s) => (s.bots.find((b) => b.name === "qa")!.demotion = { fromLevel: 2, at: "2026-10-11T08:00:00+07:00", reason: "trust_level" }) });
    mock.state.bots.find((b) => b.name === "qa")!.trustLevel = 1;
    const data = createBotsData(mock);
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <ToastProvider>
          <BotsScreen initial={await data.list()} data={data} />
        </ToastProvider>
      </TooltipProvider>,
    );
    const demotion = within(card("qa")).getByTestId("bot-demotion");
    expect(demotion).toHaveTextContent("Demoted from L2 to L1 on 2026-10-11 08:00: a tool outside its permissions.");
    await user.click(within(demotion).getByRole("button", { name: "Restore to L2" }));
    expect(await screen.findByText("QA restored to L2")).toBeInTheDocument();
    expect(mock.state.bots.find((b) => b.name === "qa")).toMatchObject({ trustLevel: 2, demotion: null });
  });

  it("deletes a memory note after confirming (PM S14)", async () => {
    const { user } = await setup();
    await user.click(within(card("lead")).getByRole("button", { name: "Memory (2 notes)" }));
    const memory = within(card("lead")).getByTestId("bot-memory");
    await user.click(within(memory).getByRole("button", { name: "Delete memory note: Ask one question max before starting a scan." }));
    const confirm = screen.getByTestId("confirm-dialog");
    expect(confirm).toHaveTextContent("Delete this note from Lead's memory?");
    await user.click(within(confirm).getByRole("button", { name: "Delete note" }));
    await waitFor(() => expect(within(card("lead")).getByRole("button", { name: "Memory (1 note)" })).toBeInTheDocument());
  });

  it("raises a bot one level after confirming, within the API's Phase 1 cap", async () => {
    const { user, data } = await setup("lead");
    const actions = within(card("lead")).getByTestId("bot-trust-actions");
    await user.click(within(actions).getByRole("button", { name: "Raise to L2" }));
    const confirm = screen.getByTestId("confirm-dialog");
    expect(confirm).toHaveTextContent("Raise Lead to L2?");
    expect(confirm).toHaveTextContent("L2: Acts on its own within its allowed tools.");
    await user.click(within(confirm).getByRole("button", { name: "Raise to L2" }));
    expect(await screen.findByText("Lead raised to L2")).toBeInTheDocument();
    expect((await data.get("lead"))!.trustLevel).toBe(2);
    expect(within(card("lead")).queryByRole("button", { name: /^Raise/ })).toBeNull();
  });

  it("never offers to raise Apply, but lowering it to L0 stops it after a warning", async () => {
    const { user, data } = await setup("apply");
    const actions = within(card("apply")).getByTestId("bot-trust-actions");
    expect(within(actions).queryByRole("button", { name: /^Raise/ })).toBeNull();
    expect(actions).toHaveTextContent("Apply stays at L1 in Phase 1: every submit needs your approval.");
    await user.click(within(actions).getByRole("button", { name: "Lower to L0" }));
    expect(screen.getByTestId("confirm-dialog")).toHaveTextContent("Every Apply task is refused until you raise it again.");
    await user.click(within(screen.getByTestId("confirm-dialog")).getByRole("button", { name: "Lower to L0" }));
    expect(await screen.findByText("Apply lowered to L0")).toBeInTheDocument();
    expect((await data.get("apply"))!.trustLevel).toBe(0);
    // Now below the cap, it can go back up one step.
    expect(within(card("apply")).getByRole("button", { name: "Raise to L1" })).toBeInTheDocument();
  });

  it("renders one bot as its settings page, with the enable switch and trust ladder", async () => {
    const { user, data } = await setup("apply");
    expect(screen.queryByTestId("bot-card-research")).toBeNull();
    expect(within(card("apply")).getByTestId("bot-memory")).toBeInTheDocument();
    expect(within(card("apply")).getByRole("list", { name: "Trust levels" })).toBeInTheDocument();
    await user.click(within(card("apply")).getByRole("switch"));
    expect(await screen.findByText("Apply disabled — Lead won't assign it new tasks")).toBeInTheDocument();
    expect((await data.get("apply"))!.enabled).toBe(false);
  });
});

describe("BotsLive (the pages)", () => {
  it("reads the bots through the api and follows bot.updated from elsewhere", async () => {
    const { mock } = live();
    expect(await screen.findByTestId("bots-grid")).toBeInTheDocument();
    await mock.request("PATCH", "/bots/:name", { params: { name: "research" }, body: { engine: "claude" } });
    await waitFor(() => expect(within(card("research")).getByRole("radio", { name: "Claude" })).toHaveAttribute("aria-checked", "true"));
  });

  it("says so for a bot that doesn't exist", async () => {
    live("nope");
    expect(await screen.findByText("There is no bot named “nope”")).toBeInTheDocument();
  });

  it("lists Lead's workflow proposals: approve saves (never runs), dismiss hides the buttons", async () => {
    const { mock, user } = live();
    mock.simulate("workflow-proposal");
    await mock.idle();
    const section = await screen.findByTestId("workflow-proposals");
    await waitFor(() => expect(within(section).getAllByTestId("workflow-proposal")).toHaveLength(2));
    // Newest first: Lead's new suggestion, then the seeded one.
    const [second, first] = within(section).getAllByTestId("workflow-proposal");
    expect(second).toHaveTextContent("scan-da-nang-2");
    expect(first).toHaveTextContent("weekly-remote-react");
    expect(within(first!).getByTestId("workflow-proposal-summary")).toHaveTextContent("preset of job-scan · workModes: remote · includeKeywords: React, Next.js · maxJobs: 5");
    const runs = Object.keys(mock.state.runs).length;
    await user.click(within(first!).getByRole("button", { name: "Approve (save only)" }));
    expect(await screen.findByText("Saved weekly-remote-react v1. Nothing was started; ask Lead to run it.")).toBeInTheDocument();
    expect(Object.keys(mock.state.runs)).toHaveLength(runs);
    await user.click(within(second!).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(within(section).queryAllByRole("button", { name: "Dismiss" })).toHaveLength(0));
    expect(within(section).getAllByTestId("workflow-proposal").map((p) => p.dataset.status).sort()).toEqual(["approved", "dismissed"]);
  });
});
