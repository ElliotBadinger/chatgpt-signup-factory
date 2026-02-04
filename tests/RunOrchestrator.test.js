import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { RunOrchestrator } from '../src/orchestrator/RunOrchestrator.js';
import { Events } from '../src/orchestrator/events.js';

class FakeSignupFactory {
    constructor(apiKey, options) {
        this.apiKey = apiKey;
        this.options = options;
    }
    async init() {}
    async run() {
        this.options.onEvent({ type: Events.RUN_START });
        this.options.onEvent({ type: Events.STATE_CHANGE, state: 'INITIAL' });
        
        if (this.options.artifactDir) {
            this.options.onEvent({ 
                type: Events.ARTIFACT_WRITTEN, 
                kind: 'snapshot', 
                path: `${this.options.artifactDir}/debug_snapshot.txt` 
            });
        }

        const approved = await this.options.onCheckpoint({ type: 'before_subscribe' });
        if (!approved) {
            this.options.onEvent({ type: Events.RUN_FAILURE, reason: 'CHECKPOINT_REJECTED' });
            throw new Error('CHECKPOINT_REJECTED');
        }

        this.options.onEvent({ type: Events.RUN_SUCCESS });
        return true;
    }
}

describe('RunOrchestrator', () => {
    it('should emit events from the factory', async () => {
        const events = [];
        const orchestrator = new RunOrchestrator({
            factoryClass: FakeSignupFactory
        });
        
        orchestrator.on(Events.RUN_START, (ev) => events.push(ev));
        orchestrator.on(Events.STATE_CHANGE, (ev) => events.push(ev));
        orchestrator.on(Events.RUN_SUCCESS, (ev) => events.push(ev));

        await orchestrator.run();

        expect(events).toContainEqual(expect.objectContaining({ type: Events.RUN_START }));
        expect(events).toContainEqual(expect.objectContaining({ type: Events.STATE_CHANGE, state: 'INITIAL' }));
        expect(events).toContainEqual(expect.objectContaining({ type: Events.RUN_SUCCESS }));
    });

    it('should emit artifact:written events with prefixed paths', async () => {
        const artifactEvents = [];
        const testDir = '/tmp/artifacts';
        const orchestrator = new RunOrchestrator({
            factoryClass: FakeSignupFactory,
        });

        orchestrator.on(Events.ARTIFACT_WRITTEN, (ev) => artifactEvents.push(ev));

        await orchestrator.run({ config: { artifactDir: testDir } });

        expect(artifactEvents).toContainEqual(expect.objectContaining({
            type: Events.ARTIFACT_WRITTEN,
            kind: 'snapshot',
            path: expect.stringContaining(testDir)
        }));
    });

    it('should handle approved checkpoints', async () => {
        const orchestrator = new RunOrchestrator({
            factoryClass: FakeSignupFactory,
            checkpointProvider: {
                approve: async () => true
            }
        });

        const result = await orchestrator.run();
        expect(result).toBe(true);
    });

    it('should handle rejected checkpoints', async () => {
        const orchestrator = new RunOrchestrator({
            factoryClass: FakeSignupFactory,
            checkpointProvider: {
                approve: async () => false
            }
        });

        const failureEvents = [];
        orchestrator.on(Events.RUN_FAILURE, (ev) => failureEvents.push(ev));

        await expect(orchestrator.run()).rejects.toThrow('CHECKPOINT_REJECTED');
        expect(failureEvents).toContainEqual(expect.objectContaining({ type: Events.RUN_FAILURE, reason: 'CHECKPOINT_REJECTED' }));
    });

    it('should listen to logger and emit log events', async () => {
        const logEvents = [];
        const mockLogger = new EventEmitter();
        const orchestrator = new RunOrchestrator({
            factoryClass: FakeSignupFactory,
            logger: mockLogger
        });

        orchestrator.on(Events.LOG_LINE, (ev) => logEvents.push(ev));

        const testLog = { message: 'test log', timestamp: new Date().toISOString() };
        mockLogger.emit('log', testLog);

        expect(logEvents).toContainEqual(testLog);
    });

    it('should call artifactManager.handleEvent for all events', async () => {
        const mockArtifactManager = {
            handleEvent: jest.fn()
        };
        const orchestrator = new RunOrchestrator({
            factoryClass: FakeSignupFactory,
            artifactManager: mockArtifactManager
        });

        await orchestrator.run();

        // RUN_START, STATE_CHANGE, RUN_SUCCESS are emitted by FakeSignupFactory.run()
        expect(mockArtifactManager.handleEvent).toHaveBeenCalledWith(expect.objectContaining({ type: Events.RUN_START }));
        expect(mockArtifactManager.handleEvent).toHaveBeenCalledWith(expect.objectContaining({ type: Events.STATE_CHANGE }));
        expect(mockArtifactManager.handleEvent).toHaveBeenCalledWith(expect.objectContaining({ type: Events.RUN_SUCCESS }));
    });
});
