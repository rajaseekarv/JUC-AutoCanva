import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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

function renderShell() {
  lifecycle.mounts = 0;
  lifecycle.unmounts = 0;
  return render(
    <WorkspaceShell
      modules={modules()}
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
