#!/usr/bin/env node

import { Command } from 'commander';
import { Player } from './player';

const program = new Command();

program
  .name('lattice')
  .description('LexReplay CLI for replaying and managing agent sessions')
  .version('1.0.0');

program
  .command('replay')
  .description('Replay a recorded session')
  .argument('<file>', 'Path to the session JSON file')
  .option('--auto', 'Play through automatically without waiting for user input', false)
  .action(async (file, options) => {
    try {
      const player = new Player();
      await player.load(file);
      await player.play(options.auto);
    } catch (err) {
      console.error('Error replaying session:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command('upload')
  .description('Upload a session to Lattice SaaS (future feature)')
  .argument('<file>', 'Path to the session JSON file')
  .action((file) => {
    console.log(`Uploading ${file} to Lattice...`);
    console.log('Upload complete! (Note: This is a placeholder for future SaaS integration)');
  });

program.parse();
