import { describe, expect, it } from 'vitest';
import { statusLabel, statusTone } from './statusDisplay';

describe('statusLabel', () => {
  it.each([
    ['ACTIVE', 'Active'],
    ['DRAFT', 'Draft'],
    ['ARCHIVED', 'Archived'],
    ['RUNNING', 'In progress'],
    ['IN_PROGRESS', 'In progress'],
    ['COMPLETED', 'Completed'],
    ['OPEN', 'Open'],
    ['RESOLVED', 'Resolved'],
    ['CANCELLED', 'Cancelled'],
    ['APPROVED', 'Approved'],
    ['CHANGES_REQUESTED', 'Changes requested'],
  ])('labels %s as %s', (value, label) => {
    expect(statusLabel(value)).toBe(label);
  });

  it('falls back to sentence case for configurable stage keys', () => {
    expect(statusLabel('IN_REVIEW')).toBe('In review');
    expect(statusLabel('ready-to-publish')).toBe('Ready to publish');
  });

  it('keeps an empty value unchanged', () => {
    expect(statusLabel('')).toBe('');
  });
});

describe('statusTone', () => {
  it('gives known outcomes a matching tone and unknown values a neutral one', () => {
    expect(statusTone('ACTIVE')).toBe('success');
    expect(statusTone('CHANGES_REQUESTED')).toBe('warning');
    expect(statusTone('RUNNING')).toBe('info');
    expect(statusTone('IN_REVIEW')).toBe('neutral');
  });
});
