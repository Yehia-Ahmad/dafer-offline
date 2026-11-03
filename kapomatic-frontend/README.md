# Kapomatic Inventory System

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

## Electron (Windows build)

Requirements:

- Node.js `20.19+` (or `22.12+`)

Commands:

```bash
# Run desktop app from built Angular files
npm run electron:start

# Build unpacked desktop output (for testing)
npm run electron:build:dir

# Build Windows unpacked app folder (works on Linux without Wine)
npm run electron:build:win:dir

# Build Windows installer (.exe via NSIS)
npm run electron:build:win
```

Build artifacts are generated in the `release/` directory.

Notes:

- `npm run electron:build:win:dir` generates `release/win-unpacked/`, which already contains `Kapomatic Inventory System.exe`.
- `npm run electron:build:win` generates an NSIS installer, but on Linux it requires `wine` to be installed.

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

generate electron desktop application and generate windows version

zip -r win-unpacked.zip win-unpacked