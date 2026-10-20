// Live 2026-10-20: Ba picks the Chrome browser bots use, from the browsers the bots reported.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToastProvider } from "@/components/ui";
import { ApiProvider } from "@/lib/api/react";
import { testMock } from "@/lib/api/mock/testing";
import { ChromeBrowserSetting, browserLabel } from "./ChromeBrowserSetting";

describe("Chrome browser for bots", () => {
  it("labels a browser by name, OS and whether it is this computer", () => {
    expect(browserLabel({ deviceId: "3e83d913-x", name: "Ba's MacBook Pro", os: "macOS", isLocal: true })).toBe("Ba's MacBook Pro · macOS · this computer");
    expect(browserLabel({ deviceId: "3e83d913-x", name: null, os: null, isLocal: null })).toBe("Browser 3e83d913");
  });

  it("lists the reported browsers; Use for bots saves the choice; Clear removes it", async () => {
    const mock = testMock();
    const user = userEvent.setup();
    render(
      <ApiProvider mode="mock" api={mock}>
        <ToastProvider>
          <ChromeBrowserSetting />
        </ToastProvider>
      </ApiProvider>,
    );
    const options = await screen.findAllByTestId("chrome-browser-option");
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining("Ba's MacBook Pro · macOS · this computer"), expect.stringContaining("Office PC · Windows")]);
    await user.click(within(options[0]!).getByRole("button", { name: "Use Ba's MacBook Pro · macOS · this computer for bots" }));
    await waitFor(() => expect(screen.getAllByTestId("chrome-browser-option")[0]).toHaveAttribute("data-chosen", "true"));
    expect(mock.state.chromeBrowser?.preferred?.name).toBe("Ba's MacBook Pro");
    await user.click(within(screen.getAllByTestId("chrome-browser-option")[0]!).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(mock.state.chromeBrowser?.preferred).toBeNull());
  });
});
