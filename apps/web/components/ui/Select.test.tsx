import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Select, type SelectOption } from "./Select";

const OPTIONS: SelectOption[] = [
  { value: "weekdays", label: "Weekdays" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "custom", label: "Custom" },
];

function Harness({ initial = "daily", onChange }: { initial?: string | null; onChange?: (v: string) => void }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <div>
      <Select
        aria-label="Repeat"
        options={OPTIONS}
        value={value}
        onValueChange={(v) => {
          setValue(v);
          onChange?.(v);
        }}
      />
      <button type="button">outside</button>
    </div>
  );
}

const trigger = () => screen.getByRole("combobox", { name: "Repeat" });

describe("Select", () => {
  it("shows the chosen label and a placeholder when empty", () => {
    const { unmount } = render(<Harness />);
    expect(trigger()).toHaveTextContent("Daily");
    unmount();
    render(<Harness initial={null} />);
    expect(trigger()).toHaveTextContent("Select…");
  });

  it("opens with ArrowDown, highlighting the selected option first", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{ArrowDown}");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox");
    const active = document.getElementById(trigger().getAttribute("aria-activedescendant")!);
    expect(active).toHaveTextContent("Daily");
    expect(within(listbox).getByRole("option", { name: /Daily/ })).toHaveAttribute("aria-selected", "true");
    // Scrolling the selected option into view needs real layout: covered in e2e/components.spec.ts.
  });

  it("moves with ArrowDown/ArrowUp (wrapping) and chooses with Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(document.getElementById(trigger().getAttribute("aria-activedescendant")!)).toHaveTextContent("Custom");
    await user.keyboard("{ArrowDown}");
    expect(document.getElementById(trigger().getAttribute("aria-activedescendant")!)).toHaveTextContent("Weekdays");
    await user.keyboard("{ArrowUp}{Enter}");
    expect(onChange).toHaveBeenCalledWith("custom");
    expect(trigger()).toHaveTextContent("Custom");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).toHaveFocus();
  });

  it("closes with Escape without changing the value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Escape}");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveTextContent("Daily");
  });

  it("supports type-ahead while open", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{ArrowDown}c");
    expect(document.getElementById(trigger().getAttribute("aria-activedescendant")!)).toHaveTextContent("Custom");
    await user.keyboard("{Enter}");
    expect(trigger()).toHaveTextContent("Custom");
  });

  it("chooses an option by click and closes on click outside", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.click(screen.getByRole("option", { name: /Weekly/ }));
    expect(trigger()).toHaveTextContent("Weekly");
    await user.click(trigger());
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger()).toHaveTextContent("Weekly");
  });

  it("does not open when disabled", async () => {
    const user = userEvent.setup();
    render(<Select aria-label="Repeat" options={OPTIONS} value="daily" onValueChange={() => {}} disabled />);
    await user.click(trigger());
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
