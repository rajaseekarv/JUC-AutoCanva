import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import WorkspaceShell, { type WorkspaceModule } from './WorkspaceShell';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const lifecycle = { mounts: 0, unmounts: 0 };

// Counts mounts and keeps local state, standing in for a module such as the
// Canva panel whose in-memory retry key must survive navigation.
function Probe({ name }: { name: string }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    lifecycle.mounts += 1;
    return () => {
      lifecycle.unmounts += 1;
    };
  }, []);
  return (
    <section id={name} aria-label={`${name} module`}>
      <h2 id={`${name}-title`}>{name} heading</h2>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        {name} count {count}
      </button>
    </section>
  );
}

function modules(): WorkspaceModule[] {
  return [
    {
      id: 'alpha',
      label: 'Alpha',
      icon: 'branch',
      available: true,
      content: <Probe name="alpha" />,
    },
    {
      id: 'beta',
      label: 'Beta',
      icon: 'templates',
      available: true,
      content: <Probe name="beta" />,
    },
    {
      id: 'gamma',
      label: 'Gamma',
      icon: 'audit',
      available: false,
      content: <Probe name="gamma" />,
    },
  ];
}

function renderShell(shellModules: WorkspaceModule[] = modules()) {
  lifecycle.mounts = 0;
  lifecycle.unmounts = 0;
  return render(
    <WorkspaceShell
      modules={shellModules}
      defaultModuleId="alpha"
      statusChip={<span role="status">API online</span>}
      heading={<h1>Hello, Tester.</h1>}
      contextLabel="North"
      userName="Tester"
      onSignOut={vi.fn()}
      footer={<footer>Footer</footer>}
    />,
  );
}

