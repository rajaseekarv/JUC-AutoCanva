import type { CreativeResponse } from '@adflow/shared-types';

export type ApprovalState = Pick<
  CreativeResponse,
  'approvedRevision' | 'currentRevisionApproved' | 'currentRevision'
>;

// Approval belongs to the exact revision reviewed, so this says which
// revision was approved and whether the current revision is.
export function approvalSummaryText(creative: ApprovalState): string | null {
  const current = creative.currentRevision?.revisionNumber;
  if (creative.currentRevisionApproved && current !== undefined)
    return 'Current revision ' + current + ' approved';
  const approved = creative.approvedRevision;
  if (!approved) return null;
  if (current === approved.revisionNumber)
    return 'Revision ' + current + ' was approved, then changes were requested';
  return (
    'Revision ' +
    approved.revisionNumber +
    ' approved' +
    (current !== undefined
      ? ' · current revision ' + current + ' not yet approved'
      : '')
  );
}
