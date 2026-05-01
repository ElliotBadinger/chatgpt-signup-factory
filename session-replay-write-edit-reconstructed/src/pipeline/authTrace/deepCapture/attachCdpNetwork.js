export async function attachCdpNetwork({ page, writer }) {
  const client = await page.target().createCDPSession();
  await client.send('Network.enable');

  for (const event of [
    'Network.requestWillBeSent',
    'Network.responseReceived',
    'Network.loadingFinished',
    'Network.loadingFailed',
    'Network.requestWillBeSentExtraInfo',
    'Network.responseReceivedExtraInfo',
  ]) {
    client.on(event, async (payload) => {
      await writer.write({ type: 'cdp-network', event, payload });
    });
  }

  return {
    client,
    async detach() {
      await client.detach();
    },
  };
}
