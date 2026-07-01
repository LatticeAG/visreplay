"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Player = void 0;
const readline = __importStar(require("readline"));
const session_1 = require("./session");
class Player {
    sessionData = null;
    async load(filePath) {
        this.sessionData = await session_1.Session.load(filePath);
        console.log(`Loaded session: ${this.sessionData.sessionName} (${this.sessionData.events.length} events)`);
    }
    async play(auto = false) {
        if (!this.sessionData) {
            throw new Error('No session loaded');
        }
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        const askToContinue = () => new Promise(resolve => {
            rl.question('Press Enter to continue to next event (or type "q" to quit)...', answer => {
                if (answer.toLowerCase() === 'q') {
                    process.exit(0);
                }
                resolve();
            });
        });
        for (const event of this.sessionData.events) {
            this.printEvent(event);
            if (!auto) {
                await askToContinue();
            }
            else {
                await new Promise(r => setTimeout(r, 500));
            }
        }
        console.log('\n--- End of Session ---');
        rl.close();
    }
    printEvent(event) {
        console.log(`\n[${event.timestamp}] EVENT: ${event.type.toUpperCase()} (Index: ${event.index})`);
        if (event.content)
            console.log(`Content: ${event.content}`);
        if (event.name)
            console.log(`Name: ${event.name}`);
        if (event.arguments)
            console.log(`Arguments: ${JSON.stringify(event.arguments, null, 2)}`);
        if (event.result)
            console.log(`Result: ${JSON.stringify(event.result, null, 2)}`);
        if (event.error)
            console.log(`Error: ${event.error}`);
    }
}
exports.Player = Player;
