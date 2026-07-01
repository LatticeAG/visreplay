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
const recorder_1 = require("../src/recorder");
const path = __importStar(require("path"));
// A simple mock agent class
class MyAgent {
    async run(task) {
        console.log(`[Agent] Received task: ${task}`);
        // Simulate some work
        await new Promise(r => setTimeout(r, 1000));
        return `Completed: ${task}`;
    }
}
async function main() {
    const recorder = new recorder_1.LexReplay({ sessionName: 'my-session', agentType: 'custom' });
    const myAgentClient = new MyAgent();
    const agent = recorder.wrap(myAgentClient);
    console.log('Running wrapped agent...');
    const result = await agent.run('Deploy to staging');
    // You can also manually add agent-specific events
    recorder.recordReasoning('I decided to deploy directly because tests passed.');
    recorder.recordToolCall('execute_deployment', { env: 'staging' });
    recorder.recordToolResult({ success: true, url: 'https://staging.example.com' });
    console.log(`Agent returned: ${result}`);
    const filePath = path.join(__dirname, 'session.json');
    await recorder.save(filePath);
    console.log(`Session saved to ${filePath}`);
}
main().catch(console.error);
