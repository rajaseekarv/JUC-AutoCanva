// The workflow definition the structured editor edits (Phase 3.5): the same
// JSON the API accepts for POST/PATCH /workflows and the Advanced JSON view
// shows. Editing changes only what the user changes; every other value,
// including unknown permission codes and reviewer IDs, is kept exactly, so
// an unchanged definition serializes back to the same text.
//
// checkDefinition mirrors the API's request schema (workflows.controller)
// and its definition rules (workflow-definition.ts) so problems can be shown
// beside the stage or step they concern. The API stays authoritative: it
// validates every save and alone checks that permission codes and reviewers
// exist.

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED';
export type DefinitionStage = {
  key: string;
  name: string;
  displayOrder: number;
  isEntry?: boolean;
  isTerminal?: boolean;
  requiredPermission?: string | null;
  assignedUserId?: string | null;
  assignedPermission?: string | null;
  requiresReview?: boolean;
  [other: string]: unknown;
};
export type DefinitionTransition = {
  key: string;
  label: string;
  from: string;
  to: string;
  requiredPermission?: string | null;
  reviewDecision?: ReviewDecision | null;
  [other: string]: unknown;
};
export type WorkflowDefinition = {
  name: string;
  description?: string | null;
  stages: DefinitionStage[];
  transitions: DefinitionTransition[];
  [other: string]: unknown;
};

// ---- Text <-> definition ----

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The definition in the editor's text, when it has the shape the form can
// show; otherwise why not (the Advanced JSON view still shows the text).
export function parseDefinition(
  text: string,
):
  { ok: true; definition: WorkflowDefinition } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "The definition isn't valid JSON." };
  }
  if (!isRecord(parsed))
    return { ok: false, reason: 'The definition must be a JSON object.' };
  const { stages, transitions } = parsed;
  if (typeof parsed.name !== 'string')
    return { ok: false, reason: 'The definition needs a "name".' };
  if (!Array.isArray(stages) || !Array.isArray(transitions))
    return {
      ok: false,
      reason: 'The definition needs "stages" and "transitions" lists.',
    };
  if (
    !stages.every(
      (stage) =>
        isRecord(stage) &&
        typeof stage.key === 'string' &&
        typeof stage.name === 'string' &&
        typeof stage.displayOrder === 'number',
    )
  )
    return {
      ok: false,
      reason: 'Every stage needs a "key", a "name" and a "displayOrder".',
    };
  if (
    !transitions.every(
      (transition) =>
        isRecord(transition) &&
        ['key', 'label', 'from', 'to'].every(
          (part) => typeof transition[part] === 'string',
        ),
    )
  )
    return {
      ok: false,
      reason: 'Every transition needs a "key", "label", "from" and "to".',
    };
  return { ok: true, definition: parsed as WorkflowDefinition };
}

// The same layout the screen uses for a saved version, so an unchanged
// definition gives back the text it was read from.
export const serializeDefinition = (definition: WorkflowDefinition) =>
  JSON.stringify(definition, null, 2);

// ---- Keys and ordering ----

export const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const KEY_LIMIT = 64;

// A key for a new stage or step, made from its name: lower case, words
// joined by "_", starting with a letter, unique among `taken` ("_2", "_3"
// … are added when needed).
export function keyFromName(
  name: string,
  taken: Iterable<string>,
  fallback = 'stage',
): string {
  let base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(base)) base = base ? fallback + '_' + base : fallback;
  base = base.slice(0, KEY_LIMIT).replace(/_+$/, '');
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const ending = '_' + suffix;
    const candidate = base.slice(0, KEY_LIMIT - ending.length) + ending;
    if (!used.has(candidate)) return candidate;
  }
}

// Stages in the order the screen shows them: by display order, then as
// listed.
export function orderedStages(
  definition: WorkflowDefinition,
): DefinitionStage[] {
  return definition.stages
    .map((stage, index) => ({ stage, index }))
    .sort(
      (a, b) =>
        a.stage.displayOrder - b.stage.displayOrder || a.index - b.index,
    )
    .map(({ stage }) => stage);
}

