export const Screens = {
  WIZARD: 'wizard',
  PREFLIGHT: 'preflight',
  CONFIRM: 'confirm',
  RUNNING: 'running',
  RESULTS: 'results',
};

export function createInitialState() {
  return {
    screen: Screens.WIZARD,
    config: {},
    run: {
      status: 'idle', // idle | running | success | failure
      error: null,
    },
    checkpoint: {
      pending: false,
      type: null,
      lastDecision: null,
    },
  };
}

export function reducer(state, action) {
  switch (action.type) {
    case 'NAV_NEXT': {
      if (state.screen === Screens.WIZARD) return { ...state, screen: Screens.PREFLIGHT };
      if (state.screen === Screens.PREFLIGHT) return { ...state, screen: Screens.CONFIRM };
      return state;
    }
    case 'NAV_BACK': {
      if (state.screen === Screens.CONFIRM) return { ...state, screen: Screens.PREFLIGHT };
      if (state.screen === Screens.PREFLIGHT) return { ...state, screen: Screens.WIZARD };
      return state;
    }

    case 'RUN_START':
      return { ...state, screen: Screens.RUNNING, run: { status: 'running', error: null } };

    case 'RUN_SUCCESS':
      if (state.screen !== Screens.RUNNING) return state;
      return { ...state, screen: Screens.RESULTS, run: { status: 'success', error: null }, checkpoint: { ...state.checkpoint, pending: false } };

    case 'RUN_FAILURE':
      if (state.screen !== Screens.RUNNING) return state;
      return { ...state, screen: Screens.RESULTS, run: { status: 'failure', error: action.error || 'FAILED' }, checkpoint: { ...state.checkpoint, pending: false } };

    case 'CHECKPOINT_REQUEST':
      if (state.screen !== Screens.RUNNING) return state;
      return { ...state, checkpoint: { pending: true, type: action.checkpointType || null, lastDecision: null } };

    case 'CHECKPOINT_RESOLVE':
      if (!state.checkpoint.pending) return state;
      return { ...state, checkpoint: { ...state.checkpoint, pending: false, lastDecision: !!action.approved } };

    default:
      return state;
  }
}
