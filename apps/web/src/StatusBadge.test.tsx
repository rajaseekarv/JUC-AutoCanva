import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import StatusBadge from './StatusBadge';

afterEach(cleanup);

describe('StatusBadge', () => {
  it('shows the friendly label, not the raw API value', () => {
    render(<StatusBadge status="IN_PROGRESS" />);
    expect(screen.getByText('In progress')).toHaveClass('badge', 'badge-info');
    expect(screen.queryByText('IN_PROGRESS')).toBeNull();
  });

  it('uses a neutral tone for an unrecognized stage key', () => {
    render(<StatusBadge status="IN_REVIEW" />);
    expect(screen.getByText('In review')).toHaveClass('badge-neutral');
  });
});
