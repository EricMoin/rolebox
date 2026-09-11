/**
 * Checkpoint persistence — mid-execution resume support for dispatch tasks.
 *
 * CheckpointData and CheckpointStore interface are defined in
 * `../types.checkpoint.ts`. This module provides the filesystem-based
 * implementation `FileSystemCheckpointStore`.
 *
 * @module
 */

export { FileSystemCheckpointStore } from "./checkpoint-store.ts";
export type { CheckpointData, CheckpointStore } from "../types.checkpoint.ts";
