import { EventEmitter } from 'events';
import { SignupFactory } from '../SignupFactory.js';
import { Events } from './events.js';

export class RunOrchestrator extends EventEmitter {
    constructor(options = {}) {
        super();
        this.agentMailApiKey = options.agentMailApiKey;
        this.factoryClass = options.factoryClass || SignupFactory;
        this.checkpointProvider = options.checkpointProvider || {
            approve: async () => true
        };
        this.artifactManager = options.artifactManager;
        this.logger = options.logger;

        if (this.artifactManager) {
            this.on(Events.RUN_START, (ev) => this.artifactManager.handleEvent(ev));
            this.on(Events.RUN_SUCCESS, (ev) => this.artifactManager.handleEvent(ev));
            this.on(Events.RUN_FAILURE, (ev) => this.artifactManager.handleEvent(ev));
            this.on(Events.STATE_CHANGE, (ev) => this.artifactManager.handleEvent(ev));
            this.on(Events.ARTIFACT_WRITTEN, (ev) => this.artifactManager.handleEvent(ev));
            this.on(Events.LOG_LINE, (ev) => this.artifactManager.handleEvent(ev));
        }

        if (this.logger) {
            this.logger.on('log', (ev) => {
                this.emit(Events.LOG_LINE, ev);
            });
        }
    }

    async run({ config = {} } = {}) {
        const factory = new this.factoryClass(this.agentMailApiKey, {
            ...config,
            onEvent: (event) => {
                this.emit(event.type, event);
            },
            onCheckpoint: async (checkpoint) => {
                return await this.checkpointProvider.approve(checkpoint);
            }
        });

        await factory.init();
        return await factory.run();
    }
}
