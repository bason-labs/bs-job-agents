// F8: chat attachments. Ba's bubble shows chips from the message's `attachments` (name, size, a
// thumbnail for images) that open the right viewer by mime; the composer takes pasted screenshots.
import type { ChatMessage, Room } from "@bs-job-agents/shared";
import { messageFixture } from "@bs-job-agents/shared/fixtures";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebApi } from "@/lib/api/contract";
import { ApiProvider } from "@/lib/api/react";
import { MOCK_BOTS } from "@/lib/mock/shell";
import { FileViewer, FileViewerProvider } from "@/components/ui/FileViewer";
import { attachmentFiles } from "./Attachments";
import { ChatContext, type ChatContextValue } from "./ChatContext";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";

const LEAD_ROOM: Room = {
  id: "lead",
  name: "Lead",
  kind: "lead",
  botName: "lead",
  members: ["lead"],
  createdAt: "2026-10-10T08:00:00Z",
};
const SHOT = "Screenshot at Oct 11 5-14-30 PM.png";
const fileUrl = (id: string, o: { download?: boolean } = {}) => `/api/files/${id}${o.download ? "?download=1" : ""}`;

/** The message Ba saw as a bare "Attachment" chip (the server payload from the live bug report). */
const baMessage = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  ...messageFixture,
  id: "m1",
  author: { type: "ba" },
  text: "",
  cards: [],
  uploadIds: ["1"],
  attachments: [
    {
      id: "1",
      filename: SHOT,
      mime: "image/png",
      size: 3560129,
      file: {
        id: "upload-1",
        kind: "upload",
        filename: SHOT,
        mime: "image/png",
      },
    },
  ],
  ...over,
});

function setup(ui: ReactNode) {
  const api = {
    mode: "live",
    events: {
      subscribe: () => () => {},
      getStatus: () => "open",
      onStatus: () => () => {},
    },
    fileUrl,
  } as unknown as WebApi;
  const ctx: ChatContextValue = {
    room: LEAD_ROOM,
    bots: MOCK_BOTS,
    messages: [],
    taskPhase: () => undefined,
    taskBot: () => undefined,
    uploads: {},
  };
  render(
    <ApiProvider mode="live" api={api}>
      <FileViewerProvider>
        <ChatContext.Provider value={ctx}>{ui}</ChatContext.Provider>
      </FileViewerProvider>
    </ApiProvider>,
  );
}

describe("attachment chips under Ba's message (F8)", () => {
  it("come from message.attachments: file name, size and the upload's file id (GET /files/upload-1)", () => {
    expect(attachmentFiles(baMessage(), { fileUrl }, {})).toEqual([
      {
        name: SHOT,
        kind: "image",
        mime: "image/png",
        url: "/api/files/upload-1",
        downloadUrl: "/api/files/upload-1?download=1",
        sizeBytes: 3560129,
      },
    ]);
    // An older copy with only uploadIds still points at the upload's file id, never at "/files/1".
    expect(attachmentFiles(baMessage({ attachments: undefined }), { fileUrl }, {})).toEqual([
      {
        name: "Attachment",
        kind: "other",
        url: "/api/files/upload-1",
        downloadUrl: "/api/files/upload-1?download=1",
      },
    ]);
  });

  it("an uploaded PNG shows a thumbnail and opens as an image with Download inside the viewer", async () => {
    setup(<MessageItem message={baMessage()} />);
    const chip = screen.getByTestId("message-attachment");
    expect(chip).toHaveAttribute("data-kind", "image");
    expect(chip).toHaveTextContent(SHOT);
    expect(chip).toHaveTextContent("3.4 MB");
    expect(within(chip).getByTestId("attachment-thumbnail")).toHaveAttribute("src", "/api/files/upload-1");
    await userEvent.click(chip);
    const viewer = await screen.findByTestId("file-viewer");
    expect(within(viewer).getByRole("img", { name: SHOT })).toHaveAttribute("src", "/api/files/upload-1");
    expect(within(viewer).queryByText("No preview for this file type.")).toBeNull();
    expect(within(viewer).getByRole("link", { name: /Download/ })).toHaveAttribute("href", "/api/files/upload-1?download=1");
  });

  it("PDF and text uploads open in their viewers by mime", async () => {
    const pdf = baMessage({
      attachments: [
        {
          id: "2",
          filename: "notes",
          mime: "text/plain",
          size: 5,
          file: {
            id: "upload-2",
            kind: "upload",
            filename: "notes",
            mime: "text/plain",
          },
        },
      ],
      uploadIds: ["2"],
    });
    expect(attachmentFiles(pdf, { fileUrl }, {})[0]!.kind).toBe("text");
    const doc = baMessage({
      attachments: [
        {
          id: "3",
          filename: "JD",
          mime: "application/pdf",
          size: 5,
          file: {
            id: "upload-3",
            kind: "upload",
            filename: "JD",
            mime: "application/pdf",
          },
        },
      ],
      uploadIds: ["3"],
    });
    expect(attachmentFiles(doc, { fileUrl }, {})[0]!.kind).toBe("pdf");
  });
});

