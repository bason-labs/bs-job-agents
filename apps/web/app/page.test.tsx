import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "./page";

describe("Home page", () => {
  it("renders the app name on the brand gradient", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { level: 1, name: "bs-job-agents" })).toBeInTheDocument();
    expect(screen.getByTestId("brand-hero")).toHaveClass("bg-gradient-brand");
  });
});
