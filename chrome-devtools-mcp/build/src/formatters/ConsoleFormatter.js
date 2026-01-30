/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { createStackTraceForConsoleMessage, } from '../DevtoolsUtils.js';
export class ConsoleFormatter {
    #msg;
    #resolvedArgs = [];
    #resolvedStackTrace;
    #id;
    constructor(msg, options) {
        this.#msg = msg;
        this.#id = options?.id;
        this.#resolvedStackTrace = options?.resolvedStackTraceForTesting;
    }
    static async from(msg, options) {
        const formatter = new ConsoleFormatter(msg, options);
        if (options?.fetchDetailedData) {
            await formatter.#loadDetailedData(options?.devTools);
        }
        return formatter;
    }
    async #loadDetailedData(devTools) {
        if (this.#msg instanceof Error) {
            return;
        }
        this.#resolvedArgs = await Promise.all(this.#msg.args().map(async (arg, i) => {
            try {
                return await arg.jsonValue();
            }
            catch {
                return `<error: Argument ${i} is no longer available>`;
            }
        }));
        if (devTools) {
            try {
                this.#resolvedStackTrace = await createStackTraceForConsoleMessage(devTools, this.#msg);
            }
            catch {
                // ignore
            }
        }
    }
    // The short format for a console message.
    toString() {
        const type = this.#getType();
        const text = this.#getText();
        const argsCount = this.#msg instanceof Error
            ? 0
            : this.#resolvedArgs.length || this.#msg.args().length;
        const idPart = this.#id !== undefined ? `msgid=${this.#id} ` : '';
        return `${idPart}[${type}] ${text} (${argsCount} args)`;
    }
    // The verbose format for a console message, including all details.
    toStringDetailed() {
        const result = [
            this.#id !== undefined ? `ID: ${this.#id}` : '',
            `Message: ${this.#getType()}> ${this.#getText()}`,
            this.#formatArgs(),
            this.#formatStackTrace(this.#resolvedStackTrace),
        ].filter(line => !!line);
        return result.join('\n');
    }
    #getType() {
        if (this.#msg instanceof Error) {
            return 'error';
        }
        return this.#msg.type();
    }
    #getText() {
        if (this.#msg instanceof Error) {
            return this.#msg.message;
        }
        return this.#msg.text();
    }
    #getArgs() {
        if (this.#msg instanceof Error) {
            return [];
        }
        if (this.#resolvedArgs.length > 0) {
            const args = [...this.#resolvedArgs];
            // If there is no text, the first argument serves as text (see formatMessage).
            if (!this.#msg.text()) {
                args.shift();
            }
            return args;
        }
        return [];
    }
    #formatArg(arg) {
        return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
    }
    #formatArgs() {
        const args = this.#getArgs();
        if (!args.length) {
            return '';
        }
        const result = ['### Arguments'];
        for (const [key, arg] of args.entries()) {
            result.push(`Arg #${key}: ${this.#formatArg(arg)}`);
        }
        return result.join('\n');
    }
    #formatStackTrace(stackTrace) {
        if (!stackTrace) {
            return '';
        }
        return [
            '### Stack trace',
            this.#formatFragment(stackTrace.syncFragment),
            ...stackTrace.asyncFragments.map(this.#formatAsyncFragment.bind(this)),
        ].join('\n');
    }
    #formatFragment(fragment) {
        return fragment.frames.map(this.#formatFrame.bind(this)).join('\n');
    }
    #formatAsyncFragment(fragment) {
        const separatorLineLength = 40;
        const prefix = `--- ${fragment.description || 'async'} `;
        const separator = prefix + '-'.repeat(separatorLineLength - prefix.length);
        return separator + '\n' + this.#formatFragment(fragment);
    }
    #formatFrame(frame) {
        let result = `at ${frame.name ?? '<anonymous>'}`;
        if (frame.uiSourceCode) {
            result += ` (${frame.uiSourceCode.displayName()}:${frame.line}:${frame.column})`;
        }
        else if (frame.url) {
            result += ` (${frame.url}:${frame.line}:${frame.column})`;
        }
        return result;
    }
    toJSON() {
        return {
            type: this.#getType(),
            text: this.#getText(),
            argsCount: this.#msg instanceof Error
                ? 0
                : this.#resolvedArgs.length || this.#msg.args().length,
            id: this.#id,
        };
    }
    toJSONDetailed() {
        return {
            id: this.#id,
            type: this.#getType(),
            text: this.#getText(),
            args: this.#getArgs().map(arg => typeof arg === 'object' ? arg : String(arg)),
            stackTrace: this.#resolvedStackTrace,
        };
    }
}
