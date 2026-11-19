import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BranchSummary } from '@adflow/shared-types';
import {
  notificationDestination,
  recordModules,
  type RecordDestination,
} from './notificationLinks';
import type { Notice } from './useNotifications';

// A request for one screen to find and select a record. Each has a new key;
// the screen reports back with that key through `reportOpen`.
export type OpenRequest =
  | { key: number; module: 'approvals'; workflowInstanceId: string }
  | {
      key: number;
      module: 'creatives' | 'workflows';
      branchId: string;
      creativeId: string;
    };
// "opened": found and selected. "not-found": the screen's data loaded but
// the record is not in it. "unavailable": the data could not be loaded.
export type OpenOutcome = 'opened' | 'not-found' | 'unavailable';
export type ReportOpen = (key: number, outcome: OpenOutcome) => void;

// What the Creatives form holds, reported by CreativeWorkspace: the selected
// creative ('' for a new one) and whether the form differs from what is
// saved.
export type CreativeFormState = { creativeId: string; dirty: boolean };

export type LinkState =
  | { noticeId: string; status: 'opening' }
  | { noticeId: string; status: 'confirm'; message: string }
  | {
      noticeId: string;
      status: 'failed';
      message: string;
      // The review is no longer waiting: its creative may be opened instead.
      creativeInstead: boolean;
    };

export type RecordNavigation = {
  destination: (notice: Notice) => RecordDestination | null;
  state: LinkState | null;
  open: (notice: Notice, options?: { creativeInstead?: boolean }) => void;
  confirm: () => void;
  cancel: () => void;
};

// A pending request with what is needed to finish it.
type Plan = (
  | { module: 'approvals'; workflowInstanceId: string }
  | {
      module: 'creatives' | 'workflows';
      branchId: string;
      creativeId: string;
    }
) & { notice: Notice; creativeInstead: boolean };
type Pending = Plan & { key: number };

// A destination screen that never answers (it should not happen) does not
// leave the link busy for ever.
export const OPEN_TIMEOUT_MS = 20_000;

export const RECORD_LINK_MESSAGES = {
  reviewGone:
    'This review is no longer waiting for you. It may already have been decided or reassigned.',
  reviewsUnavailable:
    "We couldn't load your reviews, so this review can't be opened. Please try again.",
  creativeUnavailable:
    "We couldn't load this creative. Please try again in a moment.",
  inaccessibleBranch:
    "This notification is for a branch your account can't access, so it can't be opened.",
  noBranch:
    "This notification isn't linked to a branch, so it can't be opened.",
  timedOut: 'Opening this took too long. Please try again.',
};
const creativeGone = (branchName: string) =>
  `This creative is no longer available in the ${branchName} branch.`;
const branchFailed = (branchName: string) =>
  `We couldn't open the ${branchName} branch. Please try again.`;

