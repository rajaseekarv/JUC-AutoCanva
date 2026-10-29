import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WorkspaceShell, { type WorkspaceModule } from './WorkspaceShell';

// Vitest blanks CSS imports (even ?raw), so the shipped stylesheet is read
// from disk for the focus-style contract checks. The path is built from this
// file's location; `new URL('./x', import.meta.url)` would be rewritten by Vite
// into a served asset URL.
const stylesheet = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'style.css'),
  'utf8',
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const modules: WorkspaceModule[] = [
  {
    id: 'alpha',
    label: 'Alpha',
    icon: 'branch',
    available: true,
    content: (
      <section aria-label="alpha module">
        <button type="button">Alpha action</button>
      </section>
    ),
  },
  {
    id: 'beta',
    label: 'Beta',
    icon: 'templates',
    available: true,
    content: (
      <section aria-label="beta module">
        <button type="button">Beta action</button>
      </section>
    ),
  },
];

function renderShell() {
  return render(
    <WorkspaceShell
      modules={modules}
      defaultModuleId="alpha"
      statusChip={<span role="status">API online</span>}
      heading={<h1>Hello, Tester.</h1>}
      userName="Tester"
      onSignOut={vi.fn()}
      footer={<footer>Footer</footer>}
    />,
  );
}

const focusableSelector =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

// Elements a keyboard user can reach: focusable and not inside an inert
// subtree (jsdom does not apply inert itself, so this mirrors the browser).
function reachable(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(focusableSelector)].filter(
    (element) => !element.closest('[inert]'),
  );
}

// A controllable stand-in for the (max-width) breakpoint query.
function stubViewport(desktop: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: desktop,
    media: '(min-width: 961px)',
    addEventListener: (_type: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) =>
      listeners.delete(listener),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  );
  return {
    resize(nextDesktop: boolean) {
      query.matches = nextDesktop;
      act(() => listeners.forEach((listener) => listener()));
    },
    listenerCount: () => listeners.size,
  };
}

const menuButton = () =>
  screen.getByRole('button', { name: /(Open|Close) navigation/ });
const mainContent = () => document.getElementById('main-content')!;

describe('focus visibility styling', () => {
  function luminance(hex: string): number {
    const channels = [1, 3, 5].map((index) => {
      const value = parseInt(hex.slice(index, index + 2), 16) / 255;
      return value <= 0.03928
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }
  function contrast(first: string, second: string): number {
    const [light, dark] = [luminance(first), luminance(second)].sort(
      (a, b) => b - a,
    );
    return (light + 0.05) / (dark + 0.05);
  }
  function token(name: string): string {
    const match = stylesheet.match(
      new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`),
    );
    if (!match) throw new Error(`token ${name} not found`);
    return match[1];
  }

  it('uses a solid brand outline for the shared focus-visible rule', () => {
    const rule = stylesheet.match(/(?:^|\n):focus-visible \{([^}]*)\}/);
    expect(rule?.[1]).toContain('outline: 2px solid var(--color-brand);');
    expect(rule?.[1]).toContain('outline-offset: 2px;');
  });

  it('keeps the focus ring at 3:1 or more on cards, canvas, and the active nav tint', () => {
    const ring = token('color-brand');
    for (const background of [
      'color-surface',
      'color-canvas',
      'color-brand-soft',
    ])
      expect(contrast(ring, token(background))).toBeGreaterThanOrEqual(3);
  });

  it('no longer draws any outline with the translucent ring color', () => {
    expect(stylesheet).not.toMatch(/outline:[^;]*--color-brand-ring/);
    // Inputs keep their own border and glow on focus.
    expect(stylesheet).toMatch(
      /:is\(input, select, textarea\):focus \{[^}]*border-color: var\(--color-brand\);[^}]*box-shadow: 0 0 0 3px var\(--color-brand-ring\);/,
    );
  });
});

describe('skip to content link', () => {
  it('is the first keyboard-reachable element', () => {
    const { container } = renderShell();
    expect(reachable(container)[0]).toBe(
      screen.getByRole('link', { name: 'Skip to content' }),
    );
  });

  it('moves focus to the focusable main content without changing the module or hash', () => {
    renderShell();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveAttribute('href', '#main-content');
    expect(mainContent()).toHaveAttribute('tabindex', '-1');
    skip.focus();
    fireEvent.click(skip);
    expect(mainContent()).toHaveFocus();
    expect(window.location.hash).toBe('');
    expect(screen.getByRole('region', { name: 'alpha module' })).toBeVisible();
  });
});

describe('mobile drawer focus containment', () => {
  it('makes everything outside the drawer inert except the menu button', () => {
    stubViewport(false);
    const { container } = renderShell();
    fireEvent.click(menuButton());
    const sidebar = document.getElementById('workspace-sidebar')!;
    expect(mainContent()).toHaveAttribute('inert');
    expect(
      screen.getByRole('link', { name: 'Skip to content' }),
    ).toHaveAttribute('inert');
    for (const element of reachable(container))
      expect(element === menuButton() || sidebar.contains(element)).toBe(true);
    // The drawer's own links and the close button remain reachable.
    expect(reachable(container)).toContain(menuButton());
    expect(reachable(container)).toContain(
      screen.getByRole('link', { name: 'Beta' }),
    );
    expect(reachable(container)).not.toContain(
      screen.getByRole('button', { name: 'Alpha action' }),
    );
  });

  it('restores focus to the menu button and removes inert on Escape', () => {
    stubViewport(false);
    const { container } = renderShell();
    fireEvent.click(menuButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
    expect(menuButton()).toHaveFocus();
    expect(container.querySelector('[inert]')).toBeNull();
  });

  it('restores focus to the menu button when the backdrop is tapped', () => {
    stubViewport(false);
    const { container } = renderShell();
    fireEvent.click(menuButton());
    fireEvent.click(container.querySelector('.sidebar-backdrop')!);
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
    expect(menuButton()).toHaveFocus();
    expect(container.querySelector('[inert]')).toBeNull();
  });

  it('closes the drawer and clears inert when the viewport widens past 960px', () => {
    const viewport = stubViewport(false);
    const { container } = renderShell();
    fireEvent.click(menuButton());
    expect(mainContent()).toHaveAttribute('inert');
    expect(viewport.listenerCount()).toBe(1);
    viewport.resize(true);
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('[inert]')).toBeNull();
    // The resize listener is removed once the drawer is closed.
    expect(viewport.listenerCount()).toBe(0);
  });

  it('keeps module state and the hash while the drawer opens and closes', () => {
    stubViewport(false);
    renderShell();
    fireEvent.click(menuButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(window.location.hash).toBe('');
    expect(screen.getByRole('region', { name: 'alpha module' })).toBeVisible();
  });
});
