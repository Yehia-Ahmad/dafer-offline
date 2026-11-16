# Nota

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 20.3.5.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Deployment

Nota is a normal web app: one Node backend plus MongoDB per shop, used from a browser. The production build calls the API on the same origin (`/api/`, see `src/environments/environment.prod.ts`), so the web server (for example nginx) serves `dist/nota` and proxies `/api/` to the backend. In development (`ng serve`) the API address is `src/environments/environment.ts` (`http://localhost:5000/api/`); add `http://localhost:4200` to `CORS_ORIGINS` in the backend `.env`. The first owner account is created on the server with `npm run create-owner` (see `nota-backend/README.md`).

## Running unit tests

To execute unit tests with the [Karma](https://karma-runner.github.io) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.