# Kapomatic Inventory System - Project Context

This document provides foundational context and instructions for AI agents working on the Kapomatic Inventory System.

## Project Overview
Kapomatic is a modern inventory management application built with **Angular** and wrapped as a desktop application using **Electron**. It features customer management, product categorization, sales tracking (including credit sales), and profit reporting.

### Core Technology Stack
- **Framework:** Angular 20 (utilizing Standalone Components, Functional Guards/Interceptors, and Zoneless Change Detection).
- **UI & Styling:** PrimeNG (Aura theme), Tailwind CSS, SCSS, FontAwesome.
- **Desktop Wrapper:** Electron (cross-platform, optimized for Windows builds).
- **Utilities:**
  - `chart.js`: For data visualization and reporting.
  - `jspdf`: For generating PDF invoices and reports.
  - `ngx-translate`: Internationalization (i18n) support for English and Arabic.
  - `angular-svg-icon` & `angularx-qrcode`: Asset management and QR code generation.

## Project Architecture
The project follows a modular structure under `src/app/modules/`:

- **`admin/`**: Management of administrative users and permissions.
- **`customer/`**: CRM features, customer lists, and detailed transaction history.
- **`category/`**: Product categorization and inventory management.
- **`products/`**: Core sales logic, including selling interface, credit sales, and invoice history.
- **`layout/`**: Global UI components like navigation and shells.
- **`shared/`**: Reusable components and services (e.g., `DiskService` for local storage management).
- **`core/`**: Essential infrastructure including guards and HTTP interceptors.

## Key Development Commands
| Command | Purpose |
| :--- | :--- |
| `npm start` | Launches the Angular development server (`http://localhost:4200`). |
| `npm run electron:start` | Builds the Angular app and launches the Electron desktop application. |
| `npm run build:desktop` | Compiles the Angular project with relative base href for Electron compatibility. |
| `npm run electron:build:win` | Packages the application for Windows (generates NSIS installer). |
| `npm test` | Runs unit tests using Karma. |

## Development Conventions & Standards
- **Standalone Components:** All new components should be Standalone. Module-based declarations are deprecated in this project.
- **Functional Patterns:** Use functional interceptors and guards (e.g., `httpconfigInterceptor`) instead of class-based ones.
- **Styling:** Prefer **Tailwind CSS** for layout and utility-first styling. Use component-specific **SCSS** only for complex custom styling or theme overrides.
- **State & Storage:** The `DiskService` (`src/app/modules/shared/services/disk.service.ts`) is the central point for managing persistent local state and authentication tokens.
- **Internationalization:** Always use the `translate` pipe or service for user-facing strings. Translation files are located in `public/i18n/`.
- **Error Handling:** Global error handling is configured via `provideBrowserGlobalErrorListeners()` in `app.config.ts`.

## Deployment & Distribution
- Build artifacts are stored in `dist/`.
- Electron distribution packages (installers) are output to the `release/` directory.
- The `electron/main.js` file handles the bootstrapping of the desktop window and points to the built Angular files in `dist/`.
