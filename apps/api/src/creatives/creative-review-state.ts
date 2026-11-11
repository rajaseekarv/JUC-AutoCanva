import type { Prisma } from '@prisma/client';

// Approval belongs to the exact revision that was reviewed. A creative's
// stored status is the stage of its latest workflow run, which describes the
// revision that run reviewed; once a newer revision exists and no run is
// active, the current revision has not entered any workflow yet.
export const UNREVIEWED_REVISION_STATUS = 'DRAFT';

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
  decision: 'APPROVED' | 'CHANGES_REQUESTED';
  createdAt: Date;
  reviewer: { id: string; name: string };
};

export type LatestRunRecord = {
  creativeId: string;
  creativeRevisionId: string;
  status: string;
};

// `decisions` must be ordered newest first.
export function reviewStateFor(
  creative: { id: string; status: string; currentRevisionId: string | null },
  decisions: readonly DecisionRecord[],
  latestRun: LatestRunRecord | undefined,
): CreativeReviewState {
  const own = decisions.filter((item) => item.creativeId === creative.id);
  const approved = own.find((item) => item.decision === 'APPROVED');
  const currentDecision = own.find(
    (item) => item.creativeRevisionId === creative.currentRevisionId,
  );
  const runIsForOlderRevision =
    !!latestRun &&
    latestRun.status !== 'RUNNING' &&
    latestRun.creativeRevisionId !== creative.currentRevisionId;
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
    currentRevisionApproved: currentDecision?.decision === 'APPROVED',
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
        decision: true,
        createdAt: true,
        reviewer: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
    db.workflowInstance.findMany({
      where: { organizationId, creativeId: { in: creativeIds } },
      select: { creativeId: true, creativeRevisionId: true, status: true },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      distinct: ['creativeId'],
    }),
  ]);
  const latestRuns = new Map(runs.map((run) => [run.creativeId, run]));
  return creatives.map((creative) => ({
    ...creative,
    ...reviewStateFor(
      creative,
      decisions as DecisionRecord[],
      latestRuns.get(creative.id),
    ),
  }));
}
