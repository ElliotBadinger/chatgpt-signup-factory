import React from 'react';
import {render} from 'ink';
import App from './App.js';

export function runTui({ configPath = 'config.yaml' } = {}) {
	render(React.createElement(App, { configPath }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	runTui();
}
