import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import FeedbackMessage from './FeedbackMessage';

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

// Places every element at the given vertical position (jsdom has no layout).
function placeAt(top: number, height = 40) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      // The scrolling main area spans 0–800; the message sits at the given top.
      if (this.classList.contains('app-main'))
        return DOMRect.fromRect({ x: 0, y: 0, width: 400, height: 800 });
      return DOMRect.fromRect({ x: 0, y: top, width: 400, height });
    },
  );
}

function renderInMain(element: JSX.Element) {
  return render(
    <main className="app-main">
      <button type="button">Save</button>
      {element}
    </main>,
  );
}

describe('FeedbackMessage', () => {
  it('keeps the live-region roles and message styles', () => {
    renderInMain(
      <>
        <FeedbackMessage tone="error" message="Could not save." />
        <FeedbackMessage tone="success" message="Saved." />
      </>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save.');
    expect(screen.getByRole('alert')).toHaveClass('form-message');
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
    expect(screen.getByRole('status')).toHaveClass('success-message');
  });

  it('renders nothing without a message', () => {
    const view = renderInMain(<FeedbackMessage tone="error" message="" />);
    expect(view.container.querySelector('.feedback-message')).toBeNull();
  });

  it('scrolls an off-screen message into view and moves focus to it', () => {
    placeAt(-600);
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const save = () => screen.getByRole('button', { name: 'Save' });
    const view = renderInMain(<FeedbackMessage tone="success" message="" />);
    save().focus();
    view.rerender(
      <main className="app-main">
        <button type="button">Save</button>
        <FeedbackMessage tone="success" message="Field updated." />
      </main>,
    );
    const status = screen.getByRole('status');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(status).toHaveFocus();
    // Focusable by script only, so it never becomes an extra Tab stop.
    expect(status).toHaveAttribute('tabindex', '-1');
  });

  it('also reveals a message below the visible area', () => {
    placeAt(900);
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    renderInMain(<FeedbackMessage tone="error" message="Could not save." />);
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert')).toHaveFocus();
  });

  it('leaves a visible message alone, so focus stays on the control used', () => {
    placeAt(100);
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const view = renderInMain(<FeedbackMessage tone="error" message="" />);
    screen.getByRole('button', { name: 'Save' }).focus();
    view.rerender(
      <main className="app-main">
        <button type="button">Save</button>
        <FeedbackMessage tone="error" message="Could not save." />
      </main>,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
  });

  it('takes focus when the control that was used has disappeared', async () => {
    placeAt(100);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    // A confirmation's confirm button had focus, then closed with it.
    const view = render(
      <main className="app-main">
        <button type="button">Deactivate branch</button>
        <FeedbackMessage tone="success" message="" />
      </main>,
    );
    screen.getByRole('button', { name: 'Deactivate branch' }).focus();
    view.rerender(
      <main className="app-main">
        <FeedbackMessage tone="success" message="Branch deactivated." />
      </main>,
    );
    expect(document.activeElement).toBe(document.body);
    await waitFor(() => expect(screen.getByRole('status')).toHaveFocus());
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  // Safari and Firefox on macOS do not focus a clicked button, so after a
  // mouse-driven action nothing has focus although nothing was lost. The
  // message must not take focus then: the next Tab continues from where the
  // user was.
  it('leaves focus alone after a click that focused nothing', async () => {
    placeAt(100);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const view = render(
      <main className="app-main">
        <input aria-label="Name" />
        <button type="button">Save</button>
        <FeedbackMessage tone="success" message="" />
      </main>,
    );
    // The user last typed in Name, then clicked Save with the mouse.
    const name = screen.getByRole('textbox', { name: 'Name' });
    name.focus();
    name.blur();
    view.rerender(
      <main className="app-main">
        <input aria-label="Name" />
        <button type="button">Save</button>
        <FeedbackMessage tone="success" message="Saved." />
      </main>,
    );
    // Give the deferred focus check its frame.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(screen.getByRole('status')).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });

  it('reveals the message again for each new action', () => {
    placeAt(-600);
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const view = renderInMain(
      <FeedbackMessage tone="success" message="Field updated." />,
    );
    // Screens clear the message when an action starts, then set it again.
    view.rerender(
      <main className="app-main">
        <button type="button">Save</button>
        <FeedbackMessage tone="success" message="" />
      </main>,
    );
    view.rerender(
      <main className="app-main">
        <button type="button">Save</button>
        <FeedbackMessage tone="success" message="Field updated." />
      </main>,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});
