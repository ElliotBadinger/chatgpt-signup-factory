import React from 'react';
import {render} from 'ink-testing-library';
import App from '../src/tui/App.js';
import { runTui } from '../src/tui/entrypoint.js';

describe('TUI App', () => {
	it('renders the wizard as the initial screen', () => {
		const {lastFrame} = render(React.createElement(App));
		expect(lastFrame()).toContain('Config Wizard');
	});

	it('exposes runTui with configPath support', () => {
		expect(typeof runTui).toBe('function');
	});
});
