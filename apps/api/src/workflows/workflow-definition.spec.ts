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
      ],
      transitions: [
        {
          key: 'approve',
          label: 'Approve',
          from: 'review',
          to: 'approved',
          reviewDecision: 'APPROVED',
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
          reviewDefinition.stages[1]!,
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
          reviewDefinition.stages[1]!,
        ],
      }),
    ).toContain(
      'Review stage review requires exactly one reviewer assignment.',
    );
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
