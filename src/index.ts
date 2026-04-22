/**
 * Encrypted storage with change detection using PouchDB
 * Simple API with AES-256-GCM encryption
 * @packageDocumentation
 */

export { EncryptedPouch } from "./encryptedPouch.js";
export type {
  Doc,
  NewDoc,
  DocRef,
  PouchListener,
  DecryptionErrorEvent,
  WriteErrorEvent,
  ErrorEvent,
  ConflictInfo,
  SyncInfo,
  RemoteOptions,
  EncryptedPouchOptions,
} from "./encryptedPouch.js";

export { EncryptionHelper, DecryptionError } from "./encryption.js";
export type { CryptoInterface } from "./encryption.js";

export { VERSION } from "./version.js";

// Re-export PouchDB for convenience
// Use pouchdb-browser for Vite/browser compatibility
import PouchDB from "pouchdb-browser";
export { PouchDB };
