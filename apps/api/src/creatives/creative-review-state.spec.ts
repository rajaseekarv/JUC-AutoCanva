import { describe, expect, it } from 'vitest';
import {
  reviewStateFor,
  type DecisionRecord,
  type RunRecord,
} from './creative-review-state';

const reviewer = { id: 'reviewer-1', name: 'Rita Reviewer' };
const secondReviewer = { id: 'reviewer-2', name: 'Sam Second' };
const decision = (
  revisionNumber: number,
  kind: DecisionRecord['decision'],
  at: string,
  runId = 'run-' + revisionNumber,
  creativeId = 'creative-1',
  by = reviewer,
): DecisionRecord => ({
  creativeId,
  creativeRevisionId: 'revision-' + revisionNumber,
  revisionNumber,
  workflowInstanceId: runId,
  decision: kind,
  createdAt: new Date(at),
  reviewer: by,
});
const creative = (currentRevision: number, status = 'approved') => ({
  id: 'creative-1',
  status,
  currentRevisionId: 'revision-' + currentRevision,
});
const run = (
  revisionNumber: number,
  status = 'COMPLETED',
  id = 'run-' + revisionNumber,
): RunRecord => ({
  id,
  creativeId: 'creative-1',
  creativeRevisionId: 'revision-' + revisionNumber,
  status,
});

describe('reviewStateFor', () => {
  it('has no approval and keeps the stored status for a creative never reviewed', () => {
    expect(reviewStateFor(creative(1, 'DRAFT'), [], [])).toEqual({
      status: 'DRAFT',
      approvedRevision: null,
      currentRevisionApproved: false,
    });
  });

  it('approves the current revision when its run completed with an approval', () => {
    const state = reviewStateFor(
      creative(3),
      [decision(3, 'APPROVED', '2026-11-10T12:00:00Z')],
      [run(3)],
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
      [run(3)],
    );
    expect(state).toMatchObject({
      status: 'DRAFT',
      currentRevisionApproved: false,
      approvedRevision: { revisionNumber: 3 },
    });
  });

  it('keeps the stage status while a run is active, even for an older revision', () => {
    const state = reviewStateFor(
      creative(2, 'review'),
      [],
      [run(1, 'RUNNING')],
    );
    expect(state.status).toBe('review');
  });

  it('ignores decisions and runs of other creatives', () => {
    const state = reviewStateFor(
      creative(1, 'DRAFT'),
      [decision(1, 'APPROVED', '2026-11-10T12:00:00Z', 'run-x', 'creative-2')],
      [{ ...run(1, 'COMPLETED', 'run-x'), creativeId: 'creative-2' }],
    );
    expect(state.approvedRevision).toBeNull();
    expect(state.currentRevisionApproved).toBe(false);
  });

  describe('multi-stage runs', () => {
    it('does not approve after the first of two review stages while the run is still running', () => {
      const state = reviewStateFor(
        creative(2, 'legal'),
        [decision(2, 'APPROVED', '2026-11-10T12:00:00Z')],
        [run(2, 'RUNNING')],
      );
      expect(state).toEqual({
        status: 'legal',
        approvedRevision: null,
        currentRevisionApproved: false,
      });
    });

    it('approves once every review stage approved and the run completed, crediting the final reviewer', () => {
      const state = reviewStateFor(
        creative(2),
        [
          decision(
            2,
            'APPROVED',
            '2026-11-10T13:00:00Z',
            'run-2',
            'creative-1',
            secondReviewer,
          ),
          decision(2, 'APPROVED', '2026-11-10T12:00:00Z'),
        ],
        [run(2)],
      );
      expect(state.currentRevisionApproved).toBe(true);
      expect(state.approvedRevision).toEqual({
        revisionId: 'revision-2',
        revisionNumber: 2,
        approvedAt: new Date('2026-11-10T13:00:00Z'),
        reviewer: secondReviewer,
      });
    });

    it('does not approve when a later stage requested changes after an earlier approval', () => {
      const state = reviewStateFor(
        creative(2, 'changes'),
        [
          decision(2, 'CHANGES_REQUESTED', '2026-11-10T13:00:00Z'),
          decision(2, 'APPROVED', '2026-11-10T12:00:00Z'),
        ],
        [run(2)],
      );
      expect(state).toEqual({
        status: 'changes',
        approvedRevision: null,
        currentRevisionApproved: false,
      });
    });
  });

  describe('incomplete runs', () => {
    it('does not approve from a cancelled run, even after an approval decision', () => {
      const state = reviewStateFor(
        creative(2, 'DRAFT'),
        [decision(2, 'APPROVED', '2026-11-10T12:00:00Z')],
        [run(2, 'CANCELLED')],
      );
      expect(state.approvedRevision).toBeNull();
      expect(state.currentRevisionApproved).toBe(false);
    });

    it('does not approve from a completed run that recorded no decision', () => {
      const state = reviewStateFor(creative(1, 'published'), [], [run(1)]);
      expect(state.approvedRevision).toBeNull();
      expect(state.currentRevisionApproved).toBe(false);
    });

    it('falls back to the last fully approved revision when a newer run was cancelled', () => {
      const state = reviewStateFor(
        creative(2, 'DRAFT'),
        [
          decision(2, 'APPROVED', '2026-11-11T12:00:00Z'),
          decision(1, 'APPROVED', '2026-11-10T12:00:00Z'),
        ],
        [run(2, 'CANCELLED'), run(1)],
      );
      expect(state.currentRevisionApproved).toBe(false);
      expect(state.approvedRevision).toMatchObject({
        revisionNumber: 1,
        approvedAt: new Date('2026-11-10T12:00:00Z'),
      });
    });
  });

  describe('re-reviews of the same revision', () => {
    it('keeps an approval while a re-review of that revision is still running', () => {
      const state = reviewStateFor(
        creative(2, 'review'),
        [decision(2, 'APPROVED', '2026-11-10T12:00:00Z', 'run-a')],
        [run(2, 'RUNNING', 'run-b'), run(2, 'COMPLETED', 'run-a')],
      );
      expect(state.currentRevisionApproved).toBe(true);
      expect(state.approvedRevision?.revisionNumber).toBe(2);
    });

    it('keeps an approval when a re-review of that revision was cancelled', () => {
      const state = reviewStateFor(
        creative(2, 'DRAFT'),
        [decision(2, 'APPROVED', '2026-11-10T12:00:00Z', 'run-a')],
        [run(2, 'CANCELLED', 'run-b'), run(2, 'COMPLETED', 'run-a')],
      );
      expect(state.currentRevisionApproved).toBe(true);
    });

    it('withdraws the current approval when a completed re-review requested changes, but keeps the history', () => {
      const state = reviewStateFor(
        creative(2, 'changes'),
        [
          decision(2, 'CHANGES_REQUESTED', '2026-11-11T12:00:00Z', 'run-b'),
          decision(2, 'APPROVED', '2026-11-10T12:00:00Z', 'run-a'),
        ],
        [run(2, 'COMPLETED', 'run-b'), run(2, 'COMPLETED', 'run-a')],
      );
      expect(state.currentRevisionApproved).toBe(false);
      // The earlier run did approve revision 2; that history is kept.
      expect(state.approvedRevision).toMatchObject({
        revisionNumber: 2,
        approvedAt: new Date('2026-11-10T12:00:00Z'),
      });
    });
  });
});
