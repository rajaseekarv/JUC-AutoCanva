// Test support (not a test file): fixtures and a stubbed API for tests
// that render the whole app with a signed-in user who can work on two
// branches. Shared by the notification-link (Phase 2B step 4) and
// unsaved-edit (step 5) tests.
import { vi } from 'vitest';

// ------------------------------------------------------------------ fixtures

export const BRANCHES = [
  { id: 'branch-1', name: 'North', code: 'NORTH' },
  { id: 'branch-2', name: 'South', code: 'SOUTH' },
];
export const user = {
  id: 'user-1',
  organizationId: 'org-1',
  name: 'Nina Notify',
  email: 'nina@example.local',
  permissions: [
    'creatives:read',
    'creatives:create',
    'creatives:update',
    'templates:read',
    'workflows:read',
    'workflows:start',
    'approvals:read',
    'approvals:decide',
  ],
  branches: BRANCHES,
};
const field = {
  id: 'field-1',
  key: 'headline',
  label: 'Headline',
  type: 'TEXT',
  required: true,
  defaultValue: null,
  validationRules: null,
  helpText: null,
  displayOrder: 0,
  dataSource: null,
  sourceKey: null,
};
const version = {
  id: 'version-1',
  templateId: 'template-1',
  versionNumber: 1,
  name: 'Social post',
  description: null,
  category: null,
  formatName: 'Square',
  width: 1080,
  height: 1080,
  unit: 'PX',
  immutableAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  fields: [field],
};
const template = {
  id: 'template-1',
  name: 'Social post',
  code: 'social',
  description: null,
  category: null,
  status: 'ACTIVE',
  formatName: 'Square',
  width: 1080,
  height: 1080,
  unit: 'PX',
  currentVersionNumber: 1,
  activeVersionNumber: 1,
  updatedAt: '2026-01-01T00:00:00Z',
};
const creative = (id: string, name: string, branchId: string) => ({
  id,
  organizationId: 'org-1',
  branchId,
  campaignId: null,
  name,
  status: 'DRAFT',
  currentRevisionId: 'rev-' + id,
  currentRevision: {
    id: 'rev-' + id,
    revisionNumber: 2,
    templateVersionId: 'version-1',
    values: { headline: name + ' headline' },
    summary: null,
    createdById: 'user-1',
    createdAt: '2026-01-01T00:00:00Z',
    templateVersion: version,
  },
});
const CREATIVES: Record<string, ReturnType<typeof creative>[]> = {
  'branch-1': [
    creative('creative-1', 'Spring post', 'branch-1'),
    creative('creative-2', 'Summer post', 'branch-1'),
  ],
  'branch-2': [creative('creative-3', 'Autumn post', 'branch-2')],
};
const task = (id: string, instanceId: string, creativeId: string) => ({
  id,
  status: 'OPEN',
  createdAt: '2026-01-02T00:00:00Z',
  stage: { id: 'stage-review', key: 'review', name: 'Review' },
  instance: {
    id: instanceId,
    branchId: 'branch-1',
    currentStageId: 'stage-review',
    creativeRevisionId: 'rev-' + creativeId,
    creative: {
      id: creativeId,
      name: creativeId === 'creative-1' ? 'Spring post' : 'Summer post',
      currentRevisionId: 'rev-' + creativeId,
      currentRevision: { revisionNumber: 2 },
    },
  },
});
const review = (taskId: string, creativeId: string, name: string) => ({
  task: {
    id: taskId,
    status: 'OPEN',
    stage: { key: 'review', name: 'Review' },
  },
  workflow: { id: 'workflow-1', name: 'Branch review' },
  creative: {
    id: creativeId,
    name,
    branchId: 'branch-1',
    currentRevisionId: 'rev-' + creativeId,
  },
  revision: {
    id: 'rev-' + creativeId,
    creativeId,
    revisionNumber: 2,
    values: { headline: name + ' headline' },
    templateVersion: {
      fields: [{ key: 'headline', label: 'Headline', type: 'TEXT' }],
    },
  },
  submittedByViewer: false,
  current: true,
});

