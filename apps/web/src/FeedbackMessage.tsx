import { useEffect, useRef } from 'react';

// The visible area the message must sit in: the workspace's scrolling main
// area when there is one, otherwise the browser window.
function visibleBounds(element: HTMLElement): { top: number; bottom: number } {
  const container = element.closest<HTMLElement>('.app-main');
  if (container) {
    const bounds = container.getBoundingClientRect();
    return { top: bounds.top, bottom: bounds.bottom };
  }
  return { top: 0, bottom: window.innerHeight };
}

// Whether the whole message is on screen. A message taller than the visible
// area counts as on screen once its top is.
function onScreen(element: HTMLElement): boolean {
  const bounds = element.getBoundingClientRect();
  const visible = visibleBounds(element);
  return (
    bounds.top >= visible.top &&
    (bounds.bottom <= visible.bottom ||
      bounds.height >= visible.bottom - visible.top)
  );
}

// The element that most recently received focus. Browsers differ in what a
// mouse click focuses: Chrome and Windows browsers focus a clicked button,
// Safari and Firefox on macOS do not. So "nothing has focus" alone does not
// mean focus was lost. It was lost only when the element that last had focus
// has since been removed, for example a confirm button that disappeared with
// its confirmation. Tracking starts when this module loads, before any
// action, and is shared by every message.
let lastFocused: Element | null = null;
if (typeof document !== 'undefined')
  document.addEventListener(
    'focusin',
    (event) => {
      lastFocused = event.target instanceof Element ? event.target : null;
    },
    true,
  );

function focusWasLost(): boolean {
  const active = document.activeElement;
  if (active && active !== document.body) return false;
  return lastFocused !== null && !lastFocused.isConnected;
}

// A screen's success or error message. It keeps the live-region role, so it
// is announced as before. When a new message appears off screen, for example
// after an action at the end of a long form, it is scrolled into view and
// receives focus (it is focusable only by script), so sighted, keyboard and
// screen reader users all land on the result; the next Tab continues from
// there. A message that is already visible is left alone and focus stays
// where it is; it moves to the message only when the focused control has
// disappeared (see focusWasLost), never just because a mouse click left
// nothing focused.
export default function FeedbackMessage({
  tone,
  message,
}: {
  tone: 'error' | 'success';
  message: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!message || !element) return;
    if (!onScreen(element)) {
      element.scrollIntoView?.({ block: 'nearest' });
      element.focus({ preventScroll: true });
      return;
    }
    // An inline confirmation closes after its action, taking the focused
    // button with it, and focus falls back to the page. Once that update has
    // rendered, give focus to the result instead.
    const frame = requestAnimationFrame(() => {
      if (element.isConnected && focusWasLost())
        element.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [message]);
  if (!message) return null;
  return (
    <p
      ref={ref}
      role={tone === 'error' ? 'alert' : 'status'}
      className={
        (tone === 'error' ? 'form-message' : 'success-message') +
        ' feedback-message'
      }
      tabIndex={-1}
    >
      {message}
    </p>
  );
}
