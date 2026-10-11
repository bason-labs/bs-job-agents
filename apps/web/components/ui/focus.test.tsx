import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";
import { Drawer } from "./Drawer";
import { FileViewerProvider, useFileViewer } from "./FileViewer";

function ConfirmHarness({ explicit = false }: { explicit?: boolean }) {
  const [open, setOpen] = useState(false);
  const other = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button onClick={() => setOpen(true)}>Delete</button>
      <button ref={other}>Elsewhere</button>
      <ConfirmDialog open={open} onOpenChange={setOpen} title="Delete it?" confirmLabel="Delete" onConfirm={() => setOpen(false)} returnFocus={explicit ? other : undefined} />
    </>
  );
}

function ViewerOpener() {
  const { openFile } = useFileViewer();
  return <button onClick={() => openFile({ name: "notes.txt", kind: "text", text: "hello" })}>Open notes</button>;
}

function DrawerHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Inspect</button>
      <Drawer open={open} onOpenChange={setOpen} title="Step">
        <p>details</p>
      </Drawer>
    </>
  );
}

describe("focus returns to the opener of a layer opened from code (W3c request)", () => {
  it("ConfirmDialog: Esc and Cancel give focus back", async () => {
    render(<ConfirmHarness />);
    const opener = screen.getByRole("button", { name: "Delete" });
    await userEvent.click(opener);
    expect(await screen.findByTestId("confirm-dialog")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(opener).toHaveFocus());
    await userEvent.click(opener);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("an explicit returnFocus wins", async () => {
    render(<ConfirmHarness explicit />);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus());
  });

  it("FileViewer opened with openFile()", async () => {
    render(
      <FileViewerProvider>
        <ViewerOpener />
      </FileViewerProvider>,
    );
    const opener = screen.getByRole("button", { name: "Open notes" });
    await userEvent.click(opener);
    expect(await screen.findByTestId("file-viewer")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("Drawer", async () => {
    render(<DrawerHarness />);
    const opener = screen.getByRole("button", { name: "Inspect" });
    await userEvent.click(opener);
    await userEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
