import { useEffect, useRef, useState, type ReactNode } from 'react';
import NavIcon, { type NavIconName } from './NavIcon';

export type WorkspaceModule = {
  id: string;
  label: string;
  icon: NavIconName;
  // Unavailable modules stay mounted exactly as before but get no nav item
  // and cannot be opened.
  available: boolean;
  content: ReactNode;
  // An optional count shown beside the nav label, such as unread items. The
  // module owner decides when there is a count to show; the shell hides the
  // badge when it is absent or the count is not positive.
  badge?: ModuleBadge;
};

export type ModuleBadge = {
  count: number;
  // Spoken after the module label, e.g. "5 unread" gives the link the name
  // "Notifications, 5 unread". It should state the exact count.
  description: string;
};

// Counts above this are shown as "99+"; the accessible name keeps the exact
// count.
const BADGE_MAX = 99;

function badgeText(count: number): string {
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}

function visibleBadge(module: WorkspaceModule): ModuleBadge | null {
  const badge = module.badge;
  return badge && Number.isFinite(badge.count) && badge.count > 0
    ? badge
    : null;
}

// The URL hash stays the source of truth, so existing links such as
// "#templates" or "#notifications-title" keep working. A hash naming an
// element inside a module opens that module; anything unknown, including a
// module hidden by permissions, falls back to the default.
function resolveModule(
  target: string,
  moduleIds: readonly string[],
  fallback: string,
): string {
  if (!target) return fallback;
  if (moduleIds.includes(target)) return target;
  const owner = document
    .getElementById(target)
    ?.closest<HTMLElement>('[data-module]')?.dataset.module;
  return owner && moduleIds.includes(owner) ? owner : fallback;
}

