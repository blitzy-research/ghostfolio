# Repository Overview

Ghostfolio is organized as an [Nx](https://nx.dev) workspace. Source code is split between deployable applications under `apps/` and reusable libraries under `libs/`.

## Top-level layout

| Path                 | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `apps/`              | Deployable applications                                   |
| `libs/`              | Shared libraries consumed by the applications             |
| `prisma/`            | Prisma schema and database migration assets               |
| `docker/`            | Docker Compose files for prod, build and dev environments |
| `test/`              | Cross-application test assets                             |
| `tools/`             | Custom workspace scripts and tooling                      |
| `nx.json`            | Nx workspace configuration                                |
| `tsconfig.base.json` | Shared TypeScript configuration                           |
| `DEVELOPMENT.md`     | Developer setup guide                                     |
| `SECURITY.md`        | Security policy                                           |
| `catalog-info.yaml`  | Backstage catalog descriptor                              |

## Applications (`apps/`)

| App           | Description                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api`    | NestJS backend exposing the REST API, backed by PostgreSQL via Prisma and Redis for caching                                                                                                                                                                                                                                                                        |
| `apps/client` | Angular progressive web frontend, styled with Angular Material and Bootstrap utilities, presenting every feature as a module of a single-canvas modular dashboard laid out by `angular-gridster2`, implemented under `apps/client/src/app/dashboard/**`, which holds the canvas host, the module registry, the module catalog and 21 lazily loaded module wrappers |

## Libraries (`libs/`)

| Library       | Description                                                                   |
| ------------- | ----------------------------------------------------------------------------- |
| `libs/common` | Shared TypeScript types, constants and helpers consumed by `api` and `client` |
| `libs/ui`     | Reusable Angular UI components consumed by `apps/client`                      |

## Infrastructure dependencies

- PostgreSQL: primary data store accessed through Prisma (`prisma/`)
- Redis: cache and queue backend
- Docker: recommended runtime for self-hosting and for local infrastructure during development

## License

Distributed under the AGPL v3 license. See `LICENSE` and `SECURITY.md` in the repository root.
