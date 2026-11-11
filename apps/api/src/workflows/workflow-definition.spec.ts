import { describe, expect, it } from 'vitest';
import {
  validateWorkflowDefinition,
  type WorkflowDefinitionInput,
} from './workflow-definition';

const valid: WorkflowDefinitionInput = {
  name: 'Branch campaign',
  stages: [
    { key: 'draft', name: 'Draft', displayOrder: 0, isEntry: true },
    { key: 'ready', name: 'Ready', displayOrder: 1, isTerminal: true },
  ],
  transitions: [{ key: 'submit', label: 'Submit', from: 'draft', to: 'ready' }],
};

describe('validateWorkflowDefinition', () => {
  it('accepts one entry and explicit transitions to valid stages', () => {
    expect(validateWorkflowDefinition(valid)).toEqual([]);
  });

  it('rejects duplicate stage keys', () => {
    expect(
      validateWorkflowDefinition({
        ...valid,
        stages: [
          valid.stages[0]!,
          { ...valid.stages[1]!, key: 'draft', isEntry: false },
        ],
      }),
    ).toEqual(expect.arrayContaining(['Duplicate stage key: draft.']));
  });

  it('requires exactly one entry stage', () => {
    expect(
      validateWorkflowDefinition({
        ...valid,
        stages: valid.stages.map((item) => ({ ...item, isEntry: false })),
      }),
    ).toContain('A workflow must have exactly one entry stage.');
    expect(
      validateWorkflowDefinition({
        ...valid,
        stages: valid.stages.map((item) => ({ ...item, isEntry: true })),
      }),
    ).toContain('A workflow must have exactly one entry stage.');
  });

  it('rejects an entry terminal and a non-terminal dead end', () => {
    expect(
      validateWorkflowDefinition({
        ...valid,
        stages: valid.stages.map((item) =>
          item.key === 'draft' ? { ...item, isTerminal: true } : item,
        ),
      }),
    ).toContain('The entry stage cannot be terminal.');
    expect(
      validateWorkflowDefinition({
        ...valid,
        transitions: [],
      }),
    ).toContain('Non-terminal stage draft requires an outgoing transition.');
  });

  it('rejects missing transition endpoints and outgoing transitions from terminal stages', () => {
    expect(
      validateWorkflowDefinition({
        ...valid,
        transitions: [
          ...valid.transitions,
          { key: 'loop', label: 'Loop', from: 'ready', to: 'missing' },
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        'Transition loop references an unknown stage.',
        'Terminal stage ready cannot have outgoing transitions.',
      ]),
    );
  });

  it('rejects duplicate stage order and duplicate outgoing transition keys', () => {
    expect(
      validateWorkflowDefinition({
        ...valid,
        stages: valid.stages.map((stage) => ({ ...stage, displayOrder: 0 })),
        transitions: [
          valid.transitions[0]!,
          { ...valid.transitions[0]!, label: 'Submit again' },
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        'Duplicate stage order: 0.',
        'Duplicate transition: submit.',
      ]),
    );
  });

  it('requires one explicit reviewer assignment and a tagged review transition', () => {
    const reviewDefinition: WorkflowDefinitionInput = {
      name: 'Review workflow',
      stages: [
        {
          key: 'review',
          name: 'Review',
          displayOrder: 0,
          isEntry: true,
          requiresReview: true,
          assignedUserId: 'reviewer-1',
        },
        {
          key: 'approved',
          name: 'Approved',
          displayOrder: 1,
          isTerminal: true,
        },
        {
          key: 'changes',
          name: 'Changes requested',
          displayOrder: 2,
          isTerminal: true,
        },
      ],
      transitions: [
        {
          key: 'approve',
          label: 'Approve',
          from: 'review',
          to: 'approved',
          reviewDecision: 'APPROVED',
        },
        {
          key: 'request',
          label: 'Request changes',
          from: 'review',
          to: 'changes',
          reviewDecision: 'CHANGES_REQUESTED',
        },
      ],
    };
    expect(validateWorkflowDefinition(reviewDefinition)).toEqual([]);
    expect(
      validateWorkflowDefinition({
        ...reviewDefinition,
        stages: [
          {
            ...reviewDefinition.stages[0]!,
            assignedUserId: null,
            assignedPermission: null,
          },
          ...reviewDefinition.stages.slice(1),
        ],
      }),
    ).toContain(
      'Review stage review requires exactly one reviewer assignment.',
    );
    expect(
      validateWorkflowDefinition({
        ...reviewDefinition,
        stages: [
          {
            ...reviewDefinition.stages[0]!,
            assignedPermission: 'approvals:decide',
          },
          ...reviewDefinition.stages.slice(1),
        ],
      }),
    ).toContain(
      'Review stage review requires exactly one reviewer assignment.',
    );
  });

  describe('review decisions', () => {
    const reviewStage = {
      key: 'review',
      name: 'Review',
      displayOrder: 1,
      requiresReview: true,
      assignedPermission: 'approvals:decide',
    };
    const base: WorkflowDefinitionInput = {
      name: 'Two decisions',
      stages: [
        { key: 'draft', name: 'Draft', displayOrder: 0, isEntry: true },
        reviewStage,
        {
          key: 'approved',
          name: 'Approved',
          displayOrder: 2,
          isTerminal: true,
        },
        { key: 'changes', name: 'Changes', displayOrder: 3, isTerminal: true },
      ],
      transitions: [
        { key: 'submit', label: 'Submit', from: 'draft', to: 'review' },
        {
          key: 'approve',
          label: 'Approve',
          from: 'review',
          to: 'approved',
          reviewDecision: 'APPROVED',
        },
        {
          key: 'request',
          label: 'Request changes',
          from: 'review',
          to: 'changes',
          reviewDecision: 'CHANGES_REQUESTED',
        },
      ],
    };
    const without = (key: string) => ({
      ...base,
      transitions: base.transitions.filter((item) => item.key !== key),
    });

    it('accepts a review stage with exactly one approval and one changes-requested route', () => {
      expect(validateWorkflowDefinition(base)).toEqual([]);
    });

    it('rejects a review stage that can only request changes', () => {
      const errors = validateWorkflowDefinition({
        ...without('approve'),
        stages: base.stages.filter((stage) => stage.key !== 'approved'),
      });
      expect(errors).toEqual([
        'Review stage review requires one APPROVED transition.',
      ]);
    });

    it('rejects a review stage that can only approve', () => {
      const errors = validateWorkflowDefinition({
        ...without('request'),
        stages: base.stages.filter((stage) => stage.key !== 'changes'),
      });
      expect(errors).toEqual([
        'Review stage review requires one CHANGES_REQUESTED transition.',
      ]);
    });

    it('reports both missing decisions for a review stage with untagged routes only', () => {
      const errors = validateWorkflowDefinition({
        ...base,
        transitions: [
          base.transitions[0]!,
          { key: 'next', label: 'Next', from: 'review', to: 'approved' },
        ],
        stages: base.stages.filter((stage) => stage.key !== 'changes'),
      });
      expect(errors).toEqual(
        expect.arrayContaining([
          'Review stage review requires one APPROVED transition.',
          'Review stage review requires one CHANGES_REQUESTED transition.',
          'Every transition from review stage review must declare a review decision.',
        ]),
      );
    });

    it('still rejects two transitions for the same decision', () => {
      expect(
        validateWorkflowDefinition({
          ...base,
          transitions: [
            ...base.transitions,
            {
              key: 'approve-again',
              label: 'Approve again',
              from: 'review',
              to: 'approved',
              reviewDecision: 'APPROVED',
            },
          ],
        }),
      ).toContain('Review stage review has multiple APPROVED transitions.');
    });

    it('rejects a review stage that transitions to itself', () => {
      expect(
        validateWorkflowDefinition({
          ...base,
          transitions: base.transitions.map((item) =>
            item.key === 'approve' ? { ...item, to: 'review' } : item,
          ),
          stages: base.stages.filter((stage) => stage.key !== 'approved'),
        }),
      ).toContain(
        'Review stage review cannot transition to itself; a decision must move the run to another stage.',
      );
    });

    it('accepts an entry stage that is itself the review stage', () => {
      expect(
        validateWorkflowDefinition({
          ...base,
          stages: [
            { ...reviewStage, displayOrder: 0, isEntry: true },
            ...base.stages.slice(2),
          ],
          transitions: base.transitions.slice(1),
        }),
      ).toEqual([]);
    });

    it('accepts several review stages, each with its own two decisions, and several terminal stages', () => {
      expect(
        validateWorkflowDefinition({
          ...base,
          stages: [
            ...base.stages,
            {
              key: 'legal',
              name: 'Legal',
              displayOrder: 4,
              requiresReview: true,
              assignedPermission: 'approvals:decide',
            },
            {
              key: 'rejected',
              name: 'Rejected',
              displayOrder: 5,
              isTerminal: true,
            },
          ],
          transitions: [
            base.transitions[0]!,
            {
              key: 'approve',
              label: 'Approve',
              from: 'review',
              to: 'legal',
              reviewDecision: 'APPROVED',
            },
            base.transitions[2]!,
            {
              key: 'legal-approve',
              label: 'Approve',
              from: 'legal',
              to: 'approved',
              reviewDecision: 'APPROVED',
            },
            {
              key: 'legal-request',
              label: 'Request changes',
              from: 'legal',
              to: 'rejected',
              reviewDecision: 'CHANGES_REQUESTED',
            },
          ],
        }),
      ).toEqual([]);
    });
  });

  describe('reachability', () => {
    const stage = (key: string, displayOrder: number, extra = {}) => ({
      key,
      name: key,
      displayOrder,
      ...extra,
    });

    it('rejects a stage that cannot be reached from the entry', () => {
      expect(
        validateWorkflowDefinition({
          ...valid,
          stages: [
            ...valid.stages,
            stage('orphan', 2),
            stage('archived', 3, { isTerminal: true }),
          ],
          transitions: [
            ...valid.transitions,
            {
              key: 'archive',
              label: 'Archive',
              from: 'orphan',
              to: 'archived',
            },
          ],
        }),
      ).toEqual([
        'Stage orphan is unreachable from the entry stage draft.',
        'Stage archived is unreachable from the entry stage draft.',
      ]);
    });

    it('rejects an unreachable terminal stage', () => {
      expect(
        validateWorkflowDefinition({
          ...valid,
          stages: [...valid.stages, stage('spare', 2, { isTerminal: true })],
        }),
      ).toEqual(['Stage spare is unreachable from the entry stage draft.']);
    });

    it('rejects a cycle of non-review stages with no way to a terminal stage', () => {
      expect(
        validateWorkflowDefinition({
          ...valid,
          stages: [...valid.stages, stage('a', 2), stage('b', 3)],
          transitions: [
            ...valid.transitions,
            { key: 'to-a', label: 'To A', from: 'draft', to: 'a' },
            { key: 'a-b', label: 'A to B', from: 'a', to: 'b' },
            { key: 'b-a', label: 'B to A', from: 'b', to: 'a' },
          ],
        }),
      ).toEqual([
        'Stage a cannot reach a terminal stage, so a run there could never finish.',
        'Stage b cannot reach a terminal stage, so a run there could never finish.',
      ]);
    });

    it('rejects a non-review stage whose only transition is a self-loop', () => {
      expect(
        validateWorkflowDefinition({
          ...valid,
          stages: [...valid.stages, stage('hold', 2)],
          transitions: [
            ...valid.transitions,
            { key: 'hold', label: 'Hold', from: 'draft', to: 'hold' },
            { key: 'wait', label: 'Wait', from: 'hold', to: 'hold' },
          ],
        }),
      ).toEqual([
        'Stage hold cannot reach a terminal stage, so a run there could never finish.',
      ]);
    });

    it('accepts a non-review self-loop that also has a way out', () => {
      expect(
        validateWorkflowDefinition({
          ...valid,
          stages: [...valid.stages, stage('hold', 2)],
          transitions: [
            ...valid.transitions,
            { key: 'hold', label: 'Hold', from: 'draft', to: 'hold' },
            { key: 'wait', label: 'Wait', from: 'hold', to: 'hold' },
            { key: 'release', label: 'Release', from: 'hold', to: 'ready' },
          ],
        }),
      ).toEqual([]);
    });

    it('accepts several terminal stages reached on different routes', () => {
      expect(
        validateWorkflowDefinition({
          ...valid,
          stages: [...valid.stages, stage('dropped', 2, { isTerminal: true })],
          transitions: [
            ...valid.transitions,
            { key: 'drop', label: 'Drop', from: 'draft', to: 'dropped' },
          ],
        }),
      ).toEqual([]);
    });

    it('does not repeat the dead-end error as a reachability error', () => {
      expect(
        validateWorkflowDefinition({
          ...valid,
          stages: [...valid.stages, stage('stuck', 2)],
          transitions: [
            ...valid.transitions,
            { key: 'stick', label: 'Stick', from: 'draft', to: 'stuck' },
          ],
        }),
      ).toEqual(['Non-terminal stage stuck requires an outgoing transition.']);
    });
  });

  describe('changes-requested routes', () => {
    const review = (
      stages: WorkflowDefinitionInput['stages'],
      transitions: WorkflowDefinitionInput['transitions'],
    ): WorkflowDefinitionInput => ({
      name: 'Review flow',
      stages: [
        {
          key: 'review',
          name: 'Review',
          displayOrder: 0,
          isEntry: true,
          requiresReview: true,
          assignedPermission: 'approvals:decide',
        },
        {
          key: 'approved',
          name: 'Approved',
          displayOrder: 1,
          isTerminal: true,
        },
        ...stages,
      ],
      transitions: [
        {
          key: 'approve',
          label: 'Approve',
          from: 'review',
          to: 'approved',
          reviewDecision: 'APPROVED',
        },
        ...transitions,
      ],
    });
    const lockedMessage = (key: string, stage: string) =>
      `Changes-requested transition ${key} leads to stage ${stage}, which cannot reach a terminal stage without another review. ` +
      'Creatives cannot be revised while a run is active, so this would leave the creative locked; route it to a terminal stage or to stages that lead to one.';

    it('accepts changes requested that end the run', () => {
      expect(
        validateWorkflowDefinition(
          review(
            [
              {
                key: 'changes',
                name: 'Changes requested',
                displayOrder: 2,
                isTerminal: true,
              },
            ],
            [
              {
                key: 'request',
                label: 'Request changes',
                from: 'review',
                to: 'changes',
                reviewDecision: 'CHANGES_REQUESTED',
              },
            ],
          ),
        ),
      ).toEqual([]);
    });

    it('accepts changes requested that reach a terminal stage through non-review stages', () => {
      expect(
        validateWorkflowDefinition(
          review(
            [
              { key: 'triage', name: 'Triage', displayOrder: 2 },
              {
                key: 'closed',
                name: 'Closed',
                displayOrder: 3,
                isTerminal: true,
              },
            ],
            [
              {
                key: 'request',
                label: 'Request changes',
                from: 'review',
                to: 'triage',
                reviewDecision: 'CHANGES_REQUESTED',
              },
              { key: 'close', label: 'Close', from: 'triage', to: 'closed' },
            ],
          ),
        ),
      ).toEqual([]);
    });

    it('rejects a rework stage whose only way out is another review', () => {
      expect(
        validateWorkflowDefinition({
          ...review(
            [{ key: 'rework', name: 'Rework', displayOrder: 2 }],
            [
              {
                key: 'request',
                label: 'Request changes',
                from: 'review',
                to: 'rework',
                reviewDecision: 'CHANGES_REQUESTED',
              },
            ],
          ),
          // The review stage cannot be the entry when rework re-enters it.
          stages: [
            { key: 'draft', name: 'Draft', displayOrder: 3, isEntry: true },
            {
              key: 'review',
              name: 'Review',
              displayOrder: 0,
              requiresReview: true,
              assignedPermission: 'approvals:decide',
            },
            {
              key: 'approved',
              name: 'Approved',
              displayOrder: 1,
              isTerminal: true,
            },
            { key: 'rework', name: 'Rework', displayOrder: 2 },
          ],
          transitions: [
            { key: 'submit', label: 'Submit', from: 'draft', to: 'review' },
            {
              key: 'approve',
              label: 'Approve',
              from: 'review',
              to: 'approved',
              reviewDecision: 'APPROVED',
            },
            {
              key: 'request',
              label: 'Request changes',
              from: 'review',
              to: 'rework',
              reviewDecision: 'CHANGES_REQUESTED',
            },
            {
              key: 'resubmit',
              label: 'Resubmit',
              from: 'rework',
              to: 'review',
            },
          ],
        }),
      ).toEqual([lockedMessage('request', 'rework')]);
    });

    it('rejects changes requested that lead into another review stage', () => {
      expect(
        validateWorkflowDefinition(
          review(
            [
              {
                key: 'second',
                name: 'Second review',
                displayOrder: 2,
                requiresReview: true,
                assignedPermission: 'approvals:decide',
              },
            ],
            [
              {
                key: 'request',
                label: 'Request changes',
                from: 'review',
                to: 'second',
                reviewDecision: 'CHANGES_REQUESTED',
              },
              {
                key: 'second-approve',
                label: 'Approve',
                from: 'second',
                to: 'approved',
                reviewDecision: 'APPROVED',
              },
            ],
          ),
        ),
      ).toContain(lockedMessage('request', 'second'));
    });

    it('ignores approval routes, which may continue to further reviews', () => {
      const errors = validateWorkflowDefinition(
        review(
          [
            {
              key: 'changes',
              name: 'Changes requested',
              displayOrder: 2,
              isTerminal: true,
            },
          ],
          [
            {
              key: 'request',
              label: 'Request changes',
              from: 'review',
              to: 'changes',
              reviewDecision: 'CHANGES_REQUESTED',
            },
          ],
        ),
      );
      expect(errors.some((error) => error.includes('Changes-requested'))).toBe(
        false,
      );
    });
  });
});
