# AdFlow Architecture Overview

## Boundary

AdFlow owns:
- organizations
- branches
- users and access
- campaigns
- template metadata
- assets
- creatives and versions
- configurable workflows
- approvals and change requests
- comments and notifications
- exports/distribution orchestration
- audit history

Canva owns:
- design editing
- Canva templates
- supported Autofill operations
- supported exports

## Provider boundary

External services must be accessed through adapters. The Canva implementation will later conform to a provider interface so a mock provider can be used during development and tests.

## Async work

Use background jobs for:
- Canva Autofill
- Canva export
- notifications
- publishing
- asset processing

Never block an HTTP request while waiting for a long-running external job.

## Multi-branch model

A campaign can target many branches through a join entity. Branch-specific campaign data is localized at the campaign-branch level rather than duplicating the campaign.

## Workflow model

Workflows are definitions plus runtime instances. Campaigns/creatives may select different workflow definitions. Organization-level settings can be overridden by campaign and branch settings.

## Security

Authorization is server-side. The frontend is never a security boundary.
