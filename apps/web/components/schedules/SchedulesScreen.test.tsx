import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui";
import { TEST_NOW, testMock } from "@/lib/api/mock/testing";
import { ApiProvider } from "@/lib/api/react";
import { createSchedulesData, readSchedules, type SchedulesData } from "./data";
import { SchedulesLive, SchedulesScreen } from "./SchedulesScreen";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const NOW = TEST_NOW;

async function setup(data: SchedulesData = createSchedulesData(testMock())) {
  const { schedules, profiles } = await readSchedules(data);
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <SchedulesScreen initial={schedules} profiles={profiles} data={data} />
    </ToastProvider>,
  );
  return { user, data };
}

const rows = () => screen.queryAllByTestId("schedule-row");

beforeEach(() => push.mockReset());

describe("SchedulesScreen (UC-21)", () => {
  it("lists schedules with repeat, criteria, next run and last result", async () => {
    await setup();
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]!).getByTestId("schedule-summary")).toHaveTextContent(
      "Weekdays 09:00 · criteria Default (v3) · next: Mon 12 Oct, 09:00 · last: Fri 9 Oct · 3 to review",
    );
  });

  it("creates a schedule from the modal, after the name check", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "+ New schedule" }));
    const dialog = screen.getByTestId("schedule-editor");
    expect(within(dialog).getByRole("heading", { name: "New schedule" })).toBeInTheDocument();
    expect(within(dialog).getByTestId("schedule-runs")).toHaveTextContent("Runs: Weekdays 09:00");

    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Give the schedule a name");

    await user.type(within(dialog).getByLabelText("Name"), "Daily check");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await user.click(within(dialog).getByRole("radio", { name: "Daily" }));
    expect(within(dialog).getByTestId("schedule-runs")).toHaveTextContent("Runs: Daily 09:00");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByTestId("schedule-editor")).toBeNull();
    expect(within(rows()[1]!).getByText("Daily check")).toBeInTheDocument();
    expect(screen.getByText("Schedule created")).toBeInTheDocument();
  });

  it("requires 5 cron fields for a custom repeat", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Edit Weekday morning scan" }));
    const dialog = screen.getByTestId("schedule-editor");
    expect(within(dialog).getByRole("heading", { name: "Edit schedule" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("radio", { name: "Custom" }));
    const cron = within(dialog).getByLabelText("Cron expression");
    expect(cron).toHaveValue("0 9 * * 1-5");
    await user.clear(cron);
    await user.type(cron, "0 9 * *");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Cron needs 5 fields, e.g. 0 9 * * 1-5");
  });

  it("deletes after confirming, and Undo restores the schedule", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Delete Weekday morning scan" }));
    const confirm = screen.getByTestId("confirm-dialog");
    expect(within(confirm).getByText("Delete “Weekday morning scan”?")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Delete schedule" }));

    await waitFor(() => expect(rows()).toHaveLength(0));
    expect(screen.getByTestId("schedules-empty")).toHaveTextContent("No schedules — scans only run when you ask Lead.");
    expect(screen.getByText("Deleted “Weekday morning scan”")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByText("Restored “Weekday morning scan”")).toBeInTheDocument();
  });

  it("says so when Undo comes after the API's 6 s window (409 undo_window_passed)", async () => {
    let t = NOW.getTime();
    const { user } = await setup(createSchedulesData(testMock({ now: () => t })));
    await user.click(screen.getByRole("button", { name: "Delete Weekday morning scan" }));
    await user.click(within(screen.getByTestId("confirm-dialog")).getByRole("button", { name: "Delete schedule" }));
    await waitFor(() => expect(rows()).toHaveLength(0));
    t += 7_000;
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Too late to undo: “Weekday morning scan” is deleted for good.")).toBeInTheDocument();
    expect(rows()).toHaveLength(0);
  });

  it("Run now opens the new run's flow, and reports an overlap as a toast", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/flows/13"));
    await user.click(screen.getByRole("button", { name: "Run now" }));
    expect(await screen.findByText("“Weekday morning scan” is still running — a schedule never overlaps its previous run.")).toBeInTheDocument();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("turns a schedule off with its switch", async () => {
    const { user, data } = await setup();
    await user.click(screen.getByRole("switch", { name: "Weekday morning scan enabled" }));
    await waitFor(async () => expect((await data.list())[0]!.enabled).toBe(false));
    expect(within(rows()[0]!).getByTestId("schedule-summary")).toHaveTextContent("next: off");
  });
});

describe("SchedulesLive (the page)", () => {
  it("reads through the api and shows the last result after a scheduled scan fires", async () => {
    const mock = testMock();
    render(
      <ApiProvider mode="mock" api={mock}>
        <ToastProvider>
          <SchedulesLive />
        </ToastProvider>
      </ApiProvider>,
    );
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(rows()[0]!).getByTestId("schedule-summary")).toHaveTextContent("last: Fri 9 Oct · 3 to review");
    await mock.request("POST", "/schedules/:id/run", { params: { id: "sch_1" } });
    await waitFor(() => expect(within(rows()[0]!).getByTestId("schedule-summary")).toHaveTextContent("last: Sun 11 Oct · scanning"));
    await mock.idle();
  });
});
