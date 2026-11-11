import { describe, expect, it } from 'vitest';
import { approvalSummaryText } from './approvalText';

const approvedRevision = (revisionNumber: number) => ({
  revisionId: 'revision-' + revisionNumber,
  revisionNumber,
  approvedAt: '2026-11-10T12:00:00.000Z',
  reviewer: { id: 'reviewer-1', name: 'Rita Reviewer' },
});
type Summary = Parameters<typeof approvalSummaryText>[0];
const atRevision = (revisionNumber: number) =>
  ({ revisionNumber }) as Summary['currentRevision'];

describe('approvalSummaryText', () => {
  it('says nothing for a creative never approved', () => {
    expect(
      approvalSummaryText({
        approvedRevision: null,
        currentRevisionApproved: false,
        currentRevision: atRevision(1),
      }),
    ).toBeNull();
  });

  it('names the current revision when it is the approved one', () => {
    expect(
      approvalSummaryText({
        approvedRevision: approvedRevision(3),
        currentRevisionApproved: true,
        currentRevision: atRevision(3),
      }),
    ).toBe('Current revision 3 approved');
  });

  // Regression (Stage 11 E2E): "Approved · Revision 4" was shown although
  // only revision 3 had been approved.
  it('names the older approved revision and says the current one is not approved', () => {
    expect(
      approvalSummaryText({
        approvedRevision: approvedRevision(3),
        currentRevisionApproved: false,
        currentRevision: atRevision(4),
      }),
    ).toBe('Revision 3 approved · current revision 4 not yet approved');
  });

  it('does not claim approval when changes were requested after approving the same revision', () => {
    expect(
      approvalSummaryText({
        approvedRevision: approvedRevision(2),
        currentRevisionApproved: false,
        currentRevision: atRevision(2),
      }),
    ).toBe('Revision 2 was approved, then changes were requested');
  });
});
