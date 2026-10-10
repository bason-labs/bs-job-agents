// Test support for other workers' tests (engine W2a): fake Figma bridge and generated PDFs.
// Never imported by production code (test-pdfs needs the pdf-lib devDependency).
export { FakeFigmaMcp, type FakeExecuteHandler, type FakeFigmaFile, type FakeFigmaMcpOptions } from "./figma/fake-bridge.js";
export { FakeFigmaApi, FakeNode, FakePage, runPluginCode, type FakeFigmaApiInit, type FakeNodeInit } from "./figma/fake-figma-api.js";
export { BRIDGE_OPS, bridgeOpOf, type BridgeOp } from "./figma/plugin-code.js";
export { A4, FIGMA_A4, LETTER, makePdf, writePdf, type FixturePage, type FixtureRun } from "./pdf/test-pdfs.js";
