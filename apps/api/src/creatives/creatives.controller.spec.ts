import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { CreativesService } from './creatives.service';
import { CreativesController } from './creatives.controller';

const user: AuthenticatedPrincipal = {
  id: 'user-1',
  sessionId: 'session-1',
  organizationId: 'org-1',
  name: 'Branch user',
  email: 'branch@example.local',
  branches: [],
  permissions: ['creatives:create', 'creatives:update'],
};
const validBody = {
  name: 'Spring sale',
  branchId: 'branch-1',
  templateVersionId: 'version-1',
  values: { headline: 'Sale' },
};

describe('CreativesController validation', () => {
  it('rejects missing or whitespace-only names before reaching the service', () => {
    const service = { create: vi.fn(), update: vi.fn() };
    const controller = new CreativesController(
      service as unknown as CreativesService,
    );
    for (const body of [
      { ...validBody, name: undefined },
      { ...validBody, name: '' },
      { ...validBody, name: '   ' },
    ])
      expect(() => controller.create(user, body)).toThrow(BadRequestException);
    expect(() =>
      controller.update(user, 'creative-1', { name: ' \t ' }),
    ).toThrow(BadRequestException);
    expect(service.create).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  it('trims a valid name before passing it to the service', () => {
    const service = { create: vi.fn().mockResolvedValue({ id: 'creative-1' }) };
    const controller = new CreativesController(
      service as unknown as CreativesService,
    );
    void controller.create(user, { ...validBody, name: '  Spring sale  ' });
    expect(service.create).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ name: 'Spring sale' }),
    );
  });
});
