import { parseRichText } from "./model";

/** Message text: `**bold**` and line breaks, nothing else (bot output is never HTML). */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {parseRichText(text).map((seg, i) => (seg.bold ? <b key={i}>{seg.text}</b> : <span key={i}>{seg.text}</span>))}
    </>
  );
}
