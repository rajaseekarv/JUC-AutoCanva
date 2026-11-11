import type { Prisma } from '@prisma/client';

// Approval belongs to the exact revision that was reviewed. A creative's
// stored status is the stage of its latest workflow run, which describes the
// revision that run reviewed; once a newer revision exists and no run is
// active, the current revision has not entered any workflow yet.
export const UNREVIEWED_REVISION_STATUS = 'DRAFT';

// The run status that means the run reached a terminal stage.
export const COMPLETED_RUN_STATUS = 'COMPLETED';

export type ApprovedRevision = {
  revisionId: string;
  revisionNumber: number;
  approvedAt: Date;
  reviewer: { id: string; name: string };
};

export type CreativeReviewState = {
  status: string;
  approvedRevision: ApprovedRevision | null;
  currentRevisionApproved: boolean;
};

export type DecisionRecord = {
  creativeId: string;
  creativeRevisionId: string;
  revisionNumber: number;
  workflowInstanceId: string;
  decision: 'APPROVED' | 'CHANGES_REQUESTED';
  createdAt: Date;
  reviewer: { id: string; name: string };
};

export type RunRecord = {
  id: string;
  creativeId: string;
  creativeRevisionId: string;
  status: string;
};

// The final approval of a run that approved its revision, or null.
//
// A revision is approved only by a whole run: the run must have completed,
// and every review decision recorded in it must be an approval. An approval
// at an earlier review stage of a run that is still running, was cancelled,
// or later had changes requested does not approve the revision. `decisions`
// must be ordered newest first.
function runApproval(
  run: RunRecord,
  decisions: readonly DecisionRecord[],
): DecisionRecord | null {
  if (run.status !== COMPLETED_RUN_STATUS) return null;
  const own = decisions.filter((item) => item.workflowInstanceId === run.id);
  if (!own.length || own.some((item) => item.decision !== 'APPROVED'))
    return null;
  return own[0]!;
}

// `decisions` and `runs` must be ordered newest first. Records of other
// creatives are ignored.
export function reviewStateFor(
  creative: { id: string; status: string; currentRevisionId: string | null },
  decisions: readonly DecisionRecord[],
  runs: readonly RunRecord[],
): CreativeReviewState {
  const ownDecisions = decisions.filter(
    (item) => item.creativeId === creative.id,
  );
  const ownRuns = runs.filter((item) => item.creativeId === creative.id);
  const latestRun = ownRuns[0];
  const runIsForOlderRevision =
    !!latestRun &&
    latestRun.status !== 'RUNNING' &&
    latestRun.creativeRevisionId !== creative.currentRevisionId;

  let approved: DecisionRecord | null = null;
  for (const run of ownRuns) {
    approved = runApproval(run, ownDecisions);
    if (approved) break;
  }
  // The current revision's standing is set by its latest completed run, so
  // a re-review that is still running or was cancelled neither grants nor
  // withdraws approval, and one that completed with changes requested
  // withdraws it.
  const latestCompletedForCurrent = ownRuns.find(
    (run) =>
      run.status === COMPLETED_RUN_STATUS &&
      run.creativeRevisionId === creative.currentRevisionId,
  );
  return {
    status: runIsForOlderRevision
      ? UNREVIEWED_REVISION_STATUS
      : creative.status,
    approvedRevision: approved
      ? {
          revisionId: approved.creativeRevisionId,
          revisionNumber: approved.revisionNumber,
          approvedAt: approved.createdAt,
          reviewer: approved.reviewer,
        }
      : null,
    currentRevisionApproved:
      !!latestCompletedForCurrent &&
      runApproval(latestCompletedForCurrent, ownDecisions) !== null,
  };
}

type ReviewStateClient = {
  approvalDecision: Pick<
    Prisma.TransactionClient['approvalDecision'],
    'findMany'
  >;
  workflowInstance: Pick<
    Prisma.TransactionClient['workflowInstance'],
    'findMany'
  >;
};

// Adds revision-specific review state to creatives of one organization with
// two queries, whatever the number of creatives.
export async function withReviewState<
  T extends { id: string; status: string; currentRevisionId: string | null },
>(
  db: ReviewStateClient,
  organizationId: string,
  creatives: T[],
): Promise<Array<T & CreativeReviewState>> {
  if (!creatives.length) return [];
  const creativeIds = creatives.map((creative) => creative.id);
  const [decisions, runs] = await Promise.all([
    db.approvalDecision.findMany({
      where: { organizationId, creativeId: { in: creativeIds } },
      select: {
        creativeId: true,
        creativeRevisionId: true,
        revisionNumber: true,
        workflowInstanceId: true,
        decision: true,
        createdAt: true,
        reviewer: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
    db.workflowInstance.findMany({
      where: { organizationId, creativeId: { in: creativeIds } },
      select: {
        id: true,
        creativeId: true,
        creativeRevisionId: true,
        status: true,
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    }),
  ]);
  return creatives.map((creative) => ({
    ...creative,
    ...reviewStateFor(
      creative,
      decisions as DecisionRecord[],
      runs as RunRecord[],
    ),
  }));
}
