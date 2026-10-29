import 'dotenv/config';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';

config({ path: resolve(__dirname, '../../../.env') });

const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? '';
const branchUserPassword = process.env.SEED_BRANCH_USER_PASSWORD ?? '';
if (adminPassword.length < 12) {
  throw new Error(
    'SEED_ADMIN_PASSWORD must be set to a local password of at least 12 characters.',
  );
}
if (branchUserPassword.length < 12) {
  throw new Error(
    'SEED_BRANCH_USER_PASSWORD must be set to a local password of at least 12 characters.',
  );
}

const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? 'admin@example.local')
  .trim()
  .toLowerCase();
const branchUserEmail = (
  process.env.SEED_BRANCH_USER_EMAIL ?? 'branch@example.local'
)
  .trim()
  .toLowerCase();
if (adminEmail === branchUserEmail)
  throw new Error('Seed user emails must be different.');

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const organization = await prisma.organization.upsert({
    where: { code: 'ADFLOW-LOCAL' },
    update: { name: 'AdFlow Local Development' },
    create: { name: 'AdFlow Local Development', code: 'ADFLOW-LOCAL' },
  });
  await prisma.brandProfile.upsert({
    where: { organizationId: organization.id },
    update: {},
    create: {
      organizationId: organization.id,
      displayName: organization.name,
      primaryColor: '#202020',
      secondaryColor: '#ffffff',
      accentColor: '#2f6fed',
    },
  });
  const centralBranch = await prisma.branch.upsert({
    where: {
      organizationId_code: { organizationId: organization.id, code: 'CENTRAL' },
    },
    update: { name: 'Central Branch', status: 'ACTIVE' },
    create: {
      organizationId: organization.id,
      name: 'Central Branch',
      code: 'CENTRAL',
    },
  });
  const northBranch = await prisma.branch.upsert({
    where: {
      organizationId_code: { organizationId: organization.id, code: 'NORTH' },
    },
    update: { name: 'North Branch', status: 'ACTIVE' },
    create: {
      organizationId: organization.id,
      name: 'North Branch',
      code: 'NORTH',
    },
  });

  const [branchRead, branchManage, organizationUpdate, branchAccessManage] =
    await Promise.all([
      prisma.permission.upsert({
        where: { code: 'branches:read' },
        update: {
          description: 'Read branches explicitly assigned to the user.',
        },
        create: {
          code: 'branches:read',
          description: 'Read branches explicitly assigned to the user.',
        },
      }),
      prisma.permission.upsert({
        where: { code: 'branches:manage' },
        update: { description: 'Manage branch configuration.' },
        create: {
          code: 'branches:manage',
          description: 'Manage branch configuration.',
        },
      }),
      prisma.permission.upsert({
        where: { code: 'organizations:update' },
        update: { description: 'Update the organization profile.' },
        create: {
          code: 'organizations:update',
          description: 'Update the organization profile.',
        },
      }),
      prisma.permission.upsert({
        where: { code: 'users:branch-access:manage' },
        update: {
          description: 'Manage user branch access in the organization.',
        },
        create: {
          code: 'users:branch-access:manage',
          description: 'Manage user branch access in the organization.',
        },
      }),
    ]);

  const [brandRead, brandManage, assetRead, assetManage] = await Promise.all([
    prisma.permission.upsert({
      where: { code: 'brand:read' },
      update: { description: 'Read organization and branch brand profiles.' },
      create: {
        code: 'brand:read',
        description: 'Read organization and branch brand profiles.',
      },
    }),
    prisma.permission.upsert({
      where: { code: 'brand:manage' },
      update: { description: 'Manage organization and branch brand profiles.' },
      create: {
        code: 'brand:manage',
        description: 'Manage organization and branch brand profiles.',
      },
    }),
    prisma.permission.upsert({
      where: { code: 'assets:read' },
      update: { description: 'Read organization and permitted branch assets.' },
      create: {
        code: 'assets:read',
        description: 'Read organization and permitted branch assets.',
      },
    }),
    prisma.permission.upsert({
      where: { code: 'assets:manage' },
      update: {
        description:
          'Upload and manage organization and permitted branch assets.',
      },
      create: {
        code: 'assets:manage',
        description:
          'Upload and manage organization and permitted branch assets.',
      },
    }),
  ]);
  const [
    templateRead,
    templateCreate,
    templateEdit,
    templateActivate,
    templateArchive,
  ] = await Promise.all(
    [
      ['templates:read', 'Read organization templates.'],
      ['templates:create', 'Create organization templates.'],
      ['templates:edit', 'Edit draft template metadata and fields.'],
      ['templates:activate', 'Activate valid template versions.'],
      ['templates:archive', 'Archive templates.'],
    ].map(([code, description]) =>
      prisma.permission.upsert({
        where: { code: code as string },
        update: { description: description as string },
        create: { code: code as string, description: description as string },
      }),
    ),
  );
  const auditRead = await prisma.permission.upsert({
    where: { code: 'audit:read' },
    update: {
      description:
        'Read organization audit records within permitted branch scope.',
    },
    create: {
      code: 'audit:read',
      description:
        'Read organization audit records within permitted branch scope.',
    },
  });
  const [canvaIntegrationRead, canvaIntegrationManage, canvaJobCreate] =
    await Promise.all(
      [
        ['canva:integration:read', 'Read Canva integration status and jobs.'],
        [
          'canva:integration:manage',
          'Connect or disconnect the organization Canva provider.',
        ],
        [
          'canva:jobs:create',
          'Prepare Canva designs for authorized branch creatives.',
        ],
      ].map(([code, description]) =>
        prisma.permission.upsert({
          where: { code: code as string },
          update: { description: description as string },
          create: { code: code as string, description: description as string },
        }),
      ),
    );
  const [creativeRead, creativeCreate, creativeUpdate] = await Promise.all(
    [
      ['creatives:read', 'Read creatives for permitted branches.'],
      ['creatives:create', 'Create branch creatives.'],
      ['creatives:update', 'Create new revisions for branch creatives.'],
    ].map(([code, description]) =>
      prisma.permission.upsert({
        where: { code: code as string },
        update: { description: description as string },
        create: { code: code as string, description: description as string },
      }),
    ),
  );
  const [workflowRead, workflowManage, workflowStart, workflowTransition] =
    await Promise.all(
      [
        [
          'workflows:read',
          'Read organization workflow definitions and authorized branch instances.',
        ],
        ['workflows:manage', 'Create and configure organization workflows.'],
        ['workflows:start', 'Start workflows for authorized branch creatives.'],
        [
          'workflows:transition',
          'Request allowed transitions for authorized branch instances.',
        ],
      ].map(([code, description]) =>
        prisma.permission.upsert({
          where: { code: code as string },
          update: { description: description as string },
          create: { code: code as string, description: description as string },
        }),
      ),
    );
  const [
    approvalRead,
    approvalDecide,
    changeRequestRead,
    changeRequestCreate,
    changeRequestResolve,
    commentRead,
    commentCreate,
  ] = await Promise.all(
    [
      ['approvals:read', 'Read review assignments and decisions.'],
      ['approvals:decide', 'Decide assigned review tasks.'],
      ['change_requests:read', 'Read change requests for permitted branches.'],
      [
        'change_requests:create',
        'Create change requests through review decisions.',
      ],
      ['change_requests:resolve', 'Resolve or cancel change requests.'],
      ['comments:read', 'Read comments on permitted creative revisions.'],
      ['comments:create', 'Add comments to permitted creative revisions.'],
    ].map(([code, description]) =>
      prisma.permission.upsert({
        where: { code: code as string },
        update: { description: description as string },
        create: { code: code as string, description: description as string },
      }),
    ),
  );
  const adminRole = await prisma.role.upsert({
    where: {
      organizationId_name: {
        organizationId: organization.id,
        name: 'ORGANIZATION_ADMIN',
      },
    },
    update: { description: 'Local organization administrator.' },
    create: {
      organizationId: organization.id,
      name: 'ORGANIZATION_ADMIN',
      description: 'Local organization administrator.',
    },
  });
  const branchRole = await prisma.role.upsert({
    where: {
      organizationId_name: {
        organizationId: organization.id,
        name: 'BRANCH_OPERATOR',
      },
    },
    update: { description: 'Local branch-restricted operator.' },
    create: {
      organizationId: organization.id,
      name: 'BRANCH_OPERATOR',
      description: 'Local branch-restricted operator.',
    },
  });

  for (const permission of [
    branchRead,
    branchManage,
    organizationUpdate,
    branchAccessManage,
    brandRead,
    brandManage,
    assetRead,
    assetManage,
    templateRead,
    templateCreate,
    templateEdit,
    templateActivate,
    templateArchive,
    creativeRead,
    creativeCreate,
    creativeUpdate,
    workflowRead,
    workflowManage,
    workflowStart,
    workflowTransition,
    approvalRead,
    approvalDecide,
    changeRequestRead,
    changeRequestCreate,
    changeRequestResolve,
    commentRead,
    commentCreate,
    auditRead,
    canvaIntegrationRead,
    canvaIntegrationManage,
    canvaJobCreate,
  ]) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: adminRole.id,
          permissionId: permission.id,
        },
      },
      update: {},
      create: { roleId: adminRole.id, permissionId: permission.id },
    });
  }
  for (const permission of [
    branchRead,
    brandRead,
    assetRead,
    templateRead,
    creativeRead,
    creativeCreate,
    creativeUpdate,
    workflowRead,
    workflowStart,
    workflowTransition,
    approvalRead,
    approvalDecide,
    changeRequestRead,
    changeRequestCreate,
    commentRead,
    commentCreate,
    canvaIntegrationRead,
    canvaJobCreate,
  ]) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: branchRole.id,
          permissionId: permission.id,
        },
      },
      update: {},
      create: { roleId: branchRole.id, permissionId: permission.id },
    });
  }
  const [adminHash, branchUserHash] = await Promise.all([
    argon2.hash(adminPassword, { type: argon2.argon2id }),
    argon2.hash(branchUserPassword, { type: argon2.argon2id }),
  ]);
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      name: 'Local Admin',
      organizationId: organization.id,
      status: 'ACTIVE',
      passwordHash: adminHash,
    },
    create: {
      name: 'Local Admin',
      email: adminEmail,
      organizationId: organization.id,
      passwordHash: adminHash,
    },
  });
  const branchUser = await prisma.user.upsert({
    where: { email: branchUserEmail },
    update: {
      name: 'North Branch User',
      organizationId: organization.id,
      status: 'ACTIVE',
      passwordHash: branchUserHash,
    },
    create: {
      name: 'North Branch User',
      email: branchUserEmail,
      organizationId: organization.id,
      passwordHash: branchUserHash,
    },
  });

  for (const [user, role] of [
    [admin, adminRole],
    [branchUser, branchRole],
  ] as const) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      update: {},
      create: { userId: user.id, roleId: role.id },
    });
  }
  for (const branch of [centralBranch, northBranch]) {
    await prisma.userBranchAccess.upsert({
      where: { userId_branchId: { userId: admin.id, branchId: branch.id } },
      update: {},
      create: { userId: admin.id, branchId: branch.id },
    });
  }
  await prisma.userBranchAccess.upsert({
    where: {
      userId_branchId: { userId: branchUser.id, branchId: northBranch.id },
    },
    update: {},
    create: { userId: branchUser.id, branchId: northBranch.id },
  });

  console.info('Local AdFlow seed completed.');
}

main()
  .catch(() => {
    console.error(
      'Local AdFlow seed failed. Check database connectivity and required seed environment variable names.',
    );
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