function currentHashTarget(): string {
  try {
    return decodeURIComponent(window.location.hash.replace(/^#/, ''));
  } catch {
    return '';
  }
}

export default function WorkspaceShell({
  modules,
  defaultModuleId,
  statusChip,
  heading,
  contextLabel,
  userName,
  onSignOut,
  signOutConfirmation = null,
  footer,
  onActiveModuleChange,
}: {
  modules: WorkspaceModule[];
  defaultModuleId: string;
  statusChip: ReactNode;
  heading: ReactNode;
  contextLabel?: string;
  userName: string;
  onSignOut: () => void;
  // An inline confirmation shown under Sign out while signing out waits for
  // the user (for example, to discard unsaved edits); null when none.
  signOutConfirmation?: ReactNode;
  footer: ReactNode;
  // Told which module is shown, on mount and after every change.
  onActiveModuleChange?: (moduleId: string) => void;
}) {
  const navigable = modules.filter((module) => module.available);
  const moduleKey = navigable.map((module) => module.id).join('|');
  const [activeId, setActiveId] = useState(() =>
    resolveModule(
      currentHashTarget(),
      navigable.map((module) => module.id),
      defaultModuleId,
    ),
  );
  const activeModuleChange = useRef(onActiveModuleChange);
  activeModuleChange.current = onActiveModuleChange;
  useEffect(() => {
    activeModuleChange.current?.(activeId);
  }, [activeId]);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const skipLinkRef = useRef<HTMLAnchorElement>(null);
  const brandRef = useRef<HTMLAnchorElement>(null);
  const topbarActionsRef = useRef<HTMLDivElement>(null);

  function closeDrawer() {
    setDrawerOpen(false);
    menuButtonRef.current?.focus();
  }

  useEffect(() => {
    const moduleIds = moduleKey.split('|');
    function sync(fromNavigation: boolean) {
      const target = currentHashTarget();
      const next = resolveModule(target, moduleIds, defaultModuleId);
      setActiveId(next);
      // Once the module is visible, bring a nested target into view, or
      // start a newly opened module at the top.
      requestAnimationFrame(() => {
        const nested =
          target && target !== next ? document.getElementById(target) : null;
        if (nested) nested.scrollIntoView?.({ block: 'start' });
        else if (mainRef.current) mainRef.current.scrollTop = 0;
        if (fromNavigation)
          document
            .getElementById(`module-${next}`)
            ?.focus({ preventScroll: true });
      });
    }
    sync(false);
    const onHashChange = () => sync(true);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [moduleKey, defaultModuleId]);

  useEffect(() => {
    if (!drawerOpen) return;
    sidebarRef.current
      ?.querySelector<HTMLElement>('a[aria-current="page"], a')
      ?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setDrawerOpen(false);
      menuButtonRef.current?.focus();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  // While the drawer is open, everything outside it except the menu button is
  // inert, so Tab and assistive technology stay within the drawer. React 18
  // has no `inert` prop, so the attribute is set on the elements directly.
  useEffect(() => {
    for (const element of [
      skipLinkRef.current,
      brandRef.current,
      topbarActionsRef.current,
      mainRef.current,
    ])
      element?.toggleAttribute('inert', drawerOpen);
  }, [drawerOpen]);

  // The drawer exists only below the 960px breakpoint; widening the window
  // closes it so the main content is never left inert on desktop.
  useEffect(() => {
    if (!drawerOpen || typeof window.matchMedia !== 'function') return;
    const desktop = window.matchMedia('(min-width: 961px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setDrawerOpen(false);
    };
    closeOnDesktop();
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, [drawerOpen]);

  const shellClass = [
    'app-shell',
    collapsed && 'sidebar-collapsed',
    drawerOpen && 'drawer-open',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={shellClass}>
      {/* The first focusable element. Default navigation is cancelled so the
          hash, and therefore the open module, does not change. */}
      <a
        ref={skipLinkRef}
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="app-topbar">
        <button
          ref={menuButtonRef}
          type="button"
          className="icon-button menu-button"
          aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={drawerOpen}
          aria-controls="workspace-sidebar"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <NavIcon name={drawerOpen ? 'close' : 'menu'} />
        </button>
        <a
          ref={brandRef}
          className="brand"
          href="/"
          aria-label="JUC-AutoCanva home"
        >
          <span className="brand-mark" aria-hidden="true">
            J
          </span>
          <span>JUC-AutoCanva</span>
        </a>
        <div ref={topbarActionsRef} className="app-topbar-actions">
          {statusChip}
          <a className="secondary-button" href="#notifications-title">
            <NavIcon name="notifications" />
            <span className="topbar-label">Notifications</span>
          </a>
          <span className="account-name">{userName}</span>
          {/* The confirmation sits under the button that opened it, so its
              Keep button can return focus there (see confirmFocus). */}
          <div className="sign-out-action">
            <button
              className="secondary-button"
              aria-expanded={signOutConfirmation ? true : undefined}
              onClick={onSignOut}
            >
              <NavIcon name="signOut" />
              <span className="topbar-label">Sign out</span>
            </button>
            {signOutConfirmation}
          </div>
        </div>
      </header>
      <div
        className="sidebar-backdrop"
        aria-hidden="true"
        onClick={closeDrawer}
      />
      <aside id="workspace-sidebar" ref={sidebarRef} className="app-sidebar">
        <nav aria-label="Workspace modules">
          <ul>
            {navigable.map((module) => {
              const badge = visibleBadge(module);
              // With a badge the count joins the link's name, and the badge
              // itself is hidden from assistive technology so the count is
              // announced once. Without one, the link is unchanged.
              const name = badge
                ? `${module.label}, ${badge.description}`
                : module.label;
              return (
                <li key={module.id}>
                  <a
                    href={`#${module.id}`}
                    aria-current={module.id === activeId ? 'page' : undefined}
                    aria-label={badge ? name : undefined}
                    title={collapsed ? name : undefined}
                    onClick={() => setDrawerOpen(false)}
                  >
                    <NavIcon name={module.icon} />
                    <span className="nav-label">{module.label}</span>
                    {badge && (
                      // Collapsed (desktop only), CSS shows it as a dot.
                      <span className="nav-badge" aria-hidden="true">
                        {badgeText(badge.count)}
                      </span>
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        {contextLabel && (
          <p className="sidebar-context">
            <span className="nav-label">Current branch</span>
            <strong className="nav-label">{contextLabel}</strong>
          </p>
        )}
        <button
          type="button"
          className="icon-button collapse-button"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          aria-controls="workspace-sidebar"
          onClick={() => setCollapsed((value) => !value)}
        >
          <NavIcon name="collapse" />
        </button>
      </aside>
      <main ref={mainRef} id="main-content" className="app-main" tabIndex={-1}>
        <div className="app-main-inner">
          {heading}
          {/* Every permitted module stays mounted and is only hidden, so
              switching modules never refetches data or drops in-memory
              state such as a pending Canva retry key. */}
          {modules.map((module) => (
            <div
              key={module.id}
              id={`module-${module.id}`}
              className="workspace-module"
              data-module={module.id}
              hidden={module.id !== activeId}
              tabIndex={-1}
            >
              {module.content}
            </div>
          ))}
          {footer}
        </div>
      </main>
    </div>
  );
}
