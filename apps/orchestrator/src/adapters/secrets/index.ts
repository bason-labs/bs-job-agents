// AD-4: board credentials (FileSecretStore) and the redactor. Only adapters/board-api and
// engine/wiring.ts import this folder.
export { FileSecretStore, SecretsFileRefusedError, defaultSecretsFile, type FileSecretStoreOptions } from "./file-store.js";
export { MIN_REDACTED_LENGTH, REDACTED, Redactor } from "./redactor.js";
