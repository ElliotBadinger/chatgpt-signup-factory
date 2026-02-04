import React from 'react';
import {render} from 'ink-testing-library';
import App from '../src/tui/App.js';

describe('TUI App', () => {
	it('renders the wizard as the initial screen', () => {
		const {lastFrame} = render(React.createElement(App));
		expect(lastFrame()).toContain('Config Wizard');
	});
});
