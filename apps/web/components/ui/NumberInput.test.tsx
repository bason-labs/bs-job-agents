import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NumberInput } from "./NumberInput";

function Harness({ initial = null, onChange, ...rest }: { initial?: number | null; onChange?: (v: number | null) => void; min?: number; max?: number }) {
  const [value, setValue] = useState<number | null>(initial);
  return (
    <NumberInput
      aria-label="Salary floor"
      value={value}
      onValueChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      {...rest}
    />
  );
}

const input = () => screen.getByRole("textbox", { name: "Salary floor" }) as HTMLInputElement;

describe("NumberInput", () => {
  it("renders the value with thousand separators and a numeric keyboard, no spinners", () => {
    render(<Harness initial={30000000} />);
    expect(input()).toHaveValue("30,000,000");
    expect(input()).toHaveAttribute("inputmode", "numeric");
    expect(input()).toHaveAttribute("type", "text");
  });

  it("formats as you type", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.type(input(), "30000000");
    expect(input()).toHaveValue("30,000,000");
    expect(onChange).toHaveBeenLastCalledWith(30000000);
  });

  it("ignores non-digit characters", async () => {
    render(<Harness />);
    await userEvent.type(input(), "2a5b0");
    expect(input()).toHaveValue("250");
  });

  it("clearing gives null", async () => {
    const onChange = vi.fn();
    render(<Harness initial={1500} onChange={onChange} />);
    await userEvent.clear(input());
    expect(input()).toHaveValue("");
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("keeps the caret after the same digit when separators shift", () => {
    render(<Harness initial={1000000} />);
    const el = input();
    el.focus();
    // "1,000,000" → user types "5" after the first "1" (caret at 1).
    el.setSelectionRange(1, 1);
    fireEvent.change(el, { target: { value: "15,000,000", selectionStart: 2, selectionEnd: 2 } });
    expect(el).toHaveValue("15,000,000");
    expect(el.selectionStart).toBe(2);
  });

  it("clamps to min/max on blur", async () => {
    const onChange = vi.fn();
    render(<Harness initial={null} min={1000} max={5000} onChange={onChange} />);
    await userEvent.type(input(), "99999");
    await userEvent.tab();
    expect(input()).toHaveValue("5,000");
    expect(onChange).toHaveBeenLastCalledWith(5000);
  });
});
