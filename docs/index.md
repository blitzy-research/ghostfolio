# Ghostfolio

Open Source Wealth Management Software.

Ghostfolio is an open source wealth management application built with web technology. It empowers busy people to keep track of stocks, ETFs or cryptocurrencies and to make solid, data-driven investment decisions. The software is designed for personal use in continuous operation.

## Who is Ghostfolio for?

- Trading stocks, ETFs or cryptocurrencies on multiple platforms
- Pursuing a buy and hold strategy
- Interested in insights about portfolio composition
- Valuing privacy and data ownership
- Caring about diversifying financial resources
- Interested in financial independence

## Features

- Customizable dashboard: add the features you need as modules from a searchable catalog by click or drag and drop, then move and resize them on a single canvas, with your layout saved per user
- Create, update and delete transactions
- Multi account management
- Portfolio performance (Return on Average Investment) for `Today`, `WTD`, `MTD`, `YTD`, `1Y`, `5Y`, `Max`
- Various charts
- Static analysis to identify potential risks in your portfolio
- Import and export transactions
- Dark Mode and a distraction-free view by placing only the modules you want to focus on
- Progressive Web App (PWA) designed for the desktop

## Technology Stack

Ghostfolio is a modern web application written in TypeScript and organized as an [Nx](https://nx.dev) workspace.

- Backend: [NestJS](https://nestjs.com) with [PostgreSQL](https://www.postgresql.org), [Prisma](https://www.prisma.io) and [Redis](https://redis.io) for caching.
- Frontend: [Angular](https://angular.dev) with [Angular Material](https://material.angular.io) and utility classes from [Bootstrap](https://getbootstrap.com). The dashboard canvas is served from a single root route and laid out by [angular-gridster2](https://github.com/tiberiuzuld/angular-gridster2) version `21.0.1` on a 12-column grid with a fixed row height.

## Public API

The application exposes a REST API protected via Bearer Token authentication. A bearer token can be obtained via `POST /api/v1/auth/anonymous` with body `{ "accessToken": "<SECURITY_TOKEN>" }`. A health check is available at `GET /api/v1/health` (no token required).

## License

Ghostfolio is distributed under the AGPL v3 license.
