#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const player_1 = require("./player");
const program = new commander_1.Command();
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
        const player = new player_1.Player();
        await player.load(file);
        await player.play(options.auto);
    }
    catch (err) {
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
