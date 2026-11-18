import { useEffect, useRef } from 'react';

// Tells the app whether a screen holds unsaved edits, so leaving the page and
// signing out can ask first (see App). Reports each change once, and
// "nothing unsaved" when the screen goes away.
export function useReportUnsaved(
  dirty: boolean,
  onUnsavedChange: ((dirty: boolean) => void) | undefined,
): void {
  const report = useRef(onUnsavedChange);
  report.current = onUnsavedChange;
  useEffect(() => {
    report.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => report.current?.(false), []);
}
