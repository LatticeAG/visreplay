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
const node_test_1 = require("node:test");
const assert = __importStar(require("node:assert"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const recorder_1 = require("../src/recorder");
(0, node_test_1.test)('LexReplay basic wrapper test', async () => {
    const recorder = new recorder_1.LexReplay({ sessionName: 'test-session', agentType: 'mock' });
    class MockAgent {
        async run(input) {
            return `Processed: ${input}`;
        }
    }
    const agent = new MockAgent();
    const wrappedAgent = recorder.wrap(agent);
    const result = await wrappedAgent.run('Hello');
    assert.strictEqual(result, 'Processed: Hello');
    const filePath = path.join(__dirname, 'test-session.json');
    await recorder.save(filePath);
    assert.ok(fs.existsSync(filePath), 'Session file should have been created');
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.strictEqual(content.sessionName, 'test-session');
    assert.strictEqual(content.events.length, 2);
    assert.strictEqual(content.events[0].type, 'input');
    assert.strictEqual(content.events[1].type, 'output');
    // cleanup
    fs.unlinkSync(filePath);
});
