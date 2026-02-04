import { createInitialState, reducer, Screens } from '../src/tui/stateMachine.js';
import fc from 'fast-check';

describe('TuiStateMachine Property Tests', () => {
  test('invariants hold after any action', () => {
    const actions = [
      fc.constant({ type: 'NAV_NEXT' }),
      fc.constant({ type: 'NAV_BACK' }),
      fc.constant({ type: 'RUN_START' }),
      fc.constant({ type: 'RUN_SUCCESS' }),
      fc.constant({ type: 'RUN_FAILURE', error: 'error' }),
      fc.constant({ type: 'CHECKPOINT_REQUEST', checkpointType: 'test' }),
      fc.constant({ type: 'CHECKPOINT_RESOLVE', approved: true }),
    ];

    fc.assert(
      fc.property(fc.array(fc.oneof(...actions), { maxLength: 20 }), (actionList) => {
        let state = createInitialState();
        for (const action of actionList) {
          state = reducer(state, action);
        }

        // Invariant 1: If screen is RESULTS, status must not be running
        if (state.screen === Screens.RESULTS) {
          expect(state.run.status).not.toBe('running');
        }

        // Invariant 2: If screen is not RUNNING, run status should not be running (unless we just started)
        // Actually, RUN_START sets screen to RUNNING.
        if (state.run.status === 'running') {
          expect(state.screen).toBe(Screens.RUNNING);
        }

        // Invariant 3: checkpoint.pending should only be true if screen is RUNNING
        if (state.checkpoint.pending) {
          expect(state.screen).toBe(Screens.RUNNING);
        }
      }),
      { seed: 42 }
    );
  });

  test('RUN_SUCCESS or RUN_FAILURE should end running status and clear pending checkpoint (snippet from task)', () => {
    fc.assert(fc.property(fc.constantFrom('RUN_SUCCESS','RUN_FAILURE'), (action) => {
      const s = reducer(reducer(createInitialState(), {type:'RUN_START'}), {type: action});
      expect(s.run.status).not.toBe('running');
      expect(s.checkpoint.pending).toBe(false);
    }), { seed: 42 });
  });

  test('RUN_SUCCESS or RUN_FAILURE should end running status and clear pending checkpoint', () => {
    fc.assert(
      fc.property(fc.constantFrom('RUN_SUCCESS', 'RUN_FAILURE'), (actionType) => {
        let s = createInitialState();
        s = reducer(s, { type: 'RUN_START' });
        s = reducer(s, { type: 'CHECKPOINT_REQUEST' });
        
        s = reducer(s, { type: actionType });
        
        expect(s.run.status).not.toBe('running');
        expect(s.checkpoint.pending).toBe(false);
      }),
      { seed: 42 }
    );
  });
});
