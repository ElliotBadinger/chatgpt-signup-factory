import path from 'node:path';

import { ensureArtifactDir, writeSummaryJson } from '../evidence/artifacts.js';

const AGENTMAIL_INBOXES_ENDPOINT = 'https://api.agentmail.to/v0/inboxes';

function redactApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return undefined;
  }

  return apiKey.slice(0, Math.min(5, apiKey.length));
}

function controllerArtifactDir(artifactDir, controller) {
  return path.join(artifactDir, controller.id);
}

async function writeStageArtifact({ artifactDir, controller, filename, payload }) {
  const dir = controllerArtifactDir(artifactDir, controller);
  await ensureArtifactDir(dir);
  const artifactPath = path.join(dir, filename);
  await writeSummaryJson(dir, payload);
  // writeSummaryJson always targets summary.json, so stage artifacts use a dedicated file too.
  await import('node:fs/promises').then(({ writeFile }) => writeFile(`${artifactPath}`, `${JSON.stringify(payload, null, 2)}
`, 'utf8'));
  return artifactPath;
}

function buildStageResult(baseResult, artifactPath, recordedAt) {
  return {
    ...baseResult,
    recordedAt,
    artifactPath,
  };
}

function createVerificationError({ status, bodySnippet }) {
  const error = new Error(`AgentMail API verification failed with status ${status}`);
  error.code = 'AGENTMAIL_API_KEY_VERIFICATION_FAILED';
  error.status = status;
  error.details = {
    endpoint: AGENTMAIL_INBOXES_ENDPOINT,
    bodySnippet,
  };
  return error;
}

async function verifyAgentMailApiKey({ fetchImpl, apiKey }) {
  const response = await fetchImpl(AGENTMAIL_INBOXES_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const bodySnippet = typeof response.text === 'function'
      ? (await response.text()).slice(0, 500)
      : '';
    throw createVerificationError({ status: response.status, bodySnippet });
  }

  return {
    ok: true,
    status: response.status,
    endpoint: AGENTMAIL_INBOXES_ENDPOINT,
  };
}

export function createStage1LiveHooks({
  artifactDir,
  now = () => new Date().toISOString(),
  fetchImpl = globalThis.fetch,
  mailAuthorityVerifier,
  controllerDriver,
  inboxCount = 0,
  inboxDisplayNamePrefix = 'Inbox',
} = {}) {
  if (!artifactDir) {
    throw new TypeError('createStage1LiveHooks requires artifactDir');
  }

  if (!fetchImpl) {
    throw new TypeError('createStage1LiveHooks requires fetchImpl');
  }

  if (!mailAuthorityVerifier?.verify) {
    throw new TypeError('createStage1LiveHooks requires mailAuthorityVerifier.verify');
  }

  if (!controllerDriver?.provision) {
    throw new TypeError('createStage1LiveHooks requires controllerDriver.provision');
  }

  if (!controllerDriver?.captureApiKey) {
    throw new TypeError('createStage1LiveHooks requires controllerDriver.captureApiKey');
  }

  const controllerState = new Map();

  async function verifyMailboxAuthority({ controller, store }) {
    const recordedAt = now();
    const verification = await mailAuthorityVerifier.verify({ controller, store });
    const payload = {
      controllerId: controller.id,
      controllerEmail: controller.email,
      stage: 'mailbox-verification',
      recordedAt,
      ...verification,
    };
    const artifactPath = await writeStageArtifact({
      artifactDir,
      controller,
      filename: 'mailbox-verification.json',
      payload,
    });

    return buildStageResult(verification, artifactPath, recordedAt);
  }

  async function createOrRecoverAgentMailController({ controller, store }) {
    const recordedAt = now();
    const provisioning = await controllerDriver.provision({ controller, store });
    const existing = controllerState.get(controller.id) ?? {};
    controllerState.set(controller.id, {
      ...existing,
      provisioning,
    });

    const payload = {
      controllerId: controller.id,
      controllerEmail: controller.email,
      stage: 'controller-provisioning',
      recordedAt,
      ...provisioning,
    };
    const artifactPath = await writeStageArtifact({
      artifactDir,
      controller,
      filename: 'controller-provisioning.json',
      payload,
    });

    return buildStageResult(provisioning, artifactPath, recordedAt);
  }

  async function captureApiKey({ controller, store }) {
    const recordedAt = now();
    const capture = await controllerDriver.captureApiKey({ controller, store });
    const verification = await verifyAgentMailApiKey({ fetchImpl, apiKey: capture.apiKey });
    const result = {
      source: capture.source,
      dashboardUrl: capture.dashboardUrl,
      verification,
      apiKeyPrefix: redactApiKey(capture.apiKey),
    };

    const existing = controllerState.get(controller.id) ?? {};
    controllerState.set(controller.id, {
      ...existing,
      apiKey: capture.apiKey,
      apiKeyCapture: result,
    });

    const payload = {
      controllerId: controller.id,
      controllerEmail: controller.email,
      stage: 'api-key-capture',
      recordedAt,
      ...result,
    };
    const artifactPath = await writeStageArtifact({
      artifactDir,
      controller,
      filename: 'api-key-capture.json',
      payload,
    });

    return buildStageResult(result, artifactPath, recordedAt);
  }

  async function createInboxes({ controller }) {
    const state = controllerState.get(controller.id) ?? {};
    if (!state.apiKey) {
      throw new Error(`No verified AgentMail API key recorded for ${controller.id}`);
    }

    const createdInboxIds = [];
    for (let index = 0; index < inboxCount; index += 1) {
      const displayName = `${inboxDisplayNamePrefix} ${index + 1}`;
      const response = await fetchImpl(AGENTMAIL_INBOXES_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${state.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ display_name: displayName }),
      });

      if (!response.ok) {
        const bodySnippet = typeof response.text === 'function'
          ? (await response.text()).slice(0, 500)
          : '';
        const error = new Error(`AgentMail inbox creation failed with status ${response.status}`);
        error.code = 'AGENTMAIL_INBOX_CREATION_FAILED';
        error.status = response.status;
        error.details = {
          endpoint: AGENTMAIL_INBOXES_ENDPOINT,
          bodySnippet,
          displayName,
        };
        throw error;
      }

      const body = await response.json();
      createdInboxIds.push(body.inbox_id);
    }

    const recordedAt = now();
    const result = {
      inboxCount: createdInboxIds.length,
      inboxIds: createdInboxIds,
    };
    const payload = {
      controllerId: controller.id,
      controllerEmail: controller.email,
      stage: 'inbox-creation',
      recordedAt,
      ...result,
    };
    const artifactPath = await writeStageArtifact({
      artifactDir,
      controller,
      filename: 'inbox-creation.json',
      payload,
    });

    return buildStageResult(result, artifactPath, recordedAt);
  }

  function getApiKeyForController(controllerId) {
    return controllerState.get(controllerId)?.apiKey ?? null;
  }

  return {
    verifyMailboxAuthority,
    createOrRecoverAgentMailController,
    captureApiKey,
    createInboxes,
    getApiKeyForController,
  };
}

export { AGENTMAIL_INBOXES_ENDPOINT };
