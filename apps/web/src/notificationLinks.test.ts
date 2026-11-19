import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  notificationDestination,
  recordModules,
  type RecordModules,
} from './notificationLinks';
import type { Notice } from './useNotifications';

const all: RecordModules = {
  approvals: true,
  creatives: true,
  workflows: true,
};
const notice = (type: string, extra: Partial<Notice> = {}): Notice => ({
  id: 'n-1',
  title: 'Title',
  message: 'Message',
  type,
  createdAt: '2026-01-01T00:00:00Z',
  readAt: null,
  entityType: 'creative',
  entityId: 'entity-1',
  branchId: 'branch-1',
  creativeId: 'creative-1',
  workflowInstanceId: 'instance-1',
  ...extra,
});

describe('notificationDestination', () => {
  it('opens the review for REVIEW_TASK_ASSIGNED by workflow run', () => {
    expect(
      notificationDestination(notice('REVIEW_TASK_ASSIGNED'), all),
    ).toEqual({
      kind: 'review',
      label: 'Open review',
      workflowInstanceId: 'instance-1',
      creativeId: 'creative-1',
      branchId: 'branch-1',
    });
  });

  it.each([
    ['CHANGE_REQUEST_CREATED', 'creatives'],
    ['CREATIVE_APPROVED', 'creatives'],
    ['REVIEW_COMMENT_ADDED', 'creatives'],
    ['WORKFLOW_CANCELLED', 'workflows'],
    ['WORKFLOW_TASK_ASSIGNED', 'workflows'],
  ])('opens the creative for %s in %s', (type, module) => {
    expect(notificationDestination(notice(type), all)).toEqual({
      kind: 'creative',
      label: 'Open creative',
      module,
      creativeId: 'creative-1',
      branchId: 'branch-1',
    });
  });

  it.each(['CHANGE_REQUEST.RESOLVED', 'ACKNOWLEDGE', 'SOMETHING_NEW'])(
    'offers nothing for %s',
    (type) => {
      expect(notificationDestination(notice(type), all)).toBeNull();
    },
  );

  it('offers nothing without the ID the destination needs', () => {
    expect(
      notificationDestination(
        notice('REVIEW_TASK_ASSIGNED', { workflowInstanceId: null }),
        all,
      ),
    ).toBeNull();
    expect(
      notificationDestination(
        notice('CREATIVE_APPROVED', { creativeId: undefined }),
        all,
      ),
    ).toBeNull();
    expect(
      notificationDestination(
        notice('WORKFLOW_CANCELLED', { creativeId: '' }),
        all,
      ),
    ).toBeNull();
  });

  it('keeps a missing branch as null for the caller to resolve', () => {
    expect(
      notificationDestination(
        notice('CREATIVE_APPROVED', { branchId: null }),
        all,
      ),
    ).toMatchObject({ branchId: null });
  });

  it('offers nothing for a screen the user cannot open', () => {
    const none: RecordModules = {
      approvals: false,
      creatives: false,
      workflows: false,
    };
    for (const type of [
      'REVIEW_TASK_ASSIGNED',
      'CHANGE_REQUEST_CREATED',
      'WORKFLOW_CANCELLED',
    ])
      expect(notificationDestination(notice(type), none)).toBeNull();
    // Without Creatives, a review link has no creative to fall back to.
    expect(
      notificationDestination(notice('REVIEW_TASK_ASSIGNED'), {
        ...all,
        creatives: false,
      }),
    ).toMatchObject({ kind: 'review', creativeId: null });
  });

  it('ignores the internal event key entirely', () => {
    // An event key naming other records changes nothing.
    const misleading = {
      ...notice('REVIEW_TASK_ASSIGNED'),
      eventKey: 'workflow-task:task-other:instance-other',
    } as Notice;
    expect(notificationDestination(misleading, all)).toMatchObject({
      workflowInstanceId: 'instance-1',
    });
    for (const file of [
      './notificationLinks.ts',
      './useRecordLinks.ts',
      './ActivityWorkspaces.tsx',
      './ApprovalsWorkspace.tsx',
    ])
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toMatch(
        /eventKey/,
      );
  });
});

describe('recordModules', () => {
  it('follows the permissions that offer each screen', () => {
    expect(recordModules([])).toEqual({
      approvals: false,
      creatives: false,
      workflows: false,
    });
    expect(
      recordModules(['approvals:read', 'creatives:read', 'workflows:read']),
    ).toEqual({ approvals: true, creatives: true, workflows: true });
    // Workflows lists creatives only with workflows:start or creatives:read.
    expect(recordModules(['workflows:read']).workflows).toBe(false);
    expect(recordModules(['workflows:start']).workflows).toBe(true);
  });
});
