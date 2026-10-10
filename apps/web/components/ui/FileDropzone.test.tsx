import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileDropzone, type FileDropzoneHandle } from "./FileDropzone";

function makeFile(name: string, size: number, type = "") {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("FileDropzone", () => {
  it("hides the native file input and opens it from the styled zone", async () => {
    render(<FileDropzone onFiles={() => {}} />);
    const native = screen.getByTestId("file-dropzone-input");
    expect(native).toHaveClass("sr-only");
    expect(native).toHaveAttribute("accept", ".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg");
    const click = vi.spyOn(native, "click");
    await userEvent.click(screen.getByRole("button", { name: /choose files/i }));
    expect(click).toHaveBeenCalled();
  });

  it("accepts valid files picked with the dialog", async () => {
    const onFiles = vi.fn();
    render(<FileDropzone onFiles={onFiles} multiple />);
    const pdf = makeFile("cv.pdf", 2048, "application/pdf");
    await userEvent.upload(screen.getByTestId("file-dropzone-input"), pdf);
    expect(onFiles).toHaveBeenCalledWith([pdf]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("rejects wrong types and files over 10 MB, showing each error", () => {
    const onFiles = vi.fn();
    render(<FileDropzone onFiles={onFiles} multiple />);
    const zone = screen.getByTestId("file-dropzone");
    const ok = makeFile("notes.txt", 10);
    const bad = makeFile("virus.exe", 10);
    const big = makeFile("huge.pdf", 11 * 1024 * 1024);
    fireEvent.drop(zone, { dataTransfer: { files: [ok, bad, big], types: ["Files"] } });
    expect(onFiles).toHaveBeenCalledWith([ok]);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("virus.exe: only PDF, DOC, DOCX, TXT, PNG or JPG files are accepted.");
    expect(alert).toHaveTextContent(/huge\.pdf is 11 MB; the limit is 10 MB/);
  });

  it("does not call onFiles when every dropped file is rejected", () => {
    const onFiles = vi.fn();
    render(<FileDropzone onFiles={onFiles} />);
    fireEvent.drop(screen.getByTestId("file-dropzone"), { dataTransfer: { files: [makeFile("a.zip", 5)], types: ["Files"] } });
    expect(onFiles).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("highlights while dragging over", () => {
    render(<FileDropzone onFiles={() => {}} />);
    const zone = screen.getByTestId("file-dropzone");
    fireEvent.dragEnter(zone, { dataTransfer: { types: ["Files"] } });
    expect(zone).toHaveAttribute("data-drag-over", "true");
    fireEvent.dragLeave(zone, { dataTransfer: { types: ["Files"] } });
    expect(zone).toHaveAttribute("data-drag-over", "false");
  });

  it("wrap mode: the children are the drop target and the ref opens the picker (chat composer)", async () => {
    const onFiles = vi.fn();
    const ref = { current: null as FileDropzoneHandle | null };
    render(
      <FileDropzone ref={ref} onFiles={onFiles} multiple dropHint="Drop to attach">
        <textarea aria-label="Message" />
      </FileDropzone>,
    );
    const zone = screen.getByTestId("file-dropzone");
    expect(zone).toContainElement(screen.getByLabelText("Message"));
    expect(screen.queryByRole("button", { name: /choose files/i })).toBeNull();
    fireEvent.dragEnter(zone, { dataTransfer: { types: ["Files"] } });
    expect(screen.getByText("Drop to attach")).toBeInTheDocument();
    const pdf = makeFile("jd.pdf", 10);
    fireEvent.drop(zone, { dataTransfer: { files: [pdf, makeFile("x.exe", 1)], types: ["Files"] } });
    expect(onFiles).toHaveBeenCalledWith([pdf]);
    expect(screen.getByRole("alert")).toHaveTextContent("x.exe");
    const click = vi.spyOn(screen.getByTestId("file-dropzone-input"), "click");
    ref.current!.open();
    expect(click).toHaveBeenCalled();
  });

  it("keeps only the first file when multiple is off", () => {
    const onFiles = vi.fn();
    render(<FileDropzone onFiles={onFiles} />);
    const a = makeFile("a.pdf", 5);
    const b = makeFile("b.pdf", 5);
    fireEvent.drop(screen.getByTestId("file-dropzone"), { dataTransfer: { files: [a, b], types: ["Files"] } });
    expect(onFiles).toHaveBeenCalledWith([a]);
  });
});
