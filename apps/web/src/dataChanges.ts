import { useCallback, useEffect, useRef, useState } from 'react';

// Every module stays mounted, so each keeps its own copy of shared data. A
// screen that changes review data reports it; the other screens refresh
// their lists instead of waiting for a sign-in or page reload.
export type DataChangeSource = 'creatives' | 'workflows' | 'approvals';
export type DataChange = { key: number; source: DataChangeSource | '' };
export const noDataChange: DataChange = { key: 0, source: '' };

// Owned by the app shell: the current change and the callback screens use
// to report one.
export function useDataChanges(): [
  DataChange,
  (source: DataChangeSource) => void,
] {
  const [change, setChange] = useState<DataChange>(noDataChange);
  const report = useCallback(
    (source: DataChangeSource) =>
      setChange((current) => ({ key: current.key + 1, source })),
    [],
  );
  return [change, report];
}

// Calls `refresh` once for each change reported by another screen. It never
// runs on mount (the screen loads on its own then) or for the screen's own
// changes (it already updated itself), so no request is duplicated.
export function useOtherScreenChanges(
  change: DataChange | undefined,
  self: DataChangeSource,
  refresh: () => void,
): void {
  const seen = useRef(change?.key ?? 0);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  const key = change?.key ?? 0;
  const source = change?.source ?? '';
  useEffect(() => {
    if (key === seen.current) return;
    seen.current = key;
    if (source !== self) latestRefresh.current();
  }, [key, source, self]);
}
