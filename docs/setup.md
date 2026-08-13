# Setup

Ghostfolio can be self-hosted with Docker Compose or run locally for development.

## Self-hosting with Docker Compose

### Prerequisites

- Basic knowledge of Docker
- [Docker](https://www.docker.com/products/docker-desktop) installed
- A local copy of this Git repository
- Copy `.env.example` to `.env` and populate it: `cp .env.example .env`

### Run the published images

```bash
docker compose -f docker/docker-compose.yml up -d
```

### Build and run from source

```bash
docker compose -f docker/docker-compose.build.yml build
docker compose -f docker/docker-compose.build.yml up -d
```

### First launch

1. Open `http://localhost:3333`.
2. Create a new user via _Get Started_. The first user receives the `ADMIN` role.

### Upgrading

1. Bump the `ghostfolio/ghostfolio` image version in `docker/docker-compose.yml`. If `ghostfolio:latest` is used, run `docker compose -f docker/docker-compose.yml pull`.
2. Restart: `docker compose -f docker/docker-compose.yml up -d`. Required database migrations are applied automatically.

## Local Development

### Prerequisites

- [Docker](https://www.docker.com/products/docker-desktop)
- [Node.js](https://nodejs.org/en/download) `>=22.18.0`
- A local clone of this Git repository
- Copy `.env.dev` to `.env` and populate it: `cp .env.dev .env`

### Bootstrap

1. `npm install`
2. `docker compose -f docker/docker-compose.dev.yml up -d` to start PostgreSQL and Redis
3. `npm run database:setup` to initialize the schema
4. Start the server and the client (see below)
5. Open `https://localhost:4200/en`
6. Create the first user via _Get Started_ (receives the `ADMIN` role)

### Start the server

- Debug: `npm run watch:server`, then click _Debug API_ in Visual Studio Code.
- Serve: `npm run start:server`.

### Start the client

- English: `npm run start:client`, then open `https://localhost:4200/en`.
- Other languages: edit `start:client` in `package.json` (e.g. `--configuration=development-de`), then `npm run start:client`.

### Database

- Sync schema while prototyping: `npm run database:push`
- Prisma Studio GUI: `npm run database:gui`
- Named migration: `npm run prisma migrate dev --name <name>`

### Testing

```bash
npm test
```

## Key Environment Variables

| Name                                                    | Required    | Description                                                                                                     |
| ------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| `ACCESS_TOKEN_SALT`                                     | yes         | Random salt for access tokens                                                                                   |
| `DATABASE_URL`                                          | yes         | PostgreSQL connection URL                                                                                       |
| `JWT_SECRET_KEY`                                        | yes         | Random string used for signing JWTs                                                                             |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD`   | yes         | Database name and credentials                                                                                   |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD`          | yes         | Redis connection details                                                                                        |
| `DATABASE_CONNECTION_TIMEOUT`                           | no          | Milliseconds a request may spend obtaining a database connection, new or pooled (default `30000`, `0` disables) |
| `DATABASE_QUERY_TIMEOUT`                                | no          | Milliseconds a single database statement may run before it is abandoned (default `30000`, `0` disables)         |
| `HOST`                                                  | no          | Bind host (default `0.0.0.0`)                                                                                   |
| `PORT`                                                  | no          | Listen port (default `3333`)                                                                                    |
| `ROOT_URL`                                              | no          | Public root URL (default `http://0.0.0.0:3333`)                                                                 |
| `LOG_LEVELS`                                            | no          | e.g. `["debug","error","log","warn"]`                                                                           |
| `ENABLE_FEATURE_AUTH_OIDC`                              | no          | Enable OIDC auth (default `false`)                                                                              |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | conditional | Required when OIDC is enabled                                                                                   |
