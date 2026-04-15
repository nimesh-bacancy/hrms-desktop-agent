const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

function hasVisualStudioBuildTools() {
  if (process.platform !== 'win32') return true

  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'

  const vsWhereCandidates = [
    path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
    path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  ]

  for (const vswhere of vsWhereCandidates) {
    if (!fs.existsSync(vswhere)) continue

    const result = spawnSync(
      vswhere,
      ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
      { encoding: 'utf8' }
    )

    if (result.status === 0 && result.stdout && result.stdout.trim().length > 0) {
      return true
    }
  }

  return false
}

function runInstallAppDeps() {
  const binName = process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
  const localBin = path.join(__dirname, '..', 'node_modules', '.bin', binName)
  const command = fs.existsSync(localBin) ? localBin : 'electron-builder'

  const result = spawnSync(command, ['install-app-deps'], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })

  if (result.error) throw result.error
  process.exit(result.status || 0)
}

const forceRebuild = process.env.FORCE_ELECTRON_REBUILD === '1'

if (!forceRebuild && process.platform === 'win32' && !hasVisualStudioBuildTools()) {
  console.warn('[postinstall] Visual Studio C++ Build Tools not found. Skipping electron native rebuild.')
  console.warn('[postinstall] Using prebuilt native binaries. Set FORCE_ELECTRON_REBUILD=1 to force rebuild.')
  process.exit(0)
}

runInstallAppDeps()
