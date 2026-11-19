// Phase 2B step 4: following a notification to the record it is about,
// through the whole app (App, Notifications, Creatives, Workflows and
// Approvals) with a stubbed API.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import App from './App';
import { SESSION_STORAGE_KEY } from './authStorage';
import { RECORD_LINK_MESSAGES } from './useRecordLinks';
import { fakeApi, notice, readCalls, type NoticeFixture } from './appTestApi';

// ------------------------------------------------------------------ helpers

beforeEach(() => {
  localStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({
      accessToken: 'token-1',
      expiresAt: Date.now() + 3600_000,
    }),
  );
  window.history.replaceState(null, '', '/#notifications');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

async function startOnNotifications(notices: NoticeFixture[]) {
  const api = fakeApi(notices);
  render(<App />);
  await screen.findByText('Hello, Nina Notify.');
  await screen.findByText(notices[0]!.title);
  // The first branch's creatives have loaded.
  await waitFor(() =>
    expect(api.calls).toContain('GET /creatives?branchId=branch-1'),
  );
  return api;
}
const item = (title: string) =>
  screen.getByText(title).closest('li') as HTMLElement;
const linkFor = (title: string, name: RegExp | string) =>
  within(item(title)).getByRole('button', { name });
async function navigate(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}
// A creative's row in the Creatives list (names also appear elsewhere).
async function creativeRow(name: string) {
  const list = (
    await screen.findByRole('heading', { level: 3, name: 'Branch creatives' })
  ).closest('section') as HTMLElement;
  return (await within(list).findByText(name)).closest('li') as HTMLElement;
}
const creativeForm = () =>
  screen.findByRole('heading', { level: 3, name: /^Edit / });
// No internal identifier reaches the screen's text.
function expectNoRawIds() {
  expect(document.body.textContent).not.toMatch(
    /creative-\d|instance-\d|branch-\d|task-\d|entity-|rev-creative|workflow-task/,
  );
}

// -------------------------------------------------------------------- tests

describe('notification links', () => {
  it.each([
    ['CHANGE_REQUEST_CREATED', 'Changes requested'],
    ['CREATIVE_APPROVED', 'Creative approved'],
    ['REVIEW_COMMENT_ADDED', 'New review comment'],
  ])(
    '%s opens the creative in Creatives and then marks it read',
    async (type, title) => {
      const api = await startOnNotifications([
        notice('n-1', type, title, { creativeId: 'creative-2' }),
      ]);
      fireEvent.click(linkFor(title, 'Open creative'));
      expect(await creativeForm()).toHaveTextContent('Edit Summer post');
      expect(window.location.hash).toBe('#creatives');
      expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue(
        'Summer post',
      );
      await waitFor(() =>
        expect(readCalls(api)).toEqual(['POST /notifications/n-1/read']),
      );
    },
  );

  it.each([
    ['WORKFLOW_CANCELLED', 'Workflow cancelled'],
    ['WORKFLOW_TASK_ASSIGNED', 'Workflow task assigned'],
  ])(
    '%s opens the creative in Workflows and then marks it read',
    async (type, title) => {
      const api = await startOnNotifications([
        notice('n-1', type, title, { creativeId: 'creative-2' }),
      ]);
      fireEvent.click(linkFor(title, 'Open creative'));
      await waitFor(() => expect(window.location.hash).toBe('#workflows'));
      const picker = screen.getByRole('combobox', { name: 'Branch creative' });
      expect(picker).toHaveValue('creative-2');
      expect(
        (picker as HTMLSelectElement).selectedOptions[0]?.textContent,
      ).toMatch(/^Summer post/);
      await waitFor(() =>
        expect(readCalls(api)).toEqual(['POST /notifications/n-1/read']),
      );
    },
  );

  it('offers no link for other types or missing IDs', async () => {
    await startOnNotifications([
      notice('n-1', 'CHANGE_REQUEST.RESOLVED', 'Request resolved', {
        creativeId: 'creative-1',
      }),
      notice('n-2', 'CREATIVE_APPROVED', 'Approved without creative', {}),
      notice('n-3', 'REVIEW_TASK_ASSIGNED', 'Review without run', {}),
    ]);
    for (const title of [
      'Request resolved',
      'Approved without creative',
      'Review without run',
    ]) {
      expect(
        within(item(title)).queryByRole('button', { name: /^Open/ }),
      ).toBeNull();
      expect(
        within(item(title)).getByRole('button', { name: 'Mark read' }),
      ).toBeInTheDocument();
    }
  });

  it('describes each link by its notification title', async () => {
    await startOnNotifications([
      notice('n-1', 'CREATIVE_APPROVED', 'Creative approved', {
        creativeId: 'creative-2',
      }),
    ]);
    expect(
      linkFor('Creative approved', 'Open creative'),
    ).toHaveAccessibleDescription('Creative approved');
  });
});

describe('review links', () => {
  it('opens the pending review found by its workflow run, not the event key', async () => {
    const api = await startOnNotifications([
      notice('n-1', 'REVIEW_TASK_ASSIGNED', 'Review task assigned', {
        workflowInstanceId: 'instance-1',
        creativeId: 'creative-1',
      }),
    ]);
    fireEvent.click(linkFor('Review task assigned', 'Open review'));
    await waitFor(() => expect(window.location.hash).toBe('#approvals'));
    const detail = await screen.findByRole('region', { name: 'Review detail' });
    expect(
      await within(detail).findByRole('heading', { name: /^Spring post/ }),
    ).toBeInTheDocument();
    // The task list was reloaded for the lookup, and the matching task
    // (task-1, not the first listed) was opened.
    expect(api.calls).toContain('GET /approvals/tasks/task-1');
    expect(api.calls).not.toContain('GET /approvals/tasks/task-2');
    await waitFor(() =>
      expect(readCalls(api)).toEqual(['POST /notifications/n-1/read']),
    );
  });

  it('explains a review no longer waiting, keeps it unread, and offers the creative', async () => {
    const api = await startOnNotifications([
      notice('n-1', 'REVIEW_TASK_ASSIGNED', 'Review task assigned', {
        workflowInstanceId: 'instance-decided',
        creativeId: 'creative-1',
      }),
    ]);
    const tasksBefore = api.calls.filter(
      (call) => call === 'GET /approvals/tasks',
    ).length;
    fireEvent.click(linkFor('Review task assigned', 'Open review'));
    expect(
      await within(item('Review task assigned')).findByText(
        RECORD_LINK_MESSAGES.reviewGone,
      ),
    ).toBeInTheDocument();
    // Only the user's pending tasks were searched, freshly loaded.
    expect(
      api.calls.filter((call) => call === 'GET /approvals/tasks').length,
    ).toBe(tasksBefore + 1);
    expect(window.location.hash).toBe('#notifications');
    expect(readCalls(api)).toEqual([]);
    expect(item('Review task assigned')).toHaveAccessibleName(
      'Unread notification',
    );
    expectNoRawIds();

    fireEvent.click(
      within(item('Review task assigned')).getByRole('button', {
        name: 'Open creative instead',
      }),
    );
    expect(await creativeForm()).toHaveTextContent('Edit Spring post');
    expect(window.location.hash).toBe('#creatives');
    await waitFor(() =>
      expect(readCalls(api)).toEqual(['POST /notifications/n-1/read']),
    );
  });

  it('keeps the notification unread when the reviews cannot be loaded', async () => {
    const api = await startOnNotifications([
      notice('n-1', 'REVIEW_TASK_ASSIGNED', 'Review task assigned', {
        workflowInstanceId: 'instance-1',
        creativeId: 'creative-1',
      }),
    ]);
    api.failTasks = true;
    fireEvent.click(linkFor('Review task assigned', 'Open review'));
    expect(
      await within(item('Review task assigned')).findByText(
        RECORD_LINK_MESSAGES.reviewsUnavailable,
      ),
    ).toBeInTheDocument();
    // A failed load is not "no longer waiting": no creative fallback.
    expect(
      within(item('Review task assigned')).queryByRole('button', {
        name: 'Open creative instead',
      }),
    ).toBeNull();
    expect(readCalls(api)).toEqual([]);
    expect(window.location.hash).toBe('#notifications');
  });
});

describe('branches', () => {
  it('switches to another accessible branch and waits for its creatives before selecting', async () => {
    const api = await startOnNotifications([
      notice('n-1', 'CREATIVE_APPROVED', 'Creative approved', {
        branchId: 'branch-2',
        creativeId: 'creative-3',
      }),
    ]);
    api.hold.add('/creatives?branchId=branch-2');
    fireEvent.click(linkFor('Creative approved', 'Open creative'));
    await waitFor(() => expect(api.held.length).toBeGreaterThan(0));
    // Still loading: nothing selected, nothing marked, no navigation.
    expect(
      within(item('Creative approved')).getByRole('button', {
        name: 'Opening…',
      }),
    ).toBeDisabled();
    expect(window.location.hash).toBe('#notifications');
    expect(readCalls(api)).toEqual([]);
    api.hold.clear();
    await act(async () => {
      for (const held of api.held.splice(0)) held.release();
    });
    expect(await creativeForm()).toHaveTextContent('Edit Autumn post');
    expect(window.location.hash).toBe('#creatives');
    expect(
      screen.getByRole('heading', { name: 'Creatives · South' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(readCalls(api)).toEqual(['POST /notifications/n-1/read']),
    );
  });

  it('never switches to a branch outside the user list', async () => {
    const api = await startOnNotifications([
      notice('n-1', 'CREATIVE_APPROVED', 'Creative approved', {
        branchId: 'branch-9',
        creativeId: 'creative-9',
      }),
    ]);
    fireEvent.click(linkFor('Creative approved', 'Open creative'));
    expect(
      await within(item('Creative approved')).findByText(
        RECORD_LINK_MESSAGES.inaccessibleBranch,
      ),
    ).toBeInTheDocument();
    expect(api.calls.some((call) => call.includes('branch-9'))).toBe(false);
    expect(readCalls(api)).toEqual([]);
    expect(window.location.hash).toBe('#notifications');
    expectNoRawIds();
  });

  it('explains a branch that cannot be loaded and keeps the notification unread', async () => {
    const api = await startOnNotifications([
      notice('n-1', 'CREATIVE_APPROVED', 'Creative approved', {
        branchId: 'branch-2',
        creativeId: 'creative-3',
      }),
    ]);
    api.failBranch = 'branch-2';
    fireEvent.click(linkFor('Creative approved', 'Open creative'));
    expect(
      await within(item('Creative approved')).findByText(
        "We couldn't open the South branch. Please try again.",
      ),
    ).toBeInTheDocument();
    expect(readCalls(api)).toEqual([]);
    expect(window.location.hash).toBe('#notifications');
  });

  it('explains a creative that is no longer in its branch without showing IDs', async () => {
    const api = await startOnNotifications([
      notice('n-1', 'CREATIVE_APPROVED', 'Creative approved', {
        creativeId: 'creative-gone',
      }),
    ]);
    fireEvent.click(linkFor('Creative approved', 'Open creative'));
    expect(
      await within(item('Creative approved')).findByText(
        'This creative is no longer available in the North branch.',
      ),
    ).toBeInTheDocument();
    expect(readCalls(api)).toEqual([]);
    expect(item('Creative approved')).toHaveAccessibleName(
      'Unread notification',
    );
    expect(window.location.hash).toBe('#notifications');
    expect(document.body.textContent).not.toContain('creative-gone');
    expectNoRawIds();
  });
});

describe('unsaved creative edits', () => {
  async function editSpringPost() {
    await navigate('#creatives');
    const spring = await creativeRow('Spring post');
    fireEvent.click(within(spring).getByRole('button', { name: 'Open' }));
    expect(await creativeForm()).toHaveTextContent('Edit Spring post');
    const name = screen.getByRole('textbox', { name: /^Name/ });
    // Wait for the template to load the revision's values into the form.
    await screen.findByRole('textbox', { name: 'Headline' });
    fireEvent.change(name, { target: { value: 'Spring post (draft)' } });
    await navigate('#notifications');
  }

  it('asks before replacing them with another creative, and Keep changes nothing', async () => {
    const api = await startOnNotifications([
      notice('n-1', 'CHANGE_REQUEST_CREATED', 'Changes requested', {
        creativeId: 'creative-2',
      }),
    ]);
    await editSpringPost();
    const link = linkFor('Changes requested', 'Open creative');
    fireEvent.click(link);
    const panel = within(item('Changes requested')).getByRole('group', {
      name: 'Unsaved changes in Creatives',
    });
    expect(panel).toHaveTextContent(
      'You have unsaved changes to another creative in Creatives. Opening this creative discards them.',
    );
    expect(link).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Keep my changes' }),
    );
    expect(link).toHaveFocus();
    expect(within(item('Changes requested')).queryByRole('group')).toBeNull();
    expect(readCalls(api)).toEqual([]);
    await navigate('#creatives');
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue(
      'Spring post (draft)',
    );
  });

  it('opens the other creative only after explicit approval', async () => {
    const api = await startOnNotifications([
      notice('n-1', 'CHANGE_REQUEST_CREATED', 'Changes requested', {
        creativeId: 'creative-2',
      }),
    ]);
    await editSpringPost();
    fireEvent.click(linkFor('Changes requested', 'Open creative'));
    expect(readCalls(api)).toEqual([]);
    fireEvent.click(
      within(item('Changes requested')).getByRole('button', {
        name: 'Discard changes and open',
      }),
    );
    expect(await creativeForm()).toHaveTextContent('Edit Summer post');
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue(
      'Summer post',
    );
    await waitFor(() =>
      expect(readCalls(api)).toEqual(['POST /notifications/n-1/read']),
    );
  });

  it('asks before a branch switch, naming the branch', async () => {
    await startOnNotifications([
      notice('n-1', 'WORKFLOW_CANCELLED', 'Workflow cancelled', {
        branchId: 'branch-2',
        creativeId: 'creative-3',
      }),
    ]);
    await editSpringPost();
    fireEvent.click(linkFor('Workflow cancelled', 'Open creative'));
    expect(
      within(item('Workflow cancelled')).getByRole('group', {
        name: 'Unsaved changes in Creatives',
      }),
    ).toHaveTextContent(
      'You have unsaved changes in Creatives. Opening this creative switches to the South branch and discards them.',
    );
  });

  it('keeps the edits without asking when the same creative is opened', async () => {
    const api = await startOnNotifications([
      notice('n-1', 'CREATIVE_APPROVED', 'Creative approved', {
        creativeId: 'creative-1',
      }),
    ]);
    await editSpringPost();
    fireEvent.click(linkFor('Creative approved', 'Open creative'));
    expect(within(item('Creative approved')).queryByRole('group')).toBeNull();
    await waitFor(() => expect(window.location.hash).toBe('#creatives'));
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue(
      'Spring post (draft)',
    );
    await waitFor(() =>
      expect(readCalls(api)).toEqual(['POST /notifications/n-1/read']),
    );
  });

  it('does not ask when Workflows opens a creative on the same branch', async () => {
    await startOnNotifications([
      notice('n-1', 'WORKFLOW_TASK_ASSIGNED', 'Workflow task assigned', {
        creativeId: 'creative-2',
      }),
    ]);
    await editSpringPost();
    fireEvent.click(linkFor('Workflow task assigned', 'Open creative'));
    await waitFor(() => expect(window.location.hash).toBe('#workflows'));
    await navigate('#creatives');
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue(
      'Spring post (draft)',
    );
  });

  it('does not ask when the form has no unsaved changes', async () => {
    await startOnNotifications([
      notice('n-1', 'CHANGE_REQUEST_CREATED', 'Changes requested', {
        creativeId: 'creative-2',
      }),
    ]);
    await navigate('#creatives');
    const spring = await creativeRow('Spring post');
    fireEvent.click(within(spring).getByRole('button', { name: 'Open' }));
    await screen.findByRole('textbox', { name: 'Headline' });
    await navigate('#notifications');
    fireEvent.click(linkFor('Changes requested', 'Open creative'));
    expect(await creativeForm()).toHaveTextContent('Edit Summer post');
  });
});

describe('module hash and browser Back', () => {
  it('sets the destination hash as a new history entry, so Back returns to Notifications', async () => {
    await startOnNotifications([
      notice('n-1', 'CREATIVE_APPROVED', 'Creative approved', {
        creativeId: 'creative-2',
      }),
    ]);
    const before = window.history.length;
    fireEvent.click(linkFor('Creative approved', 'Open creative'));
    await creativeForm();
    expect(window.location.hash).toBe('#creatives');
    expect(window.history.length).toBe(before + 1);
    await act(async () => {
      window.history.back();
      await new Promise((resolve) =>
        window.addEventListener('hashchange', resolve, { once: true }),
      );
    });
    expect(window.location.hash).toBe('#notifications');
    expect(
      await screen.findByRole('heading', { name: 'Notifications', level: 2 }),
    ).toBeVisible();
    // Coming back does not reopen anything or show a stale state.
    expect(within(item('Creative approved')).queryByRole('alert')).toBeNull();
  });

  it('a newer link replaces a pending one, and only the newer is marked read', async () => {
    const api = await startOnNotifications([
      notice('n-1', 'CREATIVE_APPROVED', 'Creative approved', {
        branchId: 'branch-2',
        creativeId: 'creative-3',
      }),
      notice('n-2', 'CHANGE_REQUEST_CREATED', 'Changes requested', {
        creativeId: 'creative-2',
      }),
    ]);
    api.hold.add('/branches/branch-2');
    fireEvent.click(linkFor('Creative approved', 'Open creative'));
    await waitFor(() => expect(api.held.length).toBe(1));
    // The first is still waiting for its branch; the user opens another.
    fireEvent.click(linkFor('Changes requested', 'Open creative'));
    api.hold.clear();
    await act(async () => {
      for (const held of api.held.splice(0)) held.release();
    });
    await waitFor(() =>
      expect(readCalls(api)).toEqual(['POST /notifications/n-2/read']),
    );
  });
});