// Following a notification to its record. App owns one pending request at a
// time; the destination screen (always mounted) finds and selects the record
// once its data for the right branch has loaded, then reports back. Only
// then is the notification marked read and the module's hash set, so Back
// returns to Notifications. A failure keeps the user on Notifications with
// the notification unread and an explanation beside it.
export function useRecordLinks({
  accessToken,
  permissions,
  branches,
  selectedBranchId,
  selectBranch,
  branchError,
  creativeForm,
  markRead,
}: {
  accessToken: string | null;
  permissions: readonly string[];
  branches: readonly BranchSummary[];
  selectedBranchId: string;
  // Switches the app's branch (only ever to one of `branches`).
  selectBranch: (branchId: string) => void;
  // The app's error for loading the selected branch, if any.
  branchError: string;
  creativeForm: { readonly current: CreativeFormState };
  markRead: (id: string) => Promise<void>;
}): {
  navigation: RecordNavigation;
  openRequest: OpenRequest | null;
  reportOpen: ReportOpen;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const [state, setState] = useState<LinkState | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;
  const awaitingConfirm = useRef<Plan | null>(null);
  const keys = useRef(0);
  const modules = useMemo(() => recordModules(permissions), [permissions]);
  const branchName = useCallback(
    (id: string) => branches.find((item) => item.id === id)?.name ?? 'selected',
    [branches],
  );

  const finish = useCallback(
    (key: number, outcome: OpenOutcome | 'branch-failed' | 'timed-out') => {
      const current = pendingRef.current;
      if (!current || current.key !== key) return;
      pendingRef.current = null;
      setPending(null);
      const { notice } = current;
      if (outcome === 'opened') {
        setState(null);
        if (!notice.readAt) void markRead(notice.id);
        window.location.hash = '#' + current.module;
        return;
      }
      let message: string;
      let creativeInstead = false;
      if (outcome === 'timed-out') message = RECORD_LINK_MESSAGES.timedOut;
      else if (current.module === 'approvals') {
        message =
          outcome === 'not-found'
            ? RECORD_LINK_MESSAGES.reviewGone
            : RECORD_LINK_MESSAGES.reviewsUnavailable;
        const destination = notificationDestination(notice, modules);
        creativeInstead =
          outcome === 'not-found' &&
          destination?.kind === 'review' &&
          destination.creativeId !== null;
      } else if (outcome === 'branch-failed')
        message = branchFailed(branchName(current.branchId));
      else
        message =
          outcome === 'not-found'
            ? creativeGone(branchName(current.branchId))
            : RECORD_LINK_MESSAGES.creativeUnavailable;
      setState({
        noticeId: notice.id,
        status: 'failed',
        message,
        creativeInstead,
      });
    },
    [markRead, modules, branchName],
  );

  const start = useCallback(
    (plan: Plan) => {
      awaitingConfirm.current = null;
      const next = { ...plan, key: ++keys.current } as Pending;
      if (next.module !== 'approvals' && next.branchId !== selectedBranchId)
        selectBranch(next.branchId);
      pendingRef.current = next;
      setPending(next);
      setState({ noticeId: plan.notice.id, status: 'opening' });
    },
    [selectedBranchId, selectBranch],
  );

  const open = useCallback(
    (notice: Notice, options: { creativeInstead?: boolean } = {}) => {
      const destination = notificationDestination(notice, modules);
      if (!destination) return;
      const creativeInstead = options.creativeInstead === true;
      if (destination.kind === 'review' && !creativeInstead) {
        start({
          module: 'approvals',
          workflowInstanceId: destination.workflowInstanceId,
          notice,
          creativeInstead,
        });
        return;
      }
      const creativeId = destination.creativeId;
      if (!creativeId) return;
      const module =
        destination.kind === 'review' ? 'creatives' : destination.module;
      const fail = (message: string) => {
        awaitingConfirm.current = null;
        setState({
          noticeId: notice.id,
          status: 'failed',
          message,
          creativeInstead: false,
        });
      };
      const branchId = destination.branchId ?? selectedBranchId;
      if (!branchId) return fail(RECORD_LINK_MESSAGES.noBranch);
      // Never switch to a branch outside the user's own list.
      if (!branches.some((item) => item.id === branchId))
        return fail(RECORD_LINK_MESSAGES.inaccessibleBranch);
      const plan: Plan = {
        module,
        branchId,
        creativeId,
        notice,
        creativeInstead,
      };
      // Switching branch resets the Creatives form; opening a different
      // creative there replaces it. Either needs consent for unsaved edits.
      const form = creativeForm.current;
      const changesBranch = branchId !== selectedBranchId;
      const replaces = module === 'creatives' && form.creativeId !== creativeId;
      if (form.dirty && (changesBranch || replaces)) {
        awaitingConfirm.current = plan;
        setState({
          noticeId: notice.id,
          status: 'confirm',
          message: changesBranch
            ? `You have unsaved changes in Creatives. Opening this creative switches to the ${branchName(branchId)} branch and discards them.`
            : 'You have unsaved changes to another creative in Creatives. Opening this creative discards them.',
        });
        return;
      }
      start(plan);
    },
    [modules, start, selectedBranchId, branches, creativeForm, branchName],
  );

  const confirm = useCallback(() => {
    const plan = awaitingConfirm.current;
    if (plan) start(plan);
  }, [start]);
  const cancel = useCallback(() => {
    awaitingConfirm.current = null;
    setState(null);
  }, []);

  // The destination branch could not be loaded, so its screens never show
  // its creatives.
  useEffect(() => {
    if (
      pending &&
      pending.module !== 'approvals' &&
      pending.branchId === selectedBranchId &&
      branchError
    )
      finish(pending.key, 'branch-failed');
  }, [pending, selectedBranchId, branchError, finish]);

  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(
      () => finish(pending.key, 'timed-out'),
      OPEN_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [pending, finish]);

  // A new session starts with nothing pending.
  useEffect(() => {
    awaitingConfirm.current = null;
    pendingRef.current = null;
    setPending(null);
    setState(null);
  }, [accessToken]);

  const reportOpen = useCallback<ReportOpen>(
    (key, outcome) => finish(key, outcome),
    [finish],
  );
  const destination = useCallback(
    (notice: Notice) => notificationDestination(notice, modules),
    [modules],
  );
  const openRequest = useMemo<OpenRequest | null>(() => {
    if (!pending) return null;
    return pending.module === 'approvals'
      ? {
          key: pending.key,
          module: 'approvals',
          workflowInstanceId: pending.workflowInstanceId,
        }
      : {
          key: pending.key,
          module: pending.module,
          branchId: pending.branchId,
          creativeId: pending.creativeId,
        };
  }, [pending]);

  return {
    navigation: { destination, state, open, confirm, cancel },
    openRequest,
    reportOpen,
  };
}
