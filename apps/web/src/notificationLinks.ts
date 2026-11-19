import type { Notice } from './useNotifications';

// Where a notification's action leads. Only the notification's own type and
// ID fields are used; its internal event key is never read.
export type RecordDestination =
  | {
      kind: 'review';
      label: 'Open review';
      workflowInstanceId: string;
      // Used to offer the creative instead when the review is no longer
      // waiting for the user.
      creativeId: string | null;
      branchId: string | null;
    }
  | {
      kind: 'creative';
      label: 'Open creative';
      module: 'creatives' | 'workflows';
      creativeId: string;
      branchId: string | null;
    };

// Creative-related types and the screen that shows them: change requests,
// approvals and review comments are worked on in Creatives; workflow events
// in Workflows.
const CREATIVE_MODULES: Record<string, 'creatives' | 'workflows'> = {
  CHANGE_REQUEST_CREATED: 'creatives',
  CREATIVE_APPROVED: 'creatives',
  REVIEW_COMMENT_ADDED: 'creatives',
  WORKFLOW_CANCELLED: 'workflows',
  WORKFLOW_TASK_ASSIGNED: 'workflows',
};

// The screens the signed-in user may open, by permission (the same rules
// App uses to offer the modules).
export type RecordModules = {
  approvals: boolean;
  creatives: boolean;
  workflows: boolean;
};

export function recordModules(permissions: readonly string[]): RecordModules {
  const has = (permission: string) => permissions.includes(permission);
  return {
    approvals: has('approvals:read'),
    creatives: has('creatives:read'),
    // Workflows lists a branch's creatives only with one of these.
    workflows:
      (has('workflows:read') || has('workflows:start')) &&
      (has('workflows:start') || has('creatives:read')),
  };
}

const present = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.length > 0;

// The action for a notification, or null when it has none: an unknown type,
// a missing ID, or a destination screen the user cannot open.
export function notificationDestination(
  notice: Notice,
  modules: RecordModules,
): RecordDestination | null {
  const creativeId = present(notice.creativeId) ? notice.creativeId : null;
  const branchId = present(notice.branchId) ? notice.branchId : null;
  if (notice.type === 'REVIEW_TASK_ASSIGNED') {
    if (!present(notice.workflowInstanceId) || !modules.approvals) return null;
    return {
      kind: 'review',
      label: 'Open review',
      workflowInstanceId: notice.workflowInstanceId,
      creativeId: modules.creatives ? creativeId : null,
      branchId,
    };
  }
  const module = CREATIVE_MODULES[notice.type];
  if (!module || !creativeId || !modules[module]) return null;
  return {
    kind: 'creative',
    label: 'Open creative',
    module,
    creativeId,
    branchId,
  };
}
