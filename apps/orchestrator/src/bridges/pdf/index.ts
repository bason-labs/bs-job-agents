// PDF tools (spec §6.2, §9.1): SHA-256, page info and reading-order text via pdfjs-dist.
export { sha256Bytes, sha256File } from "./hash.js";
export { copyFileVerified, pdfFileNameForFrame, Sha256MismatchError } from "./files.js";
export { A4_PORTRAIT_PT, isA4Portrait, pdfInfo, pdfInfoFromBytes, type PdfInfo, type PdfPageSize } from "./info.js";
export { PdfToolError, type PdfToolErrorCode } from "./pdfjs.js";
export {
  extractText,
  extractTextFromBytes,
  type ExtractedLine,
  type ExtractedPage,
  type ExtractedText,
  type ExtractTextOptions,
} from "./text.js";
