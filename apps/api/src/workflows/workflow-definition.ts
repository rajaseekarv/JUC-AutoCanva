export type StageDefinition = {
  key: string;
  name: string;
  displayOrder: number;
  isEntry?: boolean;
  isTerminal?: boolean;
  requiredPermission?: string | null;
  assignedUserId?: string | null;
  assignedPermission?: string | null;
  requiresReview?: boolean;
};

export type TransitionDefinition = {
  key: string;
  label: string;
  from: string;
  to: string;
  requiredPermission?: string | null;
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | null;
};

export type WorkflowDefinitionInput = {
  name: string;
  description?: string | null;
  stages: StageDefinition[];
  transitions: TransitionDefinition[];
};

const REVIEW_DECISIONS = ['APPROVED', 'CHANGES_REQUESTED'] as const;

export function validateWorkflowDefinition(
  input: WorkflowDefinitionInput,
): string[] {
  const errors: string[] = [];
  if (!input.stages.length) errors.push('At least one stage is required.');
  if (input.stages.filter((stage) => stage.isEntry).length !== 1)
    errors.push('A workflow must have exactly one entry stage.');
  const keys = new Set<string>();
  const orders = new Set<number>();
  for (const stage of input.stages) {
    if (keys.has(stage.key)) errors.push(`Duplicate stage key: ${stage.key}.`);
    keys.add(stage.key);
    if (orders.has(stage.displayOrder))
      errors.push(`Duplicate stage order: ${stage.displayOrder}.`);
    orders.add(stage.displayOrder);
  }
  const seenTransitions = new Set<string>();
  const outgoing = new Set<string>();
  const incoming = new Set<string>();
  for (const transition of input.transitions) {
    if (!keys.has(transition.from) || !keys.has(transition.to))
      errors.push(`Transition ${transition.key} references an unknown stage.`);
    const signature = transition.key;
    if (seenTransitions.has(signature))
      errors.push(`Duplicate transition: ${transition.key}.`);
    seenTransitions.add(signature);
    outgoing.add(transition.from);
    incoming.add(transition.to);
  }
  for (const stage of input.stages) {
    if (!stage.isTerminal && !outgoing.has(stage.key))
      errors.push(
        `Non-terminal stage ${stage.key} requires an outgoing transition.`,
      );
    if (stage.isTerminal && outgoing.has(stage.key))
      errors.push(
        `Terminal stage ${stage.key} cannot have outgoing transitions.`,
      );
    if (stage.isEntry && incoming.has(stage.key))
      errors.push(`Entry stage ${stage.key} cannot have incoming transitions.`);
    if (stage.isEntry && stage.isTerminal)
      errors.push('The entry stage cannot be terminal.');
    if (stage.requiresReview) {
      if (Boolean(stage.assignedUserId) === Boolean(stage.assignedPermission))
        errors.push(
          `Review stage ${stage.key} requires exactly one reviewer assignment.`,
        );
      const stageTransitions = input.transitions.filter(
        (transition) => transition.from === stage.key,
      );
      const reviewTransitions = stageTransitions.filter(
        (transition) => transition.reviewDecision,
      );
      // A reviewer must always be able to approve and to request changes;
      // without either, the review can only end one way.
      for (const decision of REVIEW_DECISIONS)
        if (
          !reviewTransitions.some(
            (transition) => transition.reviewDecision === decision,
          )
        )
          errors.push(
            `Review stage ${stage.key} requires one ${decision} transition.`,
          );
      if (stageTransitions.some((transition) => transition.to === stage.key))
        errors.push(
          `Review stage ${stage.key} cannot transition to itself; a decision must move the run to another stage.`,
        );
      if (reviewTransitions.length !== stageTransitions.length)
        errors.push(
          `Every transition from review stage ${stage.key} must declare a review decision.`,
        );
      const decisions = new Set<string>();
      for (const transition of reviewTransitions) {
        if (decisions.has(transition.reviewDecision!))
          errors.push(
            `Review stage ${stage.key} has multiple ${transition.reviewDecision} transitions.`,
          );
        decisions.add(transition.reviewDecision!);
      }
    }
  }
  for (const transition of input.transitions) {
    if (
      transition.reviewDecision &&
      !input.stages.find((stage) => stage.key === transition.from)
        ?.requiresReview
    )
      errors.push(
        `Transition ${transition.key} has a review decision on a non-review stage.`,
      );
  }
  // A creative cannot be revised while its run is running, and a later
  // review would only see the same revision again. After changes are
  // requested the run must therefore be able to finish without passing
  // through another review stage, or the creative stays locked.
  for (const transition of input.transitions) {
    if (
      transition.reviewDecision === 'CHANGES_REQUESTED' &&
      keys.has(transition.to) &&
      !finishesWithoutReview(input, transition.to)
    )
      errors.push(
        `Changes-requested transition ${transition.key} leads to stage ${transition.to}, which cannot reach a terminal stage without another review. ` +
          'Creatives cannot be revised while a run is active, so this would leave the creative locked; route it to a terminal stage or to stages that lead to one.',
      );
  }
  errors.push(...reachabilityErrors(input, keys));
  return errors;
}

// Every stage must be reachable from the entry, and every reachable stage
// must be able to reach a terminal stage; otherwise a run can stop in a stage
// it can never leave and its creative stays locked. Transitions to unknown
// stages are reported elsewhere and ignored here. Stages already reported as
// dead ends (no outgoing transition) are not reported again.
function reachabilityErrors(
  input: WorkflowDefinitionInput,
  keys: ReadonlySet<string>,
): string[] {
  const entries = input.stages.filter((stage) => stage.isEntry);
  if (entries.length !== 1) return [];
  const entry = entries[0]!;
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const transition of input.transitions) {
    if (!keys.has(transition.from) || !keys.has(transition.to)) continue;
    forward.set(transition.from, [
      ...(forward.get(transition.from) ?? []),
      transition.to,
    ]);
    backward.set(transition.to, [
      ...(backward.get(transition.to) ?? []),
      transition.from,
    ]);
  }
  const fromEntry = reachable([entry.key], forward);
  const toTerminal = reachable(
    input.stages.filter((stage) => stage.isTerminal).map((stage) => stage.key),
    backward,
  );
  const errors: string[] = [];
  const reported = new Set<string>();
  for (const stage of input.stages) {
    if (reported.has(stage.key)) continue;
    reported.add(stage.key);
    if (!fromEntry.has(stage.key))
      errors.push(
        `Stage ${stage.key} is unreachable from the entry stage ${entry.key}.`,
      );
    else if (
      !stage.isTerminal &&
      forward.has(stage.key) &&
      !toTerminal.has(stage.key)
    )
      errors.push(
        `Stage ${stage.key} cannot reach a terminal stage, so a run there could never finish.`,
      );
  }
  return errors;
}

function reachable(
  starts: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const seen = new Set<string>();
  const pending = [...starts];
  while (pending.length) {
    const key = pending.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push(...(edges.get(key) ?? []));
  }
  return seen;
}

// Whether a terminal stage is reachable from `start` without entering a
// review stage.
function finishesWithoutReview(
  input: WorkflowDefinitionInput,
  start: string,
): boolean {
  const visited = new Set<string>();
  const pending = [start];
  while (pending.length) {
    const key = pending.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const stage = input.stages.find((item) => item.key === key);
    if (!stage || stage.requiresReview) continue;
    if (stage.isTerminal) return true;
    for (const transition of input.transitions)
      if (transition.from === key) pending.push(transition.to);
  }
  return false;
}
