// The structured workflow editor (Phase 3.5). It edits the same definition
// text as the Advanced JSON view: every change is written back as JSON, so
// unsaved-edit tracking, Discard changes, Validate and saving all work as
// before. Values the form does not change (unknown permission codes,
// reviewer IDs, keys) are kept exactly.
import { useId, useState } from 'react';
import {
  addStage,
  addTransition,
  checkDefinition,
  connectedTransitions,
  isKnownPermission,
  makeEntry,
  moveStage,
  orderedStages,
  parseDefinition,
  PERMISSION_CHOICES,
  permissionLabel,
  removeStage,
  removeTransition,
  serializeDefinition,
  updateStage,
  updateTransition,
  type DefinitionProblem,
  type DefinitionStage,
  type DefinitionTransition,
  type ReviewDecision,
  type WorkflowDefinition,
} from './workflowModel';
import { returnFocusToConfirmTrigger } from './confirmFocus';

export type AssignableUser = { id: string; name: string; email: string };
export type AssignableUsers =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'loaded'; users: AssignableUser[] };

// A permission picker that keeps a code it does not know.
function PermissionSelect({
  label,
  value,
  noneLabel,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null | undefined;
  noneLabel?: string;
  disabled?: boolean;
  onChange: (code: string | null) => void;
}) {
  const current = value ?? '';
  return (
    <label>
      {label}
      <select
        aria-label={label}
        value={current}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      >
        {noneLabel !== undefined && <option value="">{noneLabel}</option>}
        {current && !isKnownPermission(current) && (
          <option value={current}>
            {permissionLabel(current)} (kept as saved)
          </option>
        )}
        {PERMISSION_CHOICES.map((choice) => (
          <option key={choice.code} value={choice.code}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const problemsFor = (
  problems: DefinitionProblem[],
  kind: 'stage' | 'transition',
  key: string,
) =>
  problems.filter(
    (problem) => problem.target.kind === kind && problem.target.key === key,
  );

function ProblemList({
  id,
  problems,
}: {
  id: string;
  problems: DefinitionProblem[];
}) {
  if (!problems.length) return null;
  return (
    <ul className="workflow-problems" id={id}>
      {problems.map((problem, index) => (
        <li key={index} className="form-message">
          {problem.message}
        </li>
      ))}
    </ul>
  );
}

export default function WorkflowStructuredEditor({
  text,
  onChange,
  users,
  onRetryUsers,
  busy,
}: {
  text: string;
  onChange: (text: string) => void;
  users: AssignableUsers;
  onRetryUsers: () => void;
  busy: boolean;
}) {
  const idPrefix = useId();
  const [newStageName, setNewStageName] = useState('');
  const [confirmingRemove, setConfirmingRemove] = useState('');
  // Stages where One person was chosen and nobody is picked yet.
  const [choosingPerson, setChoosingPerson] = useState<Set<string>>(
    () => new Set(),
  );
  const choosePerson = (key: string, on: boolean) =>
    setChoosingPerson((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const parsed = parseDefinition(text);
  if (!parsed.ok)
    return (
      <div className="workflow-editor">
        <p className="empty-state">
          {parsed.reason} The form can show the definition again once the
          Advanced (JSON) view below holds a definition it can read; your text
          is kept there.
        </p>
      </div>
    );
  const definition = parsed.definition;
  const problems = checkDefinition(definition);
  const workflowProblems = problems.filter(
    (problem) => problem.target.kind === 'workflow',
  );
  const stages = orderedStages(definition);
  const write = (next: WorkflowDefinition) =>
    onChange(serializeDefinition(next));
  const id = (...parts: string[]) => [idPrefix, ...parts].join('-');

  function reviewerControls(stage: DefinitionStage) {
    const mode = stage.assignedUserId
      ? 'person'
      : stage.assignedPermission
        ? 'permission'
        : choosingPerson.has(stage.key)
          ? 'person'
          : 'anyone';
    const known =
      users.status === 'loaded'
        ? users.users.find((user) => user.id === stage.assignedUserId)
        : undefined;
    const groupName = id('reviewer', stage.key);
    return (
      <fieldset className="workflow-reviewer">
        <legend>
          {stage.requiresReview
            ? 'Who reviews this stage'
            : 'Who acts at this stage'}
        </legend>
        {!stage.requiresReview && (
          <label className="checkbox-label">
            <input
              type="radio"
              name={groupName}
              checked={mode === 'anyone'}
              onChange={() => {
                choosePerson(stage.key, false);
                write(
                  updateStage(definition, stage.key, {
                    assignedUserId: null,
                    assignedPermission: null,
                  }),
                );
              }}
            />{' '}
            Anyone allowed to take its steps
          </label>
        )}
        <label className="checkbox-label">
          <input
            type="radio"
            name={groupName}
            checked={mode === 'person'}
            onChange={() => {
              choosePerson(stage.key, true);
              write(
                updateStage(definition, stage.key, {
                  assignedPermission: null,
                  // Nobody is picked for the user; they choose.
                  assignedUserId: null,
                }),
              );
            }}
          />{' '}
          One person
        </label>
        <label className="checkbox-label">
          <input
            type="radio"
            name={groupName}
            checked={mode === 'permission'}
            onChange={() => {
              choosePerson(stage.key, false);
              write(
                updateStage(definition, stage.key, {
                  assignedUserId: null,
                  assignedPermission: 'approvals:decide',
                }),
              );
            }}
          />{' '}
          Everyone with a permission
        </label>
        {mode === 'person' && (
          <>
            <label>
              Person
              <select
                aria-label={'Person for ' + (stage.name || stage.key)}
                value={stage.assignedUserId ?? ''}
                onChange={(event) =>
                  write(
                    updateStage(definition, stage.key, {
                      assignedUserId: event.target.value || null,
                    }),
                  )
                }
              >
                {!stage.assignedUserId && (
                  <option value="">Choose a person</option>
                )}
                {/* The saved reviewer is always kept and shown, even when
                    they cannot be listed. */}
                {!known && stage.assignedUserId && (
                  <option value={stage.assignedUserId}>
                    {users.status === 'loaded'
                      ? 'Unavailable person (not an active user)'
                      : users.status === 'loading'
                        ? 'Loading people…'
                        : 'Saved person (people could not be loaded)'}
                  </option>
                )}
                {users.status === 'loaded' &&
                  users.users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name} · {user.email}
                    </option>
                  ))}
              </select>
            </label>
            {users.status === 'loaded' && !known && stage.assignedUserId && (
              <p className="form-message">
                The saved reviewer is not an active user of this organization,
                so the API will refuse to save this definition until another
                person is chosen. They have been kept, not replaced.
              </p>
            )}
            {users.status === 'failed' && (
              <div className="inline-actions">
                <p className="form-message">
                  People couldn&apos;t be loaded; the saved reviewer is kept.
                </p>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={onRetryUsers}
                >
                  Try again
                </button>
              </div>
            )}
            <p className="field-hint">
              A named person must also have access to each branch this workflow
              is used in (Administration → User branch access). The editor
              cannot check this; without that access a run refuses to start or
              move into this stage.
            </p>
          </>
        )}
        {mode === 'permission' && (
          <PermissionSelect
            label={'Reviewer permission for ' + (stage.name || stage.key)}
            value={stage.assignedPermission}
            onChange={(code) =>
              write(
                updateStage(definition, stage.key, {
                  assignedPermission: code,
                }),
              )
            }
          />
        )}
      </fieldset>
    );
  }

  function transitionRow(
    transition: DefinitionTransition,
    stage: DefinitionStage,
  ) {
    const rowProblems = problemsFor(problems, 'transition', transition.key);
    const problemId = id('t-problems', transition.key);
    const label = transition.label || transition.key;
    const decisionShown = stage.requiresReview || !!transition.reviewDecision;
    return (
      <li key={transition.key} className="workflow-transition">
        <label>
          Step label
          <input
            aria-label={'Label of step ' + label}
            aria-describedby={rowProblems.length ? problemId : undefined}
            aria-invalid={rowProblems.length ? true : undefined}
            maxLength={120}
            value={transition.label}
            onChange={(event) =>
              write(
                updateTransition(definition, transition.key, {
                  label: event.target.value,
                }),
              )
            }
          />
        </label>
        <label>
          Goes to
          <select
            aria-label={'Destination of step ' + label}
            value={transition.to}
            onChange={(event) =>
              write(
                updateTransition(definition, transition.key, {
                  to: event.target.value,
                }),
              )
            }
          >
            {!definition.stages.some((item) => item.key === transition.to) && (
              <option value={transition.to}>
                Missing stage ({transition.to})
              </option>
            )}
            {stages.map((item) => (
              <option key={item.key} value={item.key}>
                {item.name || item.key}
              </option>
            ))}
          </select>
        </label>
        {decisionShown && (
          <label>
            Review decision
            <select
              aria-label={'Review decision of step ' + label}
              value={transition.reviewDecision ?? ''}
              onChange={(event) =>
                write(
                  updateTransition(definition, transition.key, {
                    reviewDecision: (event.target.value ||
                      null) as ReviewDecision | null,
                  }),
                )
              }
            >
              <option value="">None</option>
              <option value="APPROVED">Reviewer approves</option>
              <option value="CHANGES_REQUESTED">
                Reviewer requests changes
              </option>
            </select>
          </label>
        )}
        <PermissionSelect
          label={'Permission for step ' + label}
          value={transition.requiredPermission}
          noneLabel="No extra permission"
          onChange={(code) =>
            write(
              updateTransition(definition, transition.key, {
                requiredPermission: code,
              }),
            )
          }
        />
        <p className="field-hint">Key: {transition.key}</p>
        <button
          type="button"
          className="secondary-button"
          aria-label={'Remove step ' + label}
          onClick={() => write(removeTransition(definition, transition.key))}
        >
          Remove step
        </button>
        <ProblemList id={problemId} problems={rowProblems} />
      </li>
    );
  }

  function stageCard(stage: DefinitionStage, index: number) {
    const name = stage.name || stage.key;
    const stageProblems = problemsFor(problems, 'stage', stage.key);
    const problemId = id('s-problems', stage.key);
    const outgoing = definition.transitions.filter(
      (transition) => transition.from === stage.key,
    );
    const others = stages.filter((item) => item.key !== stage.key);
    const missingDecisions = stage.requiresReview
      ? (['APPROVED', 'CHANGES_REQUESTED'] as const).filter(
          (decision) =>
            !outgoing.some(
              (transition) => transition.reviewDecision === decision,
            ),
        )
      : [];
    const connected = connectedTransitions(definition, stage.key).length;
    return (
      <li
        key={stage.key}
        className="workflow-stage"
        aria-label={'Stage ' + name}
        aria-describedby={stageProblems.length ? problemId : undefined}
      >
        <div className="workflow-stage-heading">
          <strong>
            {index + 1}. {name}
          </strong>
          <span className="field-hint">
            {[
              stage.isEntry && 'Starting stage',
              stage.requiresReview && 'Review',
              stage.isTerminal && 'Finishing stage',
            ]
              .filter(Boolean)
              .join(' · ') || 'Step'}{' '}
            · Key: {stage.key}
          </span>
        </div>
        <label>
          Stage name
          <input
            aria-label={'Name of stage ' + name}
            maxLength={120}
            value={stage.name}
            onChange={(event) =>
              write(
                updateStage(definition, stage.key, {
                  name: event.target.value,
                }),
              )
            }
          />
        </label>
        <div className="workflow-stage-flags">
          {stage.isEntry ? (
            <span className="badge badge-info">Starting stage</span>
          ) : (
            <button
              type="button"
              className="secondary-button"
              onClick={() => write(makeEntry(definition, stage.key))}
            >
              Make this the starting stage
            </button>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={!!stage.isTerminal}
              onChange={(event) =>
                write(
                  updateStage(definition, stage.key, {
                    isTerminal: event.target.checked,
                  }),
                )
              }
            />{' '}
            Finishing stage (the run ends here)
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={!!stage.requiresReview}
              onChange={(event) =>
                write(
                  updateStage(definition, stage.key, {
                    requiresReview: event.target.checked,
                  }),
                )
              }
            />{' '}
            Needs a review decision
          </label>
        </div>
        {reviewerControls(stage)}
        <PermissionSelect
          label={'Permission to act at ' + name}
          value={stage.requiredPermission}
          noneLabel="No extra permission"
          onChange={(code) =>
            write(
              updateStage(definition, stage.key, { requiredPermission: code }),
            )
          }
        />
        <ProblemList id={problemId} problems={stageProblems} />
        <h5>Steps out of {name}</h5>
        {outgoing.length ? (
          <ul className="workflow-transitions">
            {outgoing.map((transition) => transitionRow(transition, stage))}
          </ul>
        ) : (
          <p className="empty-state">
            {stage.isTerminal
              ? 'None: the run finishes here.'
              : 'No steps yet.'}
          </p>
        )}
        <div className="template-actions">
          {!stage.isTerminal && others.length > 0 && (
            <button
              type="button"
              className="secondary-button"
              aria-label={'Add a step out of ' + name}
              onClick={() =>
                write(
                  addTransition(
                    definition,
                    stage.key,
                    stage.requiresReview ? 'Approve' : 'Move on',
                    others[0]!.key,
                    stage.requiresReview && missingDecisions[0]
                      ? missingDecisions[0]
                      : null,
                  ),
                )
              }
            >
              Add step
            </button>
          )}
          {missingDecisions.length > 0 && others.length > 0 && (
            <button
              type="button"
              className="secondary-button"
              aria-label={'Add the missing review steps for ' + name}
              onClick={() => {
                let next = definition;
                for (const decision of missingDecisions)
                  next = addTransition(
                    next,
                    stage.key,
                    decision === 'APPROVED' ? 'Approve' : 'Request changes',
                    others[0]!.key,
                    decision,
                  );
                write(next);
              }}
            >
              Add the missing review steps
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            aria-label={'Move ' + name + ' up'}
            disabled={index === 0}
            onClick={() => write(moveStage(definition, stage.key, -1))}
          >
            Move up
          </button>
          <button
            type="button"
            className="secondary-button"
            aria-label={'Move ' + name + ' down'}
            disabled={index === stages.length - 1}
            onClick={() => write(moveStage(definition, stage.key, 1))}
          >
            Move down
          </button>
          <button
            type="button"
            className="danger-button"
            aria-label={'Remove stage ' + name}
            aria-expanded={confirmingRemove === stage.key}
            onClick={() => setConfirmingRemove(stage.key)}
          >
            Remove stage
          </button>
        </div>
        {confirmingRemove === stage.key && (
          <div
            className="confirm-panel"
            role="group"
            aria-label={'Confirm removing ' + name}
          >
            <p>
              Remove {name} from this definition?
              {connected
                ? ` This also removes ${connected === 1 ? 'the 1 step' : `the ${connected} steps`} into or out of it.`
                : ''}{' '}
              Nothing is saved until you save a new version, and Discard changes
              brings it back.
            </p>
            <div className="template-actions">
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  setConfirmingRemove('');
                  write(removeStage(definition, stage.key));
                }}
              >
                Remove stage and its steps
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={(event) => {
                  returnFocusToConfirmTrigger(event.currentTarget);
                  setConfirmingRemove('');
                }}
              >
                Keep stage
              </button>
            </div>
          </div>
        )}
      </li>
    );
  }

  return (
    <div className="workflow-editor" aria-busy={busy}>
      <label>
        Workflow name
        <input
          maxLength={120}
          value={definition.name}
          onChange={(event) =>
            write({ ...definition, name: event.target.value })
          }
        />
      </label>
      <label>
        Description (optional)
        <textarea
          rows={2}
          maxLength={2000}
          value={definition.description ?? ''}
          onChange={(event) =>
            write({ ...definition, description: event.target.value || null })
          }
        />
      </label>
      <ProblemList id={id('w-problems')} problems={workflowProblems} />
      <h4>Stages, in the order they are shown</h4>
      {stages.length ? (
        <ol className="workflow-stages">{stages.map(stageCard)}</ol>
      ) : (
        <p className="empty-state">No stages yet. Add the first one below.</p>
      )}
      <form
        className="inline-actions workflow-add-stage"
        aria-label="Add a stage"
        onSubmit={(event) => {
          event.preventDefault();
          if (!newStageName.trim()) return;
          write(addStage(definition, newStageName).definition);
          setNewStageName('');
        }}
      >
        <label>
          New stage name
          <input
            maxLength={120}
            value={newStageName}
            onChange={(event) => setNewStageName(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="secondary-button"
          disabled={!newStageName.trim()}
        >
          Add stage
        </button>
      </form>
      <p
        className={problems.length ? 'form-message' : 'field-hint'}
        aria-live="polite"
      >
        {problems.length
          ? `${problems.length === 1 ? '1 problem' : `${problems.length} problems`} shown above would stop the API from saving this definition.`
          : 'No problems found in the form. The API checks the definition again when you save.'}
      </p>
    </div>
  );
}
