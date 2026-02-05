import { PassThrough } from 'node:stream';
import stripAnsi from 'strip-ansi';
import { render as inkRender } from 'ink';

export function createInkTestHarness(tree, opts = {}) {
	const { columns = 100 } = opts;

	const stdout = new PassThrough();
	stdout.isTTY = true;
	stdout.columns = columns;
	stdout.rows = 40;
	const stderr = new PassThrough();
	stderr.isTTY = true;
	stderr.columns = columns;
	stderr.rows = 40;

	const stdin = new PassThrough();
	stdin.isTTY = true;
	stdin.setRawMode = () => {};
	stdin.ref = () => {};
	stdin.unref = () => {};

	let rawOut = '';
	let rawErr = '';

	stdout.on('data', (d) => {
		rawOut += d.toString('utf8');
	});
	stderr.on('data', (d) => {
		rawErr += d.toString('utf8');
	});

	const instance = inkRender(tree, {
		stdout,
		stderr,
		stdin,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});

	const getLastFrameRaw = () => {
		// Ink clears screen between frames. Take everything after last clear.
		const marker = '\u001B[2J';
		const idx = rawOut.lastIndexOf(marker);
		return idx >= 0 ? rawOut.slice(idx + marker.length) : rawOut;
	};

	return {
		stdin,
		stdout,
		stderr,
		rerender: instance.rerender,
		unmount: instance.unmount,
		cleanup: instance.cleanup,
		lastFrame: () => stripAnsi(getLastFrameRaw()),
		stderrText: () => stripAnsi(rawErr),
		write: (s) => stdin.write(s),
	};
}
