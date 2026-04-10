# workpulse-agent-electron

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

```bash
$ pnpm dev
```

### Build

```bash
# For windows (Run on Windows)
$ pnpm build:win

# For macOS (Run on macOS)
$ pnpm build:mac

# For Linux (Run on Linux)
$ pnpm build:linux
```

## 🚀 Production Release Workflow

To publish a new version and enable auto-updates for users:

1.  **Increment Version**: Update `"version"` in `package.json` (e.g., `1.0.2`).
2.  **Generate Build**: Run the appropriate `pnpm build:*` command for your OS.
3.  **Locate Files**: Go to the `dist/` folder and find:
    -   The Installer (zip/exe/deb/dmg)
    -   The Metadata (`latest-*.yml`)
4.  **Publish**:
    -   Log in to the **HRMS Web Dashboard** as a Super Admin.
    -   Navigate to the **WorkPulse Agent** page.
    -   Upload **both** the Installer and the Metadata file.
5.  **Verify**: Existing agents will automatically detect the new version within minutes!

> [!TIP]
> **Code Signing**: For production, insure you have configured your Code Signing certificates in `electron-builder.yml` to prevent "Unknown Publisher" warnings for your users.