describe("FileViewer picks the preview by mime (F8)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a file of kind other with an image mime previews as an image", () => {
    render(
      <FileViewer
        file={{
          name: "shot",
          kind: "other",
          mime: "image/png",
          url: "/api/files/upload-1",
        }}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByRole("img", { name: "shot" })).toBeInTheDocument();
  });

  it("without a mime, sniffs the response's Content-Type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { headers: { "content-type": "image/png" } })),
    );
    render(<FileViewer file={{ name: "Attachment", kind: "other", url: "/api/files/upload-1" }} onOpenChange={() => {}} />);
    expect(await screen.findByRole("img", { name: "Attachment" })).toHaveAttribute("src", "/api/files/upload-1");
  });

  it("keeps 'No preview' for a type it cannot show", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("", {
            headers: { "content-type": "application/msword" },
          }),
      ),
    );
    render(<FileViewer file={{ name: "cv.doc", kind: "other", url: "/api/files/upload-4" }} onOpenChange={() => {}} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByText("No preview for this file type.")).toBeInTheDocument();
  });
});

describe("pasting into the composer (F8)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 11, 17, 14, 30));
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.useRealTimers());

  const paste = (target: Element, files: File[], text = "") =>
    act(() => {
      fireEvent.paste(target, {
        clipboardData: {
          files,
          getData: (t: string) => (t === "text/plain" ? text : ""),
          types: files.length ? ["Files"] : ["text/plain"],
        },
      });
    });

  it("a pasted screenshot becomes a chip with a preview, is sent as a file and can be removed", async () => {
    const onSend = vi.fn(async () => true);
    setup(<Composer bot={undefined} botName="lead" suggestions={[]} onSend={onSend} />);
    const box = screen.getByRole("textbox", { name: "Message lead" });
    paste(box, [
      new File([new Uint8Array([0x89, 0x50])], "image.png", {
        type: "image/png",
      }),
    ]);
    const chip = screen.getByTestId("attachment-chip");
    expect(chip).toHaveTextContent("pasted-image-20261011-171430.png");
    expect(within(chip).getByTestId("attachment-thumbnail")).toHaveAttribute("src", "blob:preview");

    paste(box, [new File(["MZ"], "setup.exe", { type: "application/octet-stream" })]);
    expect(screen.getByRole("alert")).toHaveTextContent("setup.exe");
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("send"));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const sent = (onSend.mock.calls[0] as unknown as [string, File[]])[1];
    expect(sent.map((f) => [f.name, f.type])).toEqual([["pasted-image-20261011-171430.png", "image/png"]]);
  });

  it("removes a pasted image with ×, and a text paste stays text", () => {
    setup(<Composer bot={undefined} botName="lead" suggestions={[]} onSend={async () => true} />);
    const box = screen.getByRole("textbox", { name: "Message lead" });
    paste(box, [new File(["x"], "image.png", { type: "image/png" })]);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove pasted-image-20261011-171430.png",
      }),
    );
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
    paste(box, [], "just text");
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });
});