// Moves a stage one place up or down in the shown order by swapping its
// display order with its neighbour's; no other stage changes. Transitions
// refer to stages by key, so they stay connected.
export function moveStage(
  definition: WorkflowDefinition,
  key: string,
  offset: -1 | 1,
): WorkflowDefinition {
  const ordered = orderedStages(definition);
  const index = ordered.findIndex((stage) => stage.key === key);
  const other = ordered[index + offset];
  const stage = ordered[index];
  if (!stage || !other) return definition;
  // Normally the two swap orders.
  let stageOrder = other.displayOrder;
  let otherOrder = stage.displayOrder;
  // Equal orders (only in hand-written JSON) cannot be swapped; place the
  // moved stage just before or after its neighbour so the move is visible.
  if (stage.displayOrder === other.displayOrder) {
    otherOrder = other.displayOrder;
    stageOrder = offset < 0 ? otherOrder - 1 : otherOrder + 1;
    if (stageOrder < 0) {
      stageOrder = 0;
      otherOrder = 1;
    }
  }
  return {
    ...definition,
    stages: definition.stages.map((item) =>
      item === stage
        ? { ...item, displayOrder: stageOrder }
        : item === other
          ? { ...item, displayOrder: otherOrder }
          : item,
    ),
  };
}

// ---- Editing ----

export function updateStage(
  definition: WorkflowDefinition,
  key: string,
  change: Partial<DefinitionStage>,
): WorkflowDefinition {
  return {
    ...definition,
    stages: definition.stages.map((stage) =>
      stage.key === key ? { ...stage, ...change } : stage,
    ),
  };
}

// Makes one stage the starting (entry) stage; every other stage stops
// being one, since a workflow has exactly one.
export function makeEntry(
  definition: WorkflowDefinition,
  key: string,
): WorkflowDefinition {
  return {
    ...definition,
    stages: definition.stages.map((stage) =>
      stage.key === key
        ? { ...stage, isEntry: true }
        : stage.isEntry
          ? { ...stage, isEntry: false }
          : stage,
    ),
  };
}

export function addStage(
  definition: WorkflowDefinition,
  name: string,
): { definition: WorkflowDefinition; key: string } {
  const key = keyFromName(
    name,
    definition.stages.map((stage) => stage.key),
  );
  const displayOrder = Math.min(
    10000,
    definition.stages.reduce(
      (highest, stage) => Math.max(highest, stage.displayOrder + 1),
      0,
    ),
  );
  const stage: DefinitionStage = {
    key,
    name: name.trim(),
    displayOrder,
    isEntry: definition.stages.length === 0,
    isTerminal: false,
    requiredPermission: null,
    assignedUserId: null,
    assignedPermission: null,
    requiresReview: false,
  };
  return {
    definition: { ...definition, stages: [...definition.stages, stage] },
    key,
  };
}

// Removes a stage and every step into or out of it.
export function removeStage(
  definition: WorkflowDefinition,
  key: string,
): WorkflowDefinition {
  return {
    ...definition,
    stages: definition.stages.filter((stage) => stage.key !== key),
    transitions: definition.transitions.filter(
      (transition) => transition.from !== key && transition.to !== key,
    ),
  };
}

// The steps into or out of a stage, which removing it also removes.
export const connectedTransitions = (
  definition: WorkflowDefinition,
  key: string,
) =>
  definition.transitions.filter(
    (transition) => transition.from === key || transition.to === key,
  );

export function addTransition(
  definition: WorkflowDefinition,
  from: string,
  label: string,
  to: string,
  reviewDecision: ReviewDecision | null = null,
): WorkflowDefinition {
  const key = keyFromName(
    label,
    definition.transitions.map((transition) => transition.key),
    'step',
  );
  return {
    ...definition,
    transitions: [
      ...definition.transitions,
      {
        key,
        label: label.trim(),
        from,
        to,
        requiredPermission: null,
        reviewDecision,
      },
    ],
  };
}

export function updateTransition(
  definition: WorkflowDefinition,
  key: string,
  change: Partial<DefinitionTransition>,
): WorkflowDefinition {
  return {
    ...definition,
    transitions: definition.transitions.map((transition) =>
      transition.key === key ? { ...transition, ...change } : transition,
    ),
  };
}

export function removeTransition(
  definition: WorkflowDefinition,
  key: string,
): WorkflowDefinition {
  return {
    ...definition,
    transitions: definition.transitions.filter(
      (transition) => transition.key !== key,
    ),
  };
}

// ---- Permissions offered in the editor ----