export type NoticeFixture = Record<string, unknown> & {
  id: string;
  title: string;
};
export const notice = (
  id: string,
  type: string,
  title: string,
  ids: {
    branchId?: string | null;
    creativeId?: string | null;
    workflowInstanceId?: string | null;
  },
): NoticeFixture => ({
  id,
  title,
  message: title + ' message',
  type,
  createdAt: '2026-01-03T00:00:00Z',
  readAt: null,
  entityType: 'workflow_instance',
  entityId: 'entity-' + id,
  // Deliberately misleading: navigation must never read it.
  eventKey: 'workflow-task:task-wrong:instance-wrong:creative-wrong',
  branchId: 'branch-1',
  creativeId: null,
  workflowInstanceId: null,
  ...ids,
});

// ---------------------------------------------------------------- fake API

type Held = { url: string; release: () => void };
export function fakeApi(notices: NoticeFixture[]) {
  const api = {
    notices,
    tasks: [
      task('task-2', 'instance-2', 'creative-2'),
      task('task-1', 'instance-1', 'creative-1'),
    ],
    failTasks: false,
    failBranch: '',
    hold: new Set<string>(),
    held: [] as Held[],
    calls: [] as string[],
  };
  const respond = (status: number, body: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (body === null ? '' : JSON.stringify(body)),
    }) as Response;
  const route = (method: string, path: string, search: URLSearchParams) => {
    if (path === '/health') return respond(200, { status: 'ok', checks: {} });
    if (path === '/auth/me') return respond(200, user);
    const branch = /^\/branches\/([^/]+)$/.exec(path);
    if (branch) {
      const found = BRANCHES.find((item) => item.id === branch[1]);
      if (!found || api.failBranch === branch[1])
        return respond(500, { message: 'Branch unavailable' });
      return respond(200, { ...found, status: 'ACTIVE' });
    }
    if (path === '/notifications/unread-count')
      return respond(200, {
        count: api.notices.filter((item) => !item.readAt).length,
      });
    if (path === '/notifications' && method === 'GET')
      return respond(200, api.notices);
    const read = /^\/notifications\/([^/]+)\/read$/.exec(path);
    if (read && method === 'POST') {
      const item = api.notices.find((entry) => entry.id === read[1]);
      if (item) item.readAt = '2026-01-04T00:00:00Z';
      return respond(200, item ?? {});
    }
    if (path === '/creatives')
      return respond(200, CREATIVES[search.get('branchId') ?? ''] ?? []);
    if (path === '/templates') return respond(200, [template]);
    if (path === '/templates/template-1')
      return respond(200, { ...template, versions: [version] });
    if (/^\/creatives\/[^/]+\/workflow$/.test(path)) return respond(200, null);
    if (path === '/approvals/tasks')
      return api.failTasks
        ? respond(500, { message: 'Reviews unavailable' })
        : respond(200, api.tasks);
    if (path === '/approvals/tasks/task-1')
      return respond(200, review('task-1', 'creative-1', 'Spring post'));
    if (path === '/approvals/tasks/task-2')
      return respond(200, review('task-2', 'creative-2', 'Summer post'));
    if (method === 'GET') return respond(200, []);
    return respond(404, {});
  };
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = init?.method ?? 'GET';
    const call = `${method} ${path}${url.search}`;
    api.calls.push(call);
    if (api.hold.has(path + url.search))
      await new Promise<void>((resolve) =>
        api.held.push({ url: path + url.search, release: resolve }),
      );
    // Like a real fetch, an aborted request rejects.
    if (init?.signal?.aborted)
      throw new DOMException('The operation was aborted.', 'AbortError');
    return route(method, path, url.searchParams);
  });
  vi.stubGlobal('fetch', fetchMock);
  return api;
}

export const readCalls = (api: ReturnType<typeof fakeApi>) =>
  api.calls.filter((call) => /^POST \/notifications\/.+\/read$/.test(call));
