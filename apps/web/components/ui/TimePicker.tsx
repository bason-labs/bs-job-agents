"use client";

import { Select, type SelectProps } from "./Select";

/** 00:00, 00:30 … 23:30 */
export const TIME_SLOTS = Array.from({ length: 48 }, (_, i) => {
  const hh = String(Math.floor(i / 2)).padStart(2, "0");
  const value = `${hh}:${i % 2 ? "30" : "00"}`;
  return { value, label: value };
});

/** Spec §11 TimePicker: a Select of 30-minute slots. */
export function TimePicker(props: Omit<SelectProps, "options">) {
  return <Select {...props} options={TIME_SLOTS} />;
}