// The API's permission codes (apps/api/src/auth/permissions.ts), with the
// plain-language names used elsewhere for the ones workflows usually use.
export const PERMISSION_CHOICES: { code: string; label: string }[] = [
  { code: 'approvals:decide', label: 'People who can approve creatives' },
  { code: 'workflows:transition', label: 'People who can move workflows on' },
  { code: 'workflows:manage', label: 'Workflow managers' },
  { code: 'workflows:start', label: 'People who can start workflows' },
  { code: 'workflows:read', label: 'People who can view workflows' },
  { code: 'approvals:read', label: 'People who can view approvals' },
  {
    code: 'change_requests:read',
    label: 'People who can view change requests',
  },
  { code: 'change_requests:create', label: 'People who can request changes' },
  {
    code: 'change_requests:resolve',
    label: 'People who can resolve change requests',
  },
  { code: 'comments:read', label: 'People who can read comments' },
  { code: 'comments:create', label: 'People who can comment' },
  { code: 'creatives:read', label: 'People who can view creatives' },
  { code: 'creatives:create', label: 'People who can create creatives' },
  { code: 'creatives:update', label: 'People who can edit creatives' },
  { code: 'templates:read', label: 'People who can view templates' },
  { code: 'templates:create', label: 'People who can create templates' },
  { code: 'templates:edit', label: 'People who can edit templates' },
  { code: 'templates:activate', label: 'People who can activate templates' },
  { code: 'templates:archive', label: 'People who can archive templates' },
  { code: 'brand:read', label: 'People who can view brand settings' },
  { code: 'brand:manage', label: 'People who can manage brand settings' },
  { code: 'assets:read', label: 'People who can view images' },
  { code: 'assets:manage', label: 'People who can manage images' },
  { code: 'branches:read', label: 'People who can view branches' },
  { code: 'branches:manage', label: 'People who can manage branches' },
  {
    code: 'organizations:update',
    label: 'People who can update the organization',
  },
  {
    code: 'users:branch-access:manage',
    label: 'People who can manage user branch access',
  },
  { code: 'audit:read', label: 'People who can view audit history' },
  {
    code: 'canva:integration:read',
    label: 'People who can view the Canva connection',
  },
  {
    code: 'canva:integration:manage',
    label: 'People who can manage the Canva connection',
  },
  { code: 'canva:jobs:create', label: 'People who can send work to Canva' },
];
export const permissionLabel = (code: string) =>
  PERMISSION_CHOICES.find((choice) => choice.code === code)?.label ??
  'Other permission (' + code + ')';
export const isKnownPermission = (code: string) =>
  PERMISSION_CHOICES.some((choice) => choice.code === code);

// ---- Local validation ----

export type ProblemTarget =
  | { kind: 'workflow' }
  | { kind: 'stage'; key: string }
  | { kind: 'transition'; key: string };
export type DefinitionProblem = { target: ProblemTarget; message: string };

const REVIEW_DECISIONS: ReviewDecision[] = ['APPROVED', 'CHANGES_REQUESTED'];
const decisionWord = (decision: ReviewDecision) =>
  decision === 'APPROVED' ? 'approve' : 'request changes';
const textOk = (value: unknown, max: number) =>
  typeof value === 'string' &&
  value.trim().length >= 1 &&
  value.trim().length <= max;
const optionalCode = (value: unknown) =>
  value === null ||
  value === undefined ||
  (typeof value === 'string' &&
    value.trim().length >= 1 &&
    value.trim().length <= 120);

