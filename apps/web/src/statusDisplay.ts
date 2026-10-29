// Display-only mapping from API status values to plain-language labels. The
// API values themselves are never changed or sent back from here.
export type StatusTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

const knownStatuses: Record<string, { label: string; tone: StatusTone }> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  INACTIVE: { label: 'Inactive', tone: 'neutral' },
  DRAFT: { label: 'Draft', tone: 'neutral' },
  ARCHIVED: { label: 'Archived', tone: 'neutral' },
  ENABLED: { label: 'Enabled', tone: 'success' },
  DISABLED: { label: 'Disabled', tone: 'neutral' },
  RUNNING: { label: 'In progress', tone: 'info' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  ASSIGNED: { label: 'Assigned', tone: 'info' },
  OPEN: { label: 'Open', tone: 'info' },
  IN_PROGRESS: { label: 'In progress', tone: 'info' },
  RESOLVED: { label: 'Resolved', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  STALE: { label: 'Stale', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'success' },
  CHANGES_REQUESTED: { label: 'Changes requested', tone: 'warning' },
};

// Creative statuses mirror configurable workflow stage keys, so unknown
// values fall back to sentence case ("IN_REVIEW" becomes "In review").
function sentenceCase(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : value;
}

export function statusLabel(value: string): string {
  return knownStatuses[value]?.label ?? sentenceCase(value);
}

export function statusTone(value: string): StatusTone {
  return knownStatuses[value]?.tone ?? 'neutral';
}
