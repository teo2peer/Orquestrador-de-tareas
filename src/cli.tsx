#!/usr/bin/env bun
import { render } from 'ink';
import React from 'react';
import { importPack } from './library.ts';
import { PROJECT_DIR, ensureHome } from './paths.ts';
import { findRun, listRuns } from './runs.ts';
import { App } from './ui/App.tsx';
import { setRedrawHook } from './ui/app-context.tsx';
import { DISABLE_MOUSE } from './ui/mouse.tsx';

const [cmd, ...rest] = process.argv.slice(2);

ensureHome();

if (cmd === 'import') {
  // orq import <dir | host:/dir> [pack-name]
  if (!rest[0]) {
    console.error('Usage: orq import <dir | host:/dir> [pack-name]');
    process.exit(1);
  }
  const r = await importPack(rest[0], rest[1]);
  console.log(`Pack "${r.pack}": ${r.imported.length} roles → ${r.imported.join(', ')}`);
  process.exit(0);
}

for (const bin of ['tmux', 'claude']) {
  if (!Bun.which(bin)) {
    console.error(`orq needs \`${bin}\` in PATH.`);
    process.exit(1);
  }
}

// orq --resume            → open the Sessions tab for this directory
// orq --resume <runId>    → resume / reattach that run directly
// orq --resume --last     → resume the most recent run of this directory
let initialTab: 'teams' | 'sessions' = 'teams';
let resumeDir: string | undefined;
if (cmd === '--resume' || cmd === '-r') {
  initialTab = 'sessions';
  const arg = rest[0];
  if (arg) {
    const run = arg === '--last' ? listRuns(PROJECT_DIR)[0] : findRun(arg);
    if (!run) {
      console.error(arg === '--last' ? 'No hay sesiones en este directorio.' : `No existe la sesión ${arg}. Usa \`orq --resume\` para verlas.`);
      process.exit(1);
    }
    resumeDir = run.dir;
  }
} else if (cmd === '--help' || cmd === '-h') {
  console.log(`orq — empresa de agentes Claude en tmux

  orq                      abre la interfaz en el directorio actual
  orq --resume             lista las sesiones (este directorio / todos)
  orq --resume <runId>     reanuda o reconecta una sesión
  orq --resume --last      reanuda la última sesión de este directorio
  orq import <dir|host:/dir> [pack]   importa agentes markdown como roles`);
  process.exit(0);
}

const instance = render(<App initialTab={initialTab} resumeDir={resumeDir} />, { alternateScreen: true, exitOnCtrlC: false, maxFps: 20 });
setRedrawHook(() => instance.clear());
process.on('exit', () => process.stdout.write(DISABLE_MOUSE));
await instance.waitUntilExit();
process.exit(0);
