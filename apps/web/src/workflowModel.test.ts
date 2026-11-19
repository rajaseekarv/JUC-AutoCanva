// Phase 3.5: the structured workflow editor's model. Round-trip fidelity,
// key generation, ordering, editing helpers, and the local mirror of the
// API's definition rules.
import { describe, expect, it } from 'vitest';
import {
  addStage,
  addTransition,
  checkDefinition,
  connectedTransitions,
  keyFromName,
  makeEntry,
  moveStage,
  orderedStages,
  parseDefinition,
  removeStage,
  removeTransition,
  serializeDefinition,
  updateStage,
  updateTransition,
  type DefinitionStage,
  type DefinitionTransition,
  type WorkflowDefinition,
} from './workflowModel';

const stage = (
  key: string,
  displayOrder: number,
  extra: Partial<DefinitionStage> = {},
): DefinitionStage => ({
  key,
  name: key[0]!.toUpperCase() + key.slice(1),
  displayOrder,
  isEntry: false,
  isTerminal: false,
  requiredPermission: null,
  assignedUserId: null,
  assignedPermission: null,
  requiresReview: false,
  ...extra,
});
const step = (
  key: string,
  from: string,
  to: string,
  extra: Partial<DefinitionTransition> = {},
): DefinitionTransition => ({
  key,
  label: key,
  from,
  to,
  requiredPermission: null,
  reviewDecision: null,
  ...extra,
});
// A valid review workflow: draft → review → approved / changes.
const REVIEW: WorkflowDefinition = {
  name: 'Branch review',
  description: null,
  stages: [
    stage('draft', 0, { isEntry: true }),
    stage('review', 1, {
      requiresReview: true,
      assignedPermission: 'approvals:decide',
    }),
    stage('approved', 2, { isTerminal: true }),
    stage('changes', 3, { isTerminal: true }),
  ],
  transitions: [
    step('submit', 'draft', 'review', {
      requiredPermission: 'workflows:transition',
    }),
    step('approve', 'review', 'approved', { reviewDecision: 'APPROVED' }),
    step('request_changes', 'review', 'changes', {
      reviewDecision: 'CHANGES_REQUESTED',
    }),
  ],
};
const messages = (definition: WorkflowDefinition) =>
  checkDefinition(definition).map((problem) => problem.message);

describe('workflow model: round trip', () => {
  it.each([
    ['a review workflow', REVIEW],
    [
      'unknown permission codes and an unavailable reviewer ID',
      {
        ...REVIEW,
        stages: REVIEW.stages.map((item) =>
          item.key === 'review'
            ? {
                ...item,
                assignedPermission: null,
                assignedUserId: 'user-gone-123',
                requiredPermission: 'legacy:custom-permission',
              }
            : item,
        ),
      },
    ],
    [
      'fields the form never shows, and missing optional fields',
      {
        name: 'Minimal',
        stages: [
          { key: 'a', name: 'A', displayOrder: 5, isEntry: true },
          { key: 'b', name: 'B', displayOrder: 2, isTerminal: true },
        ],
        transitions: [{ key: 'go', label: 'Go', from: 'a', to: 'b' }],
      },
    ],
  ])('gives back exactly the saved text for %s', (_label, definition) => {
    const text = JSON.stringify(definition, null, 2);
    const parsed = parseDefinition(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeDefinition(parsed.definition)).toBe(text);
  });

  it('keeps every other value when one field is edited', () => {
    const edited = updateStage(REVIEW, 'review', { name: 'Final review' });
    const before = JSON.parse(
      serializeDefinition(REVIEW),
    ) as WorkflowDefinition;
    const after = JSON.parse(serializeDefinition(edited)) as WorkflowDefinition;
    expect(after.stages[1]).toEqual({
      ...before.stages[1],
      name: 'Final review',
    });
    expect({ ...after, stages: [] }).toEqual({ ...before, stages: [] });
    expect(after.stages.filter((_, index) => index !== 1)).toEqual(
      before.stages.filter((_, index) => index !== 1),
    );
  });

  it('explains text the form cannot show', () => {
    expect(parseDefinition('{').ok).toBe(false);
    expect(parseDefinition('[]')).toEqual({
      ok: false,
      reason: 'The definition must be a JSON object.',
    });
    expect(parseDefinition('{"name":"x","stages":[]}')).toMatchObject({
      ok: false,
    });
    expect(
      parseDefinition(
        '{"name":"x","stages":[{"key":"a","name":"A"}],"transitions":[]}',
      ),
    ).toMatchObject({ ok: false });
  });
});