// Every problem the API would report for this definition, beside the stage
// or step it concerns, in words that use stage names.
export function checkDefinition(
  definition: WorkflowDefinition,
): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  const workflow = (message: string) =>
    problems.push({ target: { kind: 'workflow' }, message });
  const atStage = (key: string, message: string) =>
    problems.push({ target: { kind: 'stage', key }, message });
  const atTransition = (key: string, message: string) =>
    problems.push({ target: { kind: 'transition', key }, message });
  const { stages, transitions } = definition;
  const nameOf = (key: string) =>
    stages.find((stage) => stage.key === key)?.name || key;

  // Request format (workflows.controller): the API answers these with
  // "Invalid workflow data", so they are explained here.
  if (!textOk(definition.name, 120))
    workflow('Give the workflow a name of 1 to 120 characters.');
  if (
    definition.description !== undefined &&
    definition.description !== null &&
    (typeof definition.description !== 'string' ||
      definition.description.trim().length > 2000)
  )
    workflow('The description must be at most 2000 characters.');
  // The API's schema is strict: an unknown setting refuses the whole save.
  const unknown = (value: object, allowed: string[]) =>
    Object.keys(value).filter((key) => !allowed.includes(key));
  for (const key of unknown(definition, [
    'name',
    'description',
    'stages',
    'transitions',
  ]))
    workflow(`"${key}" is not a workflow setting the API accepts.`);
  for (const stage of stages)
    for (const key of unknown(stage, [
      'key',
      'name',
      'displayOrder',
      'isEntry',
      'isTerminal',
      'requiredPermission',
      'assignedUserId',
      'assignedPermission',
      'requiresReview',
    ]))
      atStage(stage.key, `"${key}" is not a stage setting the API accepts.`);
  for (const transition of transitions)
    for (const key of unknown(transition, [
      'key',
      'label',
      'from',
      'to',
      'requiredPermission',
      'reviewDecision',
    ]))
      atTransition(
        transition.key,
        `"${key}" is not a step setting the API accepts.`,
      );
  if (!stages.length) workflow('Add at least one stage.');
  if (stages.length > 100) workflow('A workflow can have at most 100 stages.');
  if (transitions.length > 300)
    workflow('A workflow can have at most 300 steps between stages.');
  for (const stage of stages) {
    if (
      typeof stage.key !== 'string' ||
      stage.key.trim().length > KEY_LIMIT ||
      !KEY_PATTERN.test(stage.key.trim())
    )
      atStage(
        stage.key,
        `The stage key "${stage.key}" must start with a lower-case letter and use only lower-case letters, digits and "_" (at most 64).`,
      );
    if (!textOk(stage.name, 120))
      atStage(stage.key, 'Give this stage a name of 1 to 120 characters.');
    if (
      !Number.isInteger(stage.displayOrder) ||
      stage.displayOrder < 0 ||
      stage.displayOrder > 10000
    )
      atStage(
        stage.key,
        'The stage order must be a whole number from 0 to 10000.',
      );
    for (const flag of ['isEntry', 'isTerminal', 'requiresReview'] as const)
      if (stage[flag] !== undefined && typeof stage[flag] !== 'boolean')
        atStage(stage.key, `"${flag}" must be true or false.`);
    if (
      !optionalCode(stage.requiredPermission) ||
      !optionalCode(stage.assignedPermission)
    )
      atStage(stage.key, 'A permission must be 1 to 120 characters.');
    if (
      stage.assignedUserId !== undefined &&
      stage.assignedUserId !== null &&
      (typeof stage.assignedUserId !== 'string' || !stage.assignedUserId.trim())
    )
      atStage(stage.key, 'The reviewer must be a person or left empty.');
  }
  for (const transition of transitions) {
    if (
      typeof transition.key !== 'string' ||
      transition.key.trim().length > KEY_LIMIT ||
      !KEY_PATTERN.test(transition.key.trim())
    )
      atTransition(
        transition.key,
        `The step key "${transition.key}" must start with a lower-case letter and use only lower-case letters, digits and "_" (at most 64).`,
      );
    if (!textOk(transition.label, 120))
      atTransition(
        transition.key,
        'Give this step a label of 1 to 120 characters.',
      );
    if (!optionalCode(transition.requiredPermission))
      atTransition(transition.key, 'A permission must be 1 to 120 characters.');
    if (
      transition.reviewDecision !== undefined &&
      transition.reviewDecision !== null &&
      !REVIEW_DECISIONS.includes(transition.reviewDecision)
    )
      atTransition(
        transition.key,
        'A review decision must be approve or request changes.',
      );
  }

  // Definition rules (workflow-definition.ts).
  const entries = stages.filter((stage) => stage.isEntry);
  if (stages.length && entries.length !== 1)
    workflow(
      entries.length
        ? 'Only one stage can be the starting stage.'
        : 'Choose the starting stage.',
    );
  const keys = new Set<string>();
  const orders = new Set<number>();
  for (const stage of stages) {
    if (keys.has(stage.key))
      atStage(stage.key, `Another stage already uses the key "${stage.key}".`);
    keys.add(stage.key);
    if (orders.has(stage.displayOrder))
      atStage(
        stage.key,
        'Another stage has the same position; move one of them.',
      );
    orders.add(stage.displayOrder);
  }
  const seenTransitions = new Set<string>();
  const outgoing = new Set<string>();
  const incoming = new Set<string>();
  for (const transition of transitions) {
    if (!keys.has(transition.from) || !keys.has(transition.to))
      atTransition(
        transition.key,
        'This step leads from or to a stage that does not exist.',
      );
    if (seenTransitions.has(transition.key))
      atTransition(
        transition.key,
        `Another step already uses the key "${transition.key}".`,
      );
    seenTransitions.add(transition.key);
    outgoing.add(transition.from);
    incoming.add(transition.to);
  }
  for (const stage of stages) {
    if (!stage.isTerminal && !outgoing.has(stage.key))
      atStage(
        stage.key,
        'Add a step out of this stage, or make it a finishing stage.',
      );
    if (stage.isTerminal && outgoing.has(stage.key))
      atStage(stage.key, 'A finishing stage cannot have steps out of it.');
    if (stage.isEntry && incoming.has(stage.key))
      atStage(stage.key, 'No step can lead back into the starting stage.');
    if (stage.isEntry && stage.isTerminal)
      atStage(
        stage.key,
        'The starting stage cannot also be a finishing stage.',
      );
    if (stage.requiresReview) {
      if (Boolean(stage.assignedUserId) === Boolean(stage.assignedPermission))
        atStage(
          stage.key,
          'Choose who reviews this stage: one person, or everyone with a permission.',
        );
      const stageTransitions = transitions.filter(
        (transition) => transition.from === stage.key,
      );
      const reviewTransitions = stageTransitions.filter(
        (transition) => transition.reviewDecision,
      );
      for (const decision of REVIEW_DECISIONS)
        if (
          !reviewTransitions.some(
            (transition) => transition.reviewDecision === decision,
          )
        )
          atStage(
            stage.key,
            `A review needs one step for reviewers who ${decisionWord(decision)}.`,
          );
      if (stageTransitions.some((transition) => transition.to === stage.key))
        atStage(
          stage.key,
          'A review step cannot lead back to the same stage; a decision must move the run on.',
        );
      if (reviewTransitions.length !== stageTransitions.length)
        atStage(
          stage.key,
          'Every step out of a review must be for approving or for requesting changes.',
        );
      const decisions = new Set<string>();
      for (const transition of reviewTransitions) {
        if (decisions.has(transition.reviewDecision!))
          atStage(
            stage.key,
            `A review can have only one step for reviewers who ${decisionWord(transition.reviewDecision!)}.`,
          );
        decisions.add(transition.reviewDecision!);
      }
    }
  }
  for (const transition of transitions) {
    if (
      transition.reviewDecision &&
      !stages.find((stage) => stage.key === transition.from)?.requiresReview
    )
      atTransition(
        transition.key,
        'Only a step out of a review can be for approving or requesting changes.',
      );
  }
  for (const transition of transitions)
    if (
      transition.reviewDecision === 'CHANGES_REQUESTED' &&
      keys.has(transition.to) &&
      !finishesWithoutReview(definition, transition.to)
    )
      atTransition(
        transition.key,
        `After changes are requested the run must be able to finish without another review, but ${nameOf(transition.to)} cannot. Creatives cannot be revised while a run is active, so the creative would stay locked; lead this step to a finishing stage or to stages that reach one.`,
      );
  // Reachability: every stage reachable from the entry, and able to finish.
  if (entries.length === 1) {
    const entry = entries[0]!;
    const forward = new Map<string, string[]>();
    const backward = new Map<string, string[]>();
    for (const transition of transitions) {
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
      stages.filter((stage) => stage.isTerminal).map((stage) => stage.key),
      backward,
    );
    const reported = new Set<string>();
    for (const stage of stages) {
      if (reported.has(stage.key)) continue;
      reported.add(stage.key);
      if (!fromEntry.has(stage.key))
        atStage(
          stage.key,
          `No step leads here from the starting stage ${entry.name || entry.key}.`,
        );
      else if (
        !stage.isTerminal &&
        forward.has(stage.key) &&
        !toTerminal.has(stage.key)
      )
        atStage(
          stage.key,
          'A run here could never finish: no steps lead from here to a finishing stage.',
        );
    }
  }
  return problems;
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

function finishesWithoutReview(
  definition: WorkflowDefinition,
  start: string,
): boolean {
  const visited = new Set<string>();
  const pending = [start];
  while (pending.length) {
    const key = pending.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const stage = definition.stages.find((item) => item.key === key);
    if (!stage || stage.requiresReview) continue;
    if (stage.isTerminal) return true;
    for (const transition of definition.transitions)
      if (transition.from === key) pending.push(transition.to);
  }
  return false;
}
