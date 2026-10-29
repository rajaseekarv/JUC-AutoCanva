import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { ApprovalsService } from './approvals.service';
import { ApprovalsController } from './approvals.controller';

const user: AuthenticatedPrincipal = {
  id: 'user-1',
  sessionId: 'session-1',
  organizationId: 'org-1',
  name: 'Reviewer',
  email: 'reviewer@example.local',
  branches: [],
  permissions: ['comments:create'],
};

describe('ApprovalsController validation', () => {
  it('rejects whitespace-only comments and client supplied reviewer identity', async () => {
    const service = { addComment: vi.fn() };
    const controller = new ApprovalsController(
      service as unknown as ApprovalsService,
    );
    expect(() =>
      controller.addComment(user, 'creative-1', 1, { text: '   ' }),
    ).toThrow(BadRequestException);
    expect(() =>
      controller.decide(user, 'task-1', {
        decision: 'APPROVED',
        reviewerId: 'attacker',
      }),
    ).toThrow(BadRequestException);
    expect(service.addComment).not.toHaveBeenCalled();
  });

  it('trims valid comment text before passing it to the service', async () => {
    const service = {
      addComment: vi.fn().mockResolvedValue({ id: 'comment-1' }),
    };
    const controller = new ApprovalsController(
      service as unknown as ApprovalsService,
    );
    await controller.addComment(user, 'creative-1', 2, {
      text: '  Review note  ',
    });
    expect(service.addComment).toHaveBeenCalledWith(
      user,
      'creative-1',
      2,
      'Review note',
      undefined,
    );
  });
});
