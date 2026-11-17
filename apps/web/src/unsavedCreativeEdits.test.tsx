// Phase 2B step 5: unsaved Creatives edits are never discarded without
// asking: the Branch selector, Open on another creative, New creative and
// Sign out ask first, and leaving the page gets the browser's own
// confirmation.
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
import { fakeApi } from './appTestApi';

beforeEach(() => {
  localStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({
      accessToken: 'token-1',
      expiresAt: Date.now() + 3600_000,
    }),
  );
  window.history.replaceState(null, '', '/#creatives');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

// ------------------------------------------------------------------ helpers

async function startOnCreatives() {
  const api = fakeApi([]);
  render(<App />);
  await screen.findByText('Hello, Nina Notify.');
  await screen.findByRole('heading', { name: 'Creatives · North' });
  await creativeRow('Spring post');
  return api;
}
const count = (api: ReturnType<typeof fakeApi>, call: string) =>
  api.calls.filter((item) => item === call).length;
async function navigate(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}
const creativesList = () =>
  screen
    .getByRole('heading', { level: 3, name: 'Branch creatives' })
    .closest('section') as HTMLElement;
async function creativeRow(name: string) {
  const list = (
    await screen.findByRole('heading', { level: 3, name: 'Branch creatives' })
  ).closest('section') as HTMLElement;
  return (await within(list).findByText(name)).closest('li') as HTMLElement;
}
const formHeading = () =>
  screen.getByRole('heading', { level: 3, name: /^(Edit |Create creative)/ });
const nameInput = () => screen.getByRole('textbox', { name: /^Name/ });
const headlineInput = () => screen.getByRole('textbox', { name: 'Headline' });
// Opens a creative from the list and waits until its saved values are in
// the form.
async function open(name: string) {
  fireEvent.click(
    within(await creativeRow(name)).getByRole('button', { name: 'Open' }),
  );
  await screen.findByRole('heading', { level: 3, name: 'Edit ' + name });
  await waitFor(() => expect(headlineInput()).toHaveValue(name + ' headline'));
}
const panelIn = (container: HTMLElement) =>
  within(container).queryByRole('group', {
    name: 'Unsaved changes in Creatives',
  });
const branchCard = () =>
  document.getElementById('branch-context') as HTMLElement;
const branchSelect = () =>
  screen.getByRole('combobox', { name: 'Select branch' });
const signOutButton = () => screen.getByRole('button', { name: 'Sign out' });
const signOutArea = () => signOutButton().parentElement as HTMLElement;
// Whether leaving the page would be stopped by the browser's prompt.
function leavingIsBlocked(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

// -------------------------------------------------------------------- tests

describe('Branch selector', () => {
  it('switches at once when the form has no unsaved changes', async () => {
    const api = await startOnCreatives();
    await open('Spring post');
    await navigate('#branch-context');
    fireEvent.change(branchSelect(), { target: { value: 'branch-2' } });
    expect(panelIn(branchCard())).toBeNull();
    await waitFor(() => expect(count(api, 'GET /branches/branch-2')).toBe(1));
    await navigate('#creatives');
    expect(
      await screen.findByRole('heading', { name: 'Creatives · South' }),
    ).toBeInTheDocument();
  });

  it('asks first, and Keep my changes keeps the branch, the form and its values', async () => {
    const api = await startOnCreatives();
    await open('Spring post');
    fireEvent.change(nameInput(), { target: { value: 'Spring post (draft)' } });
    fireEvent.change(headlineInput(), { target: { value: 'New headline' } });
    await navigate('#branch-context');
    fireEvent.change(branchSelect(), { target: { value: 'branch-2' } });

    const panel = panelIn(branchCard());
    expect(panel).toHaveTextContent(
      'You have unsaved changes in Creatives. Switching to the South branch discards them.',
    );
    expect(within(panel!).getByRole('alert')).toBeInTheDocument();
    // Nothing has switched while asking.
    expect(branchSelect()).toHaveValue('branch-1');
    expect(count(api, 'GET /branches/branch-2')).toBe(0);
    expect(count(api, 'GET /creatives?branchId=branch-2')).toBe(0);

    fireEvent.click(
      within(panel!).getByRole('button', { name: 'Keep my changes' }),
    );
    expect(panelIn(branchCard())).toBeNull();
    expect(branchSelect()).toHaveFocus();
    expect(branchSelect()).toHaveValue('branch-1');
    expect(count(api, 'GET /branches/branch-2')).toBe(0);
    await navigate('#creatives');
    expect(formHeading()).toHaveTextContent('Edit Spring post');
    expect(nameInput()).toHaveValue('Spring post (draft)');
    expect(headlineInput()).toHaveValue('New headline');
  });

  it('switches once, and resets the form, only after Discard changes and continue', async () => {
    const api = await startOnCreatives();
    await open('Spring post');
    fireEvent.change(nameInput(), { target: { value: 'Spring post (draft)' } });
    await navigate('#branch-context');
    fireEvent.change(branchSelect(), { target: { value: 'branch-2' } });
    fireEvent.click(
      within(branchCard()).getByRole('button', {
        name: 'Discard changes and continue',
      }),
    );
    expect(panelIn(branchCard())).toBeNull();
    expect(branchSelect()).toHaveValue('branch-2');
    await navigate('#creatives');
    expect(
      await screen.findByRole('heading', { name: 'Creatives · South' }),
    ).toBeInTheDocument();
    await creativeRow('Autumn post');
    expect(formHeading()).toHaveTextContent('Create creative');
    expect(nameInput()).toHaveValue('');
    expect(count(api, 'GET /branches/branch-2')).toBe(1);
    // Confirming did not change the module (the hash is the user's own).
    expect(window.location.hash).toBe('#creatives');
  });

  it('does nothing when the current branch is chosen again', async () => {
    await startOnCreatives();
    await open('Spring post');
    fireEvent.change(nameInput(), { target: { value: 'Spring post (draft)' } });
    await navigate('#branch-context');
    fireEvent.change(branchSelect(), { target: { value: 'branch-1' } });
    expect(panelIn(branchCard())).toBeNull();
    await navigate('#creatives');
    expect(nameInput()).toHaveValue('Spring post (draft)');
  });
});

describe('Open another creative', () => {
  it('asks in that creative’s row, and Keep my changes preserves the form', async () => {
    const api = await startOnCreatives();
    await open('Spring post');
    fireEvent.change(headlineInput(), { target: { value: 'New headline' } });
    const summer = await creativeRow('Summer post');
    const openSummer = within(summer).getByRole('button', { name: 'Open' });
    fireEvent.click(openSummer);

    const panel = panelIn(summer);
    expect(panel).toHaveTextContent(
      'You have unsaved changes to Spring post. Opening Summer post discards them.',
    );
    expect(openSummer).toHaveAttribute('aria-expanded', 'true');
    expect(formHeading()).toHaveTextContent('Edit Spring post');
    expect(count(api, 'GET /creatives/creative-2/revisions')).toBe(0);

    fireEvent.click(
      within(panel!).getByRole('button', { name: 'Keep my changes' }),
    );
    expect(panelIn(summer)).toBeNull();
    expect(openSummer).toHaveFocus();
    expect(openSummer).not.toHaveAttribute('aria-expanded');
    expect(formHeading()).toHaveTextContent('Edit Spring post');
    expect(headlineInput()).toHaveValue('New headline');
    expect(count(api, 'GET /creatives/creative-2/revisions')).toBe(0);
  });

  it('opens the other creative only after Discard changes and continue', async () => {
    const api = await startOnCreatives();
    await open('Spring post');
    fireEvent.change(headlineInput(), { target: { value: 'New headline' } });
    const summer = await creativeRow('Summer post');
    fireEvent.click(within(summer).getByRole('button', { name: 'Open' }));
    fireEvent.click(
      within(summer).getByRole('button', {
        name: 'Discard changes and continue',
      }),
    );
    expect(
      await screen.findByRole('heading', {
        level: 3,
        name: 'Edit Summer post',
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(headlineInput()).toHaveValue('Summer post headline'),
    );
    expect(panelIn(creativesList())).toBeNull();
    await waitFor(() =>
      expect(count(api, 'GET /creatives/creative-2/revisions')).toBe(1),
    );
    expect(window.location.hash).toBe('#creatives');
  });

  it('does not ask, and keeps the edits, when the creative in the form is opened again', async () => {
    const api = await startOnCreatives();
    await open('Spring post');
    fireEvent.change(nameInput(), { target: { value: 'Spring post (draft)' } });
    const revisionsBefore = count(api, 'GET /creatives/creative-1/revisions');
    fireEvent.click(
      within(await creativeRow('Spring post')).getByRole('button', {
        name: 'Open',
      }),
    );
    expect(panelIn(creativesList())).toBeNull();
    expect(nameInput()).toHaveValue('Spring post (draft)');
    expect(count(api, 'GET /creatives/creative-1/revisions')).toBe(
      revisionsBefore,
    );
  });

  it('does not ask without unsaved changes, including edits changed back', async () => {
    await startOnCreatives();
    await open('Spring post');
    fireEvent.change(nameInput(), { target: { value: 'Spring post (draft)' } });
    fireEvent.change(nameInput(), { target: { value: 'Spring post' } });
    fireEvent.click(
      within(await creativeRow('Summer post')).getByRole('button', {
        name: 'Open',
      }),
    );
    expect(panelIn(creativesList())).toBeNull();
    expect(
      await screen.findByRole('heading', {
        level: 3,
        name: 'Edit Summer post',
      }),
    ).toBeInTheDocument();
  });

  it('stops asking once the edits are undone while the question is open', async () => {
    await startOnCreatives();
    await open('Spring post');
    fireEvent.change(nameInput(), { target: { value: 'Spring post (draft)' } });
    const summer = await creativeRow('Summer post');
    fireEvent.click(within(summer).getByRole('button', { name: 'Open' }));
    expect(panelIn(summer)).not.toBeNull();
    fireEvent.change(nameInput(), { target: { value: 'Spring post' } });
    expect(panelIn(summer)).toBeNull();
  });
});

describe('New creative', () => {
  it('asks first; Keep preserves the edits and Discard starts an empty creative', async () => {
    await startOnCreatives();
    await open('Spring post');
    fireEvent.change(nameInput(), { target: { value: 'Spring post (draft)' } });
    const newButton = within(creativesList()).getByRole('button', {
      name: 'New creative',
    });
    fireEvent.click(newButton);
    const holder = newButton.parentElement as HTMLElement;
    expect(panelIn(holder)).toHaveTextContent(
      'You have unsaved changes to Spring post. Starting a new creative discards them.',
    );
    fireEvent.click(
      within(holder).getByRole('button', { name: 'Keep my changes' }),
    );
    expect(newButton).toHaveFocus();
    expect(formHeading()).toHaveTextContent('Edit Spring post');
    expect(nameInput()).toHaveValue('Spring post (draft)');

    fireEvent.click(newButton);
    fireEvent.click(
      within(holder).getByRole('button', {
        name: 'Discard changes and continue',
      }),
    );
    expect(formHeading()).toHaveTextContent('Create creative');
    expect(nameInput()).toHaveValue('');
    expect(panelIn(holder)).toBeNull();
  });

  it('keeps a new creative being written when New creative is pressed again', async () => {
    await startOnCreatives();
    fireEvent.change(nameInput(), { target: { value: 'Winter post' } });
    fireEvent.click(
      within(creativesList()).getByRole('button', { name: 'New creative' }),
    );
    expect(panelIn(creativesList())).toBeNull();
    expect(nameInput()).toHaveValue('Winter post');
  });

  it('asks before an existing creative replaces a new one being written', async () => {
    await startOnCreatives();
    fireEvent.change(nameInput(), { target: { value: 'Winter post' } });
    const spring = await creativeRow('Spring post');
    fireEvent.click(within(spring).getByRole('button', { name: 'Open' }));
    expect(panelIn(spring)).toHaveTextContent(
      'You have unsaved changes to the new creative. Opening Spring post discards them.',
    );
    expect(nameInput()).toHaveValue('Winter post');
  });

  it('does not ask when the new-creative form is empty', async () => {
    await startOnCreatives();
    fireEvent.click(
      within(await creativeRow('Spring post')).getByRole('button', {
        name: 'Open',
      }),
    );
    expect(panelIn(creativesList())).toBeNull();
    expect(
      await screen.findByRole('heading', {
        level: 3,
        name: 'Edit Spring post',
      }),
    ).toBeInTheDocument();
  });
});

describe('Leaving the page', () => {
  it('uses the browser’s confirmation only while there are unsaved changes', async () => {
    await startOnCreatives();
    expect(leavingIsBlocked()).toBe(false);
    await open('Spring post');
    expect(leavingIsBlocked()).toBe(false);
    fireEvent.change(headlineInput(), { target: { value: 'New headline' } });
    expect(leavingIsBlocked()).toBe(true);
    // Edits changed back to the saved values need no confirmation.
    fireEvent.change(headlineInput(), {
      target: { value: 'Spring post headline' },
    });
    expect(leavingIsBlocked()).toBe(false);
  });

  it('stops asking after the edits are discarded in the app', async () => {
    await startOnCreatives();
    await open('Spring post');
    fireEvent.change(nameInput(), { target: { value: 'Spring post (draft)' } });
    expect(leavingIsBlocked()).toBe(true);
    fireEvent.click(
      within(creativesList()).getByRole('button', { name: 'New creative' }),
    );
    fireEvent.click(
      within(creativesList()).getByRole('button', {
        name: 'Discard changes and continue',
      }),
    );
    expect(leavingIsBlocked()).toBe(false);
  });

  it('removes the guard once sign-out is confirmed', async () => {
    await startOnCreatives();
    await open('Spring post');
    fireEvent.change(nameInput(), { target: { value: 'Spring post (draft)' } });
    expect(leavingIsBlocked()).toBe(true);
    fireEvent.click(signOutButton());
    fireEvent.click(
      within(signOutArea()).getByRole('button', {
        name: 'Discard changes and continue',
      }),
    );
    await screen.findByLabelText('Password');
    expect(leavingIsBlocked()).toBe(false);
  });
});

describe('Sign out', () => {
  it('signs out at once when the form has no unsaved changes', async () => {
    const api = await startOnCreatives();
    await open('Spring post');
    fireEvent.click(signOutButton());
    await screen.findByLabelText('Password');
    expect(count(api, 'POST /auth/logout')).toBe(1);
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it('asks first, and Keep my changes cancels signing out and keeps the form', async () => {
    const api = await startOnCreatives();
    await open('Spring post');
    fireEvent.change(nameInput(), { target: { value: 'Spring post (draft)' } });
    fireEvent.change(headlineInput(), { target: { value: 'New headline' } });
    signOutButton().focus();
    fireEvent.click(signOutButton());

    const panel = panelIn(signOutArea()) as HTMLElement;
    expect(panel).not.toBeNull();
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'You have unsaved changes in Creatives. Signing out discards them.',
    );
    expect(signOutButton()).toHaveAttribute('aria-expanded', 'true');
    // Nothing is sent and the user stays signed in while it asks.
    expect(count(api, 'POST /auth/logout')).toBe(0);
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).not.toBeNull();
    // Focus stays on Sign out; the question is announced.
    expect(signOutButton()).toHaveFocus();

    fireEvent.click(
      within(panel).getByRole('button', { name: 'Keep my changes' }),
    );
    expect(panelIn(signOutArea())).toBeNull();
    expect(signOutButton()).not.toHaveAttribute('aria-expanded');
    expect(signOutButton()).toHaveFocus();
    expect(screen.getByText('Hello, Nina Notify.')).toBeInTheDocument();
    expect(formHeading()).toHaveTextContent('Edit Spring post');
    expect(nameInput()).toHaveValue('Spring post (draft)');
    expect(headlineInput()).toHaveValue('New headline');
    expect(leavingIsBlocked()).toBe(true);
    expect(count(api, 'POST /auth/logout')).toBe(0);
  });

  it('signs out once, through the usual flow, after Discard changes and continue', async () => {
    const api = await startOnCreatives();
    await open('Spring post');
    fireEvent.change(nameInput(), { target: { value: 'Spring post (draft)' } });
    fireEvent.click(signOutButton());
    const discard = within(signOutArea()).getByRole('button', {
      name: 'Discard changes and continue',
    });
    fireEvent.click(discard);
    fireEvent.click(discard);
    await screen.findByLabelText('Password');
    expect(count(api, 'POST /auth/logout')).toBe(1);
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    // A plain sign-out, not an expired session.
    expect(screen.queryByText(/session expired/i)).toBeNull();
  });

  it('sends one sign-out for repeated clicks', async () => {
    const api = await startOnCreatives();
    const button = signOutButton();
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByLabelText('Password');
    expect(count(api, 'POST /auth/logout')).toBe(1);
  });

  it('still signs out locally when the sign-out request fails', async () => {
    const api = await startOnCreatives();
    await open('Spring post');
    fireEvent.change(nameInput(), { target: { value: 'Spring post (draft)' } });
    const answer = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      if (input.endsWith('/auth/logout')) {
        api.calls.push('POST /auth/logout');
        throw new TypeError('Failed to fetch');
      }
      return answer(input, init);
    });
    fireEvent.click(signOutButton());
    fireEvent.click(
      within(signOutArea()).getByRole('button', {
        name: 'Discard changes and continue',
      }),
    );
    await screen.findByLabelText('Password');
    expect(count(api, 'POST /auth/logout')).toBe(1);
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(leavingIsBlocked()).toBe(false);
  });

  it('stops asking once the edits are undone while the question is open', async () => {
    const api = await startOnCreatives();
    await open('Spring post');
    fireEvent.change(nameInput(), { target: { value: 'Spring post (draft)' } });
    fireEvent.click(signOutButton());
    expect(panelIn(signOutArea())).not.toBeNull();
    fireEvent.change(nameInput(), { target: { value: 'Spring post' } });
    expect(panelIn(signOutArea())).toBeNull();
    // With nothing to protect, Sign out works at once again.
    fireEvent.click(signOutButton());
    await screen.findByLabelText('Password');
    expect(count(api, 'POST /auth/logout')).toBe(1);
  });

  it('asks for a new creative being written too', async () => {
    const api = await startOnCreatives();
    fireEvent.click(
      within(creativesList()).getByRole('button', { name: 'New creative' }),
    );
    fireEvent.change(nameInput(), { target: { value: 'Autumn post' } });
    fireEvent.click(signOutButton());
    expect(panelIn(signOutArea())).not.toBeNull();
    expect(count(api, 'POST /auth/logout')).toBe(0);
  });

  it('asks from any module, since the Creatives form stays open', async () => {
    const api = await startOnCreatives();
    await open('Spring post');
    fireEvent.change(nameInput(), { target: { value: 'Spring post (draft)' } });
    await navigate('#notifications');
    fireEvent.click(signOutButton());
    expect(panelIn(signOutArea())).not.toBeNull();
    expect(count(api, 'POST /auth/logout')).toBe(0);
  });
});

describe('notification links still ask with the same detection', () => {
  it('a branch switch from the Branch selector and a notification link agree on the form state', async () => {
    await startOnCreatives();
    await open('Spring post');
    fireEvent.change(nameInput(), { target: { value: 'Spring post (draft)' } });
    // A branch question left open is cleared when the user keeps editing
    // and nothing switches behind it.
    await navigate('#branch-context');
    fireEvent.change(branchSelect(), { target: { value: 'branch-2' } });
    expect(panelIn(branchCard())).not.toBeNull();
    fireEvent.change(branchSelect(), { target: { value: 'branch-1' } });
    expect(panelIn(branchCard())).toBeNull();
    expect(branchSelect()).toHaveValue('branch-1');
  });
});
