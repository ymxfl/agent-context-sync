import type { AgentName } from '../adapters/adapter.js';
import { applyRendered, type ApplyResult } from '../apply/atomic-apply.js';
import { previewApply, type ApplyInput, type ApplyPreview } from '../apply/preview.js';

export type { ApplyInput, ApplyPreview, ApplyResult };

/** Preview compiled Agent files for the requested workspace agents. */
export async function previewApplyCommand(input: ApplyInput): Promise<ApplyPreview> {
  return previewApply(input);
}

/** Apply an approved render preview by opaque preview id. */
export async function applyRenderedCommand(
  previewId: string,
  home: string,
): Promise<ApplyResult> {
  return applyRendered(previewId, home);
}

export { previewApply, applyRendered };

export type ApplyAgentsInput = Omit<ApplyInput, 'agents'> & {
  agents?: readonly AgentName[];
};
