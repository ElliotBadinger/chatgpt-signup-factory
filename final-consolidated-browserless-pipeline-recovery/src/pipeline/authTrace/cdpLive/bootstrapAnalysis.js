function normalizeUrl(url = '') {
  return String(url || '');
}

export function buildBootstrapAnalysis({ criticalRequests = [], jsExceptions = [], challengeSignals = [] }) {
  const loginWith = criticalRequests.find((r) => /chatgpt\.com\/auth\/login_with/i.test(normalizeUrl(r.url))) ?? null;
  const followUpRequests = loginWith
    ? criticalRequests.slice(criticalRequests.indexOf(loginWith) + 1)
    : criticalRequests;
  const followUpFailures = followUpRequests.filter((r) => (typeof r.status === 'number' && r.status >= 400) || r.failureText);
  const restartedLogin = followUpRequests.find((r) => /chatgpt\.com\/api\/auth\/signin\/openai/i.test(normalizeUrl(r.url))) ?? null;

  let likelyFailurePoint = 'No clear failure point identified';
  if (challengeSignals.length) {
    likelyFailurePoint = 'Challenge/bot-detection signals appeared during ChatGPT bootstrap';
  } else if (jsExceptions.length) {
    likelyFailurePoint = 'JavaScript exception likely interrupted ChatGPT bootstrap after login_with';
  } else if (followUpFailures.length) {
    likelyFailurePoint = `Follow-up request failed after login_with: ${followUpFailures[0].url}`;
  } else if (restartedLogin) {
    likelyFailurePoint = 'ChatGPT restarted signin after login_with instead of completing app session bootstrap';
  } else if (loginWith) {
    likelyFailurePoint = 'login_with loaded but no successful app bootstrap evidence followed';
  }

  return {
    loginWith,
    followUpFailures,
    restartedLogin,
    jsExceptions,
    challengeSignals,
    likelyFailurePoint,
  };
}
