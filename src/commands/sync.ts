import type { ExtractionPacket } from '../extraction/packet.js';
import { prepareCapture, type CaptureInput } from './capture.js';

/** Input for preparing a sync capture packet (same shape as capture prepare). */
export type SyncInput = CaptureInput;

/**
 * Prepare a redacted extraction packet for the Skill-driven sync workflow.
 * Sync orchestration remains Skill-driven: prepare → proposal → capture
 * preview/apply → apply preview/apply.
 */
export async function syncPrepare(input: SyncInput): Promise<ExtractionPacket> {
  return prepareCapture(input);
}
