import { createInitialState, reducer, Screens } from '../src/tui/stateMachine.js';

describe('TUI state machine', () => {
  test('basic navigation flow', () => {
    let s = createInitialState();
    expect(s.screen).toBe(Screens.WIZARD);

    s = reducer(s, { type: 'NAV_NEXT' });
    expect(s.screen).toBe(Screens.PREFLIGHT);

    s = reducer(s, { type: 'NAV_NEXT' });
    expect(s.screen).toBe(Screens.CONFIRM);

    s = reducer(s, { type: 'RUN_START' });
    expect(s.screen).toBe(Screens.RUNNING);

    s = reducer(s, { type: 'RUN_SUCCESS' });
    expect(s.screen).toBe(Screens.RESULTS);
    expect(s.run.status).toBe('success');
  });

  test('screen transitions beyond boundaries', () => {
    let s = createInitialState();
    // At WIZARD, NAV_BACK should do nothing
    s = reducer(s, { type: 'NAV_BACK' });
    expect(s.screen).toBe(Screens.WIZARD);

    // Go to CONFIRM
    s = reducer(s, { type: 'NAV_NEXT' });
    s = reducer(s, { type: 'NAV_NEXT' });
    expect(s.screen).toBe(Screens.CONFIRM);

    // At CONFIRM, NAV_NEXT should do nothing (unless it starts run, but that's RUN_START)
    s = reducer(s, { type: 'NAV_NEXT' });
    expect(s.screen).toBe(Screens.CONFIRM);
  });

  test('checkpoint lifecycle: clearing pending on run end', () => {
    let s = createInitialState();
    s = reducer(s, { type: 'RUN_START' });
    s = reducer(s, { type: 'CHECKPOINT_REQUEST' });
    expect(s.checkpoint.pending).toBe(true);

    s = reducer(s, { type: 'RUN_FAILURE', error: 'Crashed' });
    expect(s.checkpoint.pending).toBe(false);
    expect(s.run.status).toBe('failure');
  });

  test('checkpoint lifecycle: only allow request when running', () => {
    let s = createInitialState();
    expect(s.screen).toBe(Screens.WIZARD);
    
    s = reducer(s, { type: 'CHECKPOINT_REQUEST' });
    // Invariant: checkpoint should not be pending if not in RUNNING screen
    expect(s.checkpoint.pending).toBe(false);
  });

  test('invalid state protection: RESULTS screen cannot have running status', () => {
    let s = createInitialState();
    // Force a weird state transition attempt if we were to just set screen to RESULTS while running
    // The reducer should prevent this if we try to jump there.
    // In our current reducer, only RUN_SUCCESS and RUN_FAILURE go to RESULTS.
    // Let's test that RUN_START doesn't allow RESULTS if we were already there (though we shouldn't be)
    
    // More importantly, we want to ensure that if we are in RESULTS, status is final.
    s = reducer(s, { type: 'RUN_START' });
    expect(s.screen).toBe(Screens.RUNNING);
    
    // Try to transition to RESULTS via some other means? 
    // Actually, let's just ensure RUN_SUCCESS/RUN_FAILURE are the only ways and they set status.
    s = reducer(s, { type: 'RUN_SUCCESS' });
    expect(s.screen).toBe(Screens.RESULTS);
    expect(s.run.status).not.toBe('running');
  });

  test('checkpoint request and resolve', () => {
    let s = createInitialState();
    s = reducer(s, { type: 'RUN_START' });

    s = reducer(s, { type: 'CHECKPOINT_REQUEST', checkpointType: 'before_subscribe' });
    expect(s.checkpoint.pending).toBe(true);

    s = reducer(s, { type: 'CHECKPOINT_RESOLVE', approved: true });
    expect(s.checkpoint.pending).toBe(false);
    expect(s.checkpoint.lastDecision).toBe(true);
  });

  test('vault screen navigation', () => {
    let s = createInitialState();
    expect(s.screen).toBe(Screens.WIZARD);

    // Open vault prompts
    s = reducer(s, { type: 'VAULT_OPEN' });
    expect(s.screen).toBe(Screens.VAULT);

    // Cancel from vault returns to wizard
    s = reducer(s, { type: 'VAULT_CANCEL' });
    expect(s.screen).toBe(Screens.WIZARD);

    // Unlock/Create success (simulated by NAV_NEXT from VAULT)
    s = reducer(s, { type: 'VAULT_OPEN' });
    expect(s.screen).toBe(Screens.VAULT);
    s = reducer(s, { type: 'NAV_NEXT' });
    expect(s.screen).toBe(Screens.PREFLIGHT);
  });
});
