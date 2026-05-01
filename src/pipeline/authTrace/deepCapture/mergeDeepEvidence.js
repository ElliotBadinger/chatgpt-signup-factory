export function buildRedirectChains(proxyFlows = []) {
  return proxyFlows
    .filter((flow) => Number(flow.responseStatus ?? flow.status) >= 300 && Number(flow.responseStatus ?? flow.status) < 400 && (flow.redirectLocation || flow.location))
    .map((flow) => ({
      from: flow.url,
      to: flow.redirectLocation ?? flow.location,
      status: flow.responseStatus ?? flow.status,
    }));
}

export function buildCookieChronology(proxyFlows = []) {
  return [...proxyFlows]
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
    .flatMap((flow) => (flow.setCookieNames ?? []).map((cookie) => ({
      ts: flow.ts ?? 0,
      url: flow.url,
      cookie,
    })));
}

export function mergeDeepEvidence({ proxyFlows = [], cdpEvents = [], browserTrace = [] }) {
  return { proxyFlows, cdpEvents, browserTrace };
}
