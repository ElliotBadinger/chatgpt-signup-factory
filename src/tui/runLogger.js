import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { Events } from '../orchestrator/events.js';

export class RunLogger extends EventEmitter {
    constructor({ artifactManager } = {}) {
        super();
        this.artifactManager = artifactManager;
        this.logFile = null;

        if (this.artifactManager) {
            this.logFile = this.artifactManager.pathFor('log', 'tui.log');
            // Ensure the directory exists (pathFor already does this)
            this.artifactManager.recordArtifact('log', 'tui.log');
        }
    }

    log(message, metadata = {}) {
        const timestamp = new Date().toISOString();
        // Basic redaction: this is a placeholder. 
        // In a real app, we'd pass sensitive patterns to the logger.
        const redactedMessage = typeof message === 'string' 
            ? message.replace(/(password|cvc|cardNumber):\s*\S+/gi, '$1: [REDACTED]')
            : message;
        
        const logLine = `[${timestamp}] ${redactedMessage}`;

        if (this.logFile) {
            fs.appendFileSync(this.logFile, logLine + '\n');
        }

        const event = {
            type: Events.LOG_LINE,
            message: redactedMessage,
            timestamp,
            ...metadata
        };

        this.emit('log', event);
    }
}
