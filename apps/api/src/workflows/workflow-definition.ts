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
      if (!reviewTransitions.length)
        errors.push(
          `Review stage ${stage.key} requires a decision transition.`,
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
  return errors;
}
