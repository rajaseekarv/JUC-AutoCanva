import { describe, expect, it } from 'vitest';
import { reviewStateFor, type DecisionRecord } from './creative-review-state';

const reviewer = { id: 'reviewer-1', name: 'Rita Reviewer' };
const decision = (
  revisionNumber: number,
  kind: DecisionRecord['decision'],
  at: string,
  creativeId = 'creative-1',
): DecisionRecord => ({
  creativeId,
  creativeRevisionId: 'revision-' + revisionNumber,
  revisionNumber,
  decision: kind,
  createdAt: new Date(at),
  reviewer,
});
const creative = (currentRevision: number, status = 'approved') => ({
  id: 'creative-1',
  status,
  currentRevisionId: 'revision-' + currentRevision,
});
const run = (revisionNumber: number, status = 'COMPLETED') => ({
  creativeId: 'creative-1',
  creativeRevisionId: 'revision-' + revisionNumber,
  status,
});

describe('reviewStateFor', () => {
  it('has no approval and keeps the stored status for a creative never reviewed', () => {
    expect(reviewStateFor(creative(1, 'DRAFT'), [], undefined)).toEqual({
      status: 'DRAFT',
      approvedRevision: null,
      currentRevisionApproved: false,
    });
  });

  it('marks the current revision approved when its latest decision is an approval', () => {
    const state = reviewStateFor(
      creative(3),
      [decision(3, 'APPROVED', '2026-11-10T12:00:00Z')],
      run(3),
    );
    expect(state.status).toBe('approved');
    expect(state.currentRevisionApproved).toBe(true);
    expect(state.approvedRevision).toEqual({
      revisionId: 'revision-3',
      revisionNumber: 3,
      approvedAt: new Date('2026-11-10T12:00:00Z'),
      reviewer,
    });
  });

  it('keeps an older approval but does not call a newer, unreviewed revision approved', () => {
    const state = reviewStateFor(
      creative(4),
      [decision(3, 'APPROVED', '2026-11-10T12:00:00Z')],
      run(3),
    );
    expect(state).toMatchObject({
      status: 'DRAFT',
      currentRevisionApproved: false,
      approvedRevision: { revisionNumber: 3 },
    });
  });

  it('uses the latest decision on the current revision (changes requested after an approval)', () => {
    const state = reviewStateFor(
      creative(2, 'changes'),
      [
        decision(2, 'CHANGES_REQUESTED', '2026-11-10T13:00:00Z'),
        decision(2, 'APPROVED', '2026-11-10T12:00:00Z'),
      ],
      run(2),
    );
    expect(state.currentRevisionApproved).toBe(false);
    expect(state.status).toBe('changes');
    expect(state.approvedRevision?.revisionNumber).toBe(2);
  });

  it('keeps the stage status while a run is active, even for an older revision', () => {
    const state = reviewStateFor(creative(2, 'review'), [], run(1, 'RUNNING'));
    expect(state.status).toBe('review');
  });

  it('ignores decisions of other creatives', () => {
    const state = reviewStateFor(
      creative(1, 'DRAFT'),
      [decision(1, 'APPROVED', '2026-11-10T12:00:00Z', 'creative-2')],
      undefined,
    );
    expect(state.approvedRevision).toBeNull();
    expect(state.currentRevisionApproved).toBe(false);
  });
});