async function navigate(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

const nav = () => screen.getByRole('navigation', { name: 'Workspace modules' });

describe('WorkspaceShell', () => {
  it('shows one module at a time while mounting every module exactly once', () => {
    renderShell();
    expect(screen.getByRole('region', { name: 'alpha module' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'beta module' })).toBeNull();
    // Hidden modules are mounted, so their data loads once as before.
    expect(document.getElementById('beta')).not.toBeNull();
    expect(document.getElementById('gamma')).not.toBeNull();
    expect(lifecycle).toEqual({ mounts: 3, unmounts: 0 });
  });

  it('lists only available modules and marks the active one', () => {
    renderShell();
    expect(screen.getByRole('link', { name: 'Alpha' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Beta' })).toHaveAttribute(
      'href',
      '#beta',
    );
    expect(screen.queryByRole('link', { name: 'Gamma' })).toBeNull();
    expect(nav()).toBeVisible();
  });

  it('switches modules from the hash without remounting or losing state', async () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'alpha count 0' }));
    await navigate('#beta');
    expect(screen.getByRole('region', { name: 'beta module' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'alpha module' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Beta' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await navigate('#alpha');
    expect(
      screen.getByRole('button', { name: 'alpha count 1' }),
    ).toBeInTheDocument();
    expect(lifecycle).toEqual({ mounts: 3, unmounts: 0 });
  });

  it('opens the module that owns a nested deep-link target', async () => {
    renderShell();
    await navigate('#beta-title');
    expect(screen.getByRole('region', { name: 'beta module' })).toBeVisible();
  });

  it('opens the module named in the hash on first load', () => {
    window.history.replaceState(null, '', '/#beta');
    renderShell();
    expect(screen.getByRole('region', { name: 'beta module' })).toBeVisible();
  });

  it.each([
    ['an unknown hash', '#missing'],
    ['an unavailable module', '#gamma'],
  ])('falls back to the default module for %s', async (_case, hash) => {
    renderShell();
    await navigate('#beta');
    await navigate(hash);
    expect(screen.getByRole('region', { name: 'alpha module' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'gamma module' })).toBeNull();
  });

  it('opens and closes the navigation drawer, closing on Escape and on navigation', async () => {
    renderShell();
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(menu);
    expect(
      screen.getByRole('button', { name: 'Close navigation' }),
    ).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Alpha' })).toHaveFocus(),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(menu).toHaveFocus();
    fireEvent.click(menu);
    fireEvent.click(screen.getByRole('link', { name: 'Beta' }));
    expect(menu).toHaveAttribute('aria-expanded', 'false');
  });

  it('collapses the sidebar while keeping link names', () => {
    renderShell();
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(
      screen.getByRole('button', { name: 'Expand sidebar' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('link', { name: 'Beta' })).toHaveAttribute(
      'title',
      'Beta',
    );
  });

  it('keeps the account controls and API status in the top bar', () => {
    renderShell();
    expect(screen.getByRole('status')).toHaveTextContent('API online');
    expect(screen.getByRole('link', { name: 'Notifications' })).toHaveAttribute(
      'href',
      '#notifications-title',
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
    expect(screen.getByText('North')).toBeInTheDocument();
  });
});

// Phase 2B step 3: an optional count beside a module's nav label.
describe('WorkspaceShell module badges', () => {
  // Beta carries the badge; Alpha (and the unavailable Gamma) have none.
  function withBadge(badge: WorkspaceModule['badge']): WorkspaceModule[] {
    return modules().map((module) =>
      module.id === 'beta' ? { ...module, badge } : module,
    );
  }
  const unread = (count: number) => ({
    count,
    description: `${count} unread`,
  });
  const shell = () => document.querySelector('.app-shell');
  const betaLink = () => within(nav()).getByRole('link', { name: /^Beta/ });
  const badgeOf = (link: HTMLElement) => link.querySelector('.nav-badge');
  const allBadges = () => nav().querySelectorAll('.nav-badge');

  it('shows no badge for a zero count', () => {
    renderShell(withBadge(unread(0)));
    const link = within(nav()).getByRole('link', { name: 'Beta' });
    expect(badgeOf(link)).toBeNull();
    expect(link).not.toHaveAttribute('aria-label');
  });

  it('shows no badge when the owner gives none, as for an unavailable count', () => {
    renderShell(withBadge(undefined));
    expect(
      within(nav()).getByRole('link', { name: 'Beta' }),
    ).not.toHaveAttribute('aria-label');
    expect(allBadges()).toHaveLength(0);
  });

  it('ignores counts that are not positive numbers', () => {
    renderShell(withBadge({ count: Number.NaN, description: 'NaN unread' }));
    expect(allBadges()).toHaveLength(0);
    cleanup();
    renderShell(withBadge({ count: -3, description: '-3 unread' }));
    expect(allBadges()).toHaveLength(0);
  });

  it('shows one unread notification in the badge and the link name', () => {
    renderShell(withBadge(unread(1)));
    const link = within(nav()).getByRole('link', { name: 'Beta, 1 unread' });
    expect(badgeOf(link)).toHaveTextContent(/^1$/);
    expect(link).toHaveAttribute('href', '#beta');
  });

  it('caps the visible count at 99+ while the name keeps the exact count', () => {
    renderShell(withBadge(unread(100)));
    const link = within(nav()).getByRole('link', {
      name: 'Beta, 100 unread',
    });
    expect(badgeOf(link)).toHaveTextContent(/^99\+$/);
    cleanup();
    renderShell(withBadge(unread(99)));
    expect(
      badgeOf(within(nav()).getByRole('link', { name: 'Beta, 99 unread' })),
    ).toHaveTextContent(/^99$/);
  });

  it('announces the count once: the badge is hidden from assistive technology', () => {
    renderShell(withBadge(unread(5)));
    const link = within(nav()).getByRole('link', { name: 'Beta, 5 unread' });
    expect(badgeOf(link)).toHaveAttribute('aria-hidden', 'true');
    // No live region: a changing count is not announced on its own.
    expect(nav().querySelector('[aria-live], [role="status"]')).toBeNull();
    // Only the badged link has an explicit name with the count in it.
    expect(
      within(nav())
        .getAllByRole('link')
        .map((node) => node.getAttribute('aria-label')),
    ).toEqual([null, 'Beta, 5 unread']);
  });

  it('shows the badge in the expanded sidebar without a tooltip', () => {
    renderShell(withBadge(unread(5)));
    expect(
      screen.getByRole('button', { name: 'Collapse sidebar' }),
    ).toHaveAttribute('aria-expanded', 'true');
    const link = betaLink();
    expect(badgeOf(link)).toHaveTextContent(/^5$/);
    expect(link).not.toHaveAttribute('title');
    expect(link.querySelector('.nav-label')).toHaveTextContent('Beta');
  });

  it('keeps the badge, drawn as a dot, with the count in the name and tooltip when collapsed', () => {
    renderShell(withBadge(unread(5)));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(shell()).toHaveClass('sidebar-collapsed');
    const link = within(nav()).getByRole('link', { name: 'Beta, 5 unread' });
    expect(link).toHaveAttribute('title', 'Beta, 5 unread');
    // The same element; the collapsed CSS draws it as a dot.
    expect(badgeOf(link)).toHaveAttribute('aria-hidden', 'true');
    // A module without a badge keeps its plain tooltip.
    expect(within(nav()).getByRole('link', { name: 'Alpha' })).toHaveAttribute(
      'title',
      'Alpha',
    );
  });

  it('shows the same badge and name in the mobile drawer', () => {
    renderShell(withBadge(unread(5)));
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(shell()).toHaveClass('drawer-open');
    const link = within(nav()).getByRole('link', { name: 'Beta, 5 unread' });
    expect(badgeOf(link)).toHaveTextContent(/^5$/);
    expect(link).not.toHaveAttribute('title');
    // Following the badged link closes the drawer like any other.
    fireEvent.click(link);
    expect(shell()).not.toHaveClass('drawer-open');
  });

  it('updates and removes the badge when the count changes, without remounting', () => {
    const props = {
      defaultModuleId: 'alpha',
      statusChip: null,
      heading: <h1>Hello, Tester.</h1>,
      userName: 'Tester',
      onSignOut: vi.fn(),
      footer: null,
    };
    const view = renderShell(withBadge(unread(2)));
    expect(betaLink()).toHaveAccessibleName('Beta, 2 unread');
    view.rerender(<WorkspaceShell modules={withBadge(unread(3))} {...props} />);
    expect(betaLink()).toHaveAccessibleName('Beta, 3 unread');
    view.rerender(<WorkspaceShell modules={withBadge(unread(0))} {...props} />);
    expect(betaLink()).toHaveAccessibleName('Beta');
    expect(allBadges()).toHaveLength(0);
    expect(lifecycle).toEqual({ mounts: 3, unmounts: 0 });
  });

  it('leaves modules without badges, and routing, unchanged', async () => {
    renderShell(withBadge(unread(5)));
    const alpha = within(nav()).getByRole('link', { name: 'Alpha' });
    expect(alpha).toHaveAttribute('href', '#alpha');
    expect(alpha).toHaveAttribute('aria-current', 'page');
    expect(badgeOf(alpha)).toBeNull();
    expect(alpha).not.toHaveAttribute('aria-label');
    expect(within(nav()).queryByRole('link', { name: /Gamma/ })).toBeNull();
    await navigate('#beta');
    expect(betaLink()).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('region', { name: 'beta module' })).toBeVisible();
  });
});