describe('workflow model: keys and ordering', () => {
  it.each([
    ['Final check', [], 'final_check'],
    ['  Legal & Compliance!  ', [], 'legal_compliance'],
    ['2nd review', [], 'stage_2nd_review'],
    ['', [], 'stage'],
    ['Draft', ['draft'], 'draft_2'],
    ['Draft', ['draft', 'draft_2'], 'draft_3'],
    ['Café', [], 'cafe'],
  ])('makes a key from %j', (name, taken, expected) => {
    expect(keyFromName(name, taken)).toBe(expected);
  });

  it('keeps keys within 64 characters, also with a suffix', () => {
    const long = 'x'.repeat(80);
    const first = keyFromName(long, []);
    expect(first).toHaveLength(64);
    const second = keyFromName(long, [first]);
    expect(second).toHaveLength(64);
    expect(second.endsWith('_2')).toBe(true);
  });

  it('shows stages by display order, then as listed', () => {
    const definition = {
      ...REVIEW,
      stages: [stage('b', 2), stage('a', 1), stage('c', 2)],
    };
    expect(orderedStages(definition).map((item) => item.key)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('moves a stage by swapping display orders with its neighbour only', () => {
    const moved = moveStage(REVIEW, 'approved', -1);
    expect(moved.stages.map((item) => [item.key, item.displayOrder])).toEqual([
      ['draft', 0],
      ['review', 2],
      ['approved', 1],
      ['changes', 3],
    ]);
    expect(moved.transitions).toBe(REVIEW.transitions);
    expect(moveStage(REVIEW, 'draft', -1)).toBe(REVIEW);
    expect(moveStage(REVIEW, 'changes', 1)).toBe(REVIEW);
  });

  it('separates equal orders when moving', () => {
    const definition = {
      ...REVIEW,
      stages: [stage('a', 1), stage('b', 1)],
      transitions: [],
    };
    const moved = moveStage(definition, 'b', -1);
    expect(orderedStages(moved).map((item) => item.key)).toEqual(['b', 'a']);
  });
});

describe('workflow model: editing', () => {
  it('renaming a stage keeps its key, so its steps stay connected', () => {
    const renamed = updateStage(REVIEW, 'review', { name: 'Legal review' });
    expect(renamed.stages[1]?.key).toBe('review');
    expect(connectedTransitions(renamed, 'review')).toHaveLength(3);
    expect(checkDefinition(renamed)).toEqual([]);
  });

  it('adds a stage with a new key after the others', () => {
    const { definition, key } = addStage(REVIEW, 'Review');
    expect(key).toBe('review_2');
    expect(definition.stages.at(-1)).toEqual(
      stage('review_2', 4, { name: 'Review' }),
    );
    expect(
      addStage({ ...REVIEW, stages: [], transitions: [] }, 'First').definition
        .stages[0]?.isEntry,
    ).toBe(true);
  });

  it('removes a stage and every step into or out of it', () => {
    const removed = removeStage(REVIEW, 'review');
    expect(removed.stages.map((item) => item.key)).toEqual([
      'draft',
      'approved',
      'changes',
    ]);
    expect(removed.transitions).toEqual([]);
  });

  it('makes exactly one stage the starting stage', () => {
    const changed = makeEntry(REVIEW, 'review');
    expect(
      changed.stages.filter((item) => item.isEntry).map((item) => item.key),
    ).toEqual(['review']);
  });

  it('adds, changes and removes steps by key', () => {
    let definition = addTransition(REVIEW, 'draft', 'Submit', 'approved');
    expect(definition.transitions.at(-1)).toEqual(
      step('submit_2', 'draft', 'approved', { label: 'Submit' }),
    );
    definition = updateTransition(definition, 'submit_2', { to: 'changes' });
    expect(definition.transitions.at(-1)?.to).toBe('changes');
    definition = removeTransition(definition, 'submit_2');
    expect(definition.transitions).toEqual(REVIEW.transitions);
  });
});

describe('workflow model: the API rules', () => {
  it('finds no problem in a valid review workflow', () => {
    expect(checkDefinition(REVIEW)).toEqual([]);
  });

  const withStages = (
    stages: DefinitionStage[],
    transitions = REVIEW.transitions,
  ) => ({
    ...REVIEW,
    stages,
    transitions,
  });
  it.each<[string, WorkflowDefinition, string]>([
    ['a missing name', { ...REVIEW, name: '  ' }, 'Give the workflow a name'],
    [
      'a long description',
      { ...REVIEW, description: 'x'.repeat(2001) },
      'at most 2000 characters',
    ],
    [
      'no stages',
      { ...REVIEW, stages: [], transitions: [] },
      'Add at least one stage.',
    ],
    [
      'too many stages',
      {
        ...REVIEW,
        stages: Array.from({ length: 101 }, (_, i) => stage('s' + i, i)),
        transitions: [],
      },
      'at most 100 stages',
    ],
    [
      'too many steps',
      {
        ...REVIEW,
        transitions: Array.from({ length: 301 }, (_, i) =>
          step('t' + i, 'draft', 'review'),
        ),
      },
      'at most 300 steps',
    ],
    [
      'an unknown setting',
      { ...REVIEW, owner: 'x' },
      '"owner" is not a workflow setting',
    ],
    [
      'an unknown stage setting',
      withStages([
        { ...REVIEW.stages[0]!, colour: 'red' },
        ...REVIEW.stages.slice(1),
      ]),
      '"colour" is not a stage setting',
    ],
    [
      'a bad stage key',
      withStages([
        { ...REVIEW.stages[0]!, key: 'Draft' },
        ...REVIEW.stages.slice(1),
      ]),
      'The stage key "Draft" must start with a lower-case letter',
    ],
    [
      'a stage without a name',
      withStages([
        { ...REVIEW.stages[0]!, name: '' },
        ...REVIEW.stages.slice(1),
      ]),
      'Give this stage a name',
    ],
    [
      'a fractional order',
      withStages([
        { ...REVIEW.stages[0]!, displayOrder: 0.5 },
        ...REVIEW.stages.slice(1),
      ]),
      'whole number from 0 to 10000',
    ],
    [
      'a long permission',
      withStages([
        { ...REVIEW.stages[0]!, requiredPermission: 'x'.repeat(121) },
        ...REVIEW.stages.slice(1),
      ]),
      'A permission must be 1 to 120 characters.',
    ],
    [
      'a bad step key',
      {
        ...REVIEW,
        transitions: [
          { ...REVIEW.transitions[0]!, key: '1go' },
          ...REVIEW.transitions.slice(1),
        ],
      },
      'The step key "1go"',
    ],
    [
      'a step without a label',
      {
        ...REVIEW,
        transitions: [
          { ...REVIEW.transitions[0]!, label: ' ' },
          ...REVIEW.transitions.slice(1),
        ],
      },
      'Give this step a label',
    ],
    [
      'an unknown decision',
      {
        ...REVIEW,
        transitions: [
          REVIEW.transitions[0]!,
          { ...REVIEW.transitions[1]!, reviewDecision: 'MAYBE' as never },
          REVIEW.transitions[2]!,
        ],
      },
      'approve or request changes',
    ],
    [
      'no starting stage',
      withStages([
        { ...REVIEW.stages[0]!, isEntry: false },
        ...REVIEW.stages.slice(1),
      ]),
      'Choose the starting stage.',
    ],
    [
      'two starting stages',
      withStages([
        REVIEW.stages[0]!,
        { ...REVIEW.stages[1]!, isEntry: true },
        ...REVIEW.stages.slice(2),
      ]),
      'Only one stage can be the starting stage.',
    ],
    [
      'a duplicate stage key',
      withStages([...REVIEW.stages, stage('draft', 9)]),
      'Another stage already uses the key "draft".',
    ],
    [
      'a duplicate position',
      withStages([
        REVIEW.stages[0]!,
        REVIEW.stages[1]!,
        REVIEW.stages[2]!,
        { ...REVIEW.stages[3]!, displayOrder: 2 },
      ]),
      'Another stage has the same position',
    ],
    [
      'a step to a missing stage',
      {
        ...REVIEW,
        transitions: [...REVIEW.transitions, step('lost', 'draft', 'nowhere')],
      },
      'leads from or to a stage that does not exist',
    ],
    [
      'a duplicate step key',
      {
        ...REVIEW,
        transitions: [...REVIEW.transitions, step('submit', 'draft', 'review')],
      },
      'Another step already uses the key "submit".',
    ],
    [
      'a dead-end stage',
      withStages(
        [...REVIEW.stages, stage('stuck', 9)],
        [...REVIEW.transitions, step('to_stuck', 'draft', 'stuck')],
      ),
      'Add a step out of this stage',
    ],
    [
      'a step out of a finishing stage',
      {
        ...REVIEW,
        transitions: [
          ...REVIEW.transitions,
          step('again', 'approved', 'changes'),
        ],
      },
      'A finishing stage cannot have steps out of it.',
    ],
    [
      'a step back into the start',
      withStages(REVIEW.stages, [
        ...REVIEW.transitions.slice(0, 2),
        step('request_changes', 'review', 'draft', {
          reviewDecision: 'CHANGES_REQUESTED',
        }),
      ]),
      'No step can lead back into the starting stage.',
    ],
    [
      'a starting stage that finishes',
      withStages([
        { ...REVIEW.stages[0]!, isTerminal: true },
        ...REVIEW.stages.slice(1),
      ]),
      'The starting stage cannot also be a finishing stage.',
    ],
    [
      'a review without a reviewer',
      withStages([
        REVIEW.stages[0]!,
        { ...REVIEW.stages[1]!, assignedPermission: null },
        ...REVIEW.stages.slice(2),
      ]),
      'Choose who reviews this stage',
    ],
    [
      'a review with two reviewers',
      withStages([
        REVIEW.stages[0]!,
        { ...REVIEW.stages[1]!, assignedUserId: 'user-1' },
        ...REVIEW.stages.slice(2),
      ]),
      'Choose who reviews this stage',
    ],
    [
      'a review without a request-changes step',
      { ...REVIEW, transitions: REVIEW.transitions.slice(0, 2) },
      'one step for reviewers who request changes',
    ],
    [
      'a review step to itself',
      {
        ...REVIEW,
        transitions: [
          ...REVIEW.transitions.slice(0, 2),
          step('request_changes', 'review', 'review', {
            reviewDecision: 'CHANGES_REQUESTED',
          }),
        ],
      },
      'cannot lead back to the same stage',
    ],
    [
      'a review step without a decision',
      {
        ...REVIEW,
        transitions: [
          ...REVIEW.transitions,
          step('skip', 'review', 'approved'),
        ],
      },
      'Every step out of a review must be for approving or for requesting changes.',
    ],
    [
      'two approve steps',
      {
        ...REVIEW,
        transitions: [
          ...REVIEW.transitions,
          step('approve_2', 'review', 'changes', {
            reviewDecision: 'APPROVED',
          }),
        ],
      },
      'only one step for reviewers who approve',
    ],
    [
      'a decision outside a review',
      {
        ...REVIEW,
        transitions: [
          { ...REVIEW.transitions[0]!, reviewDecision: 'APPROVED' },
          ...REVIEW.transitions.slice(1),
        ],
      },
      'Only a step out of a review can be for approving',
    ],
    [
      'changes leading into another review',
      withStages(
        [
          ...REVIEW.stages.slice(0, 3),
          stage('changes', 3, {
            requiresReview: true,
            assignedPermission: 'approvals:decide',
          }),
        ],
        [
          ...REVIEW.transitions,
          step('ok', 'changes', 'approved', { reviewDecision: 'APPROVED' }),
          step('no', 'changes', 'approved', {
            reviewDecision: 'CHANGES_REQUESTED',
          }),
        ],
      ),
      'must be able to finish without another review',
    ],
    [
      'an unreachable stage',
      withStages([...REVIEW.stages, stage('island', 9, { isTerminal: true })]),
      'No step leads here from the starting stage Draft.',
    ],
    [
      'a stage that can never finish',
      withStages(
        [...REVIEW.stages, stage('loop_a', 8), stage('loop_b', 9)],
        [
          ...REVIEW.transitions,
          step('to_a', 'draft', 'loop_a'),
          step('a_b', 'loop_a', 'loop_b'),
          step('b_a', 'loop_b', 'loop_a'),
        ],
      ),
      'A run here could never finish',
    ],
  ])('reports %s', (_label, definition, expected) => {
    expect(messages(definition).join('\n')).toContain(expected);
  });

  it('attaches problems to the stage or step they concern', () => {
    const problems = checkDefinition({
      ...REVIEW,
      transitions: [...REVIEW.transitions, step('lost', 'draft', 'nowhere')],
    });
    expect(problems).toContainEqual({
      target: { kind: 'transition', key: 'lost' },
      message: 'This step leads from or to a stage that does not exist.',
    });
  });
});
