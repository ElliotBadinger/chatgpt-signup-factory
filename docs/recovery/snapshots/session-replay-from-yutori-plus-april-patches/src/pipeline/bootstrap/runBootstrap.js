import path from 'node:path';

import { writeHandoffBundle as defaultWriteHandoffBundle } from '../evidence/handoff.js';
import { assertControllerTransition } from '../shared/transitions.js';
import { createPipelineStore } from '../state/store.js';

function normalizeEmail(email) {
  if (typeof email !== 'string') {
    throw new TypeError('candidate root email must be a string');
  }

  const normalizedEmail = email.trim().toLowerCase();

  if (!normalizedEmail) {
    throw new TypeError('candidate root email must not be empty');
  }

  return normalizedEmail;
}

function buildControllerId(email) {
  return `controller-${email.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

function buildDryRunOutputs(email) {
  return {
    mailboxVerification: { dryRun: true, email },
    controllerProvisioning: { dryRun: true, email },
    apiKeyCapture: { dryRun: true, email },
    inboxCreation: { dryRun: true, email, inboxCount: 0 },
  };
}

function isBootstrapComplete(status) {
  return status !== 'pending' && status !== 'failed';
}

function buildBootstrapArtifactDir(artifactDir, controller) {
  return path.join(artifactDir, controller.id);
}

function extractProofPaths(outputs = {}) {
  return Object.values(outputs)
    .map((value) => value?.artifactPath)
    .filter((value) => typeof value === 'string' && value.length > 0);
}

function buildBootstrapHandoff({ stateDir, artifactDir, controller, outputs = {}, blocker }) {
  const target = controller.email ?? controller.id;

  return {
    target,
    inviter: 'bootstrap',
    inviteLink: '',
    proofPaths: extractProofPaths(outputs),
    status: controller.status,
    blocker,
    resumeCommand: `node src/cli/pipeline-bootstrap.js --state-dir ${stateDir} --artifact-dir ${artifactDir} --root ${target}`,
    statusCommand: `node src/cli/pipeline-status.js --state-dir ${stateDir}`,
  };
}

async function writeBootstrapHandoff({ stateDir, artifactDir, controller, outputs, blocker, writeHandoffBundle }) {
  if (!artifactDir) {
    return;
  }

  await writeHandoffBundle(
    buildBootstrapArtifactDir(artifactDir, controller),
    buildBootstrapHandoff({ stateDir, artifactDir, controller, outputs, blocker }),
  );
}

async function writeIncompleteBootstrapHandoffs({ store, stateDir, artifactDir, candidateRootEmails, writeHandoffBundle }) {
  if (!artifactDir) {
    return;
  }

  const candidateControllerIds = new Set(candidateRootEmails.map((email) => buildControllerId(normalizeEmail(email))));
  const controllers = await store.listControllers();
  const incompleteControllers = controllers.filter(
    (controller) => candidateControllerIds.has(controller.id) && !isBootstrapComplete(controller.status),
  );

  await Promise.all(
    incompleteControllers.map((controller) =>
      writeBootstrapHandoff({ stateDir, artifactDir, controller, writeHandoffBundle }),
    ),
  );
}

async function runLiveHooks({ controller, store, verifyMailboxAuthority, createOrRecoverAgentMailController, captureApiKey, createInboxes }) {
  const mailboxVerification = await verifyMailboxAuthority({ controller, store });
  const controllerProvisioning = await createOrRecoverAgentMailController({ controller, store });
  const apiKeyCapture = await captureApiKey({ controller, store });
  const inboxCreation = await createInboxes({ controller, store });

  return {
    mailboxVerification,
    controllerProvisioning,
    apiKeyCapture,
    inboxCreation,
  };
}

export async function runBootstrap({
  stateDir,
  artifactDir,
  store = stateDir ? createPipelineStore({ stateDir }) : undefined,
  candidateRootEmails = [],
  dryRun = false,
  now = () => new Date().toISOString(),
  writeHandoffBundle = defaultWriteHandoffBundle,
  verifyMailboxAuthority = async ({ controller }) => ({ placeholder: 'verifyMailboxAuthority', controllerId: controller.id }),
  createOrRecoverAgentMailController = async ({ controller }) => ({ placeholder: 'createOrRecoverAgentMailController', controllerId: controller.id }),
  captureApiKey = async ({ controller }) => ({ placeholder: 'captureApiKey', controllerId: controller.id }),
  createInboxes = async ({ controller }) => ({ placeholder: 'createInboxes', controllerId: controller.id, inboxIds: [] }),
} = {}) {
  if (!store) {
    throw new TypeError('runBootstrap requires either a store or stateDir');
  }

  const controllers = [];
  const existingControllers = new Map((await store.listControllers()).map((controller) => [controller.id, controller]));

  for (const candidateEmail of candidateRootEmails) {
    const email = normalizeEmail(candidateEmail);
    const controllerId = buildControllerId(email);
    const existingController = existingControllers.get(controllerId);

    if (existingController && isBootstrapComplete(existingController.status)) {
      continue;
    }

    const timestamp = now();
    const pendingController = {
      ...existingController,
      id: controllerId,
      email,
      status: 'pending',
      successfulInviteCount: existingController?.successfulInviteCount ?? 0,
      createdAt: existingController?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    await store.upsertController(pendingController);

    try {
      const outputs = dryRun
        ? buildDryRunOutputs(email)
        : await runLiveHooks({
            controller: pendingController,
            store,
            verifyMailboxAuthority,
            createOrRecoverAgentMailController,
            captureApiKey,
            createInboxes,
          });

      assertControllerTransition(pendingController.status, 'ready');

      const readyController = {
        ...pendingController,
        status: 'ready',
        updatedAt: timestamp,
      };

      await store.upsertController(readyController);
      await store.appendRunEvent({
        at: timestamp,
        stage: 'bootstrap',
        entity_type: 'controller',
        entity_id: readyController.id,
        from_status: pendingController.status,
        to_status: readyController.status,
        metadata: {
          dryRun,
          email,
          ...outputs,
        },
      });

      existingControllers.set(readyController.id, readyController);
      await writeBootstrapHandoff({
        stateDir,
        artifactDir,
        controller: readyController,
        outputs,
        writeHandoffBundle,
      });
      controllers.push({ ...readyController, outputs });
    } catch (error) {
      assertControllerTransition(pendingController.status, 'failed');

      const failedController = {
        ...pendingController,
        status: 'failed',
        updatedAt: timestamp,
      };

      await store.upsertController(failedController);
      await store.appendRunEvent({
        at: timestamp,
        stage: 'bootstrap',
        entity_type: 'controller',
        entity_id: failedController.id,
        from_status: pendingController.status,
        to_status: failedController.status,
        metadata: {
          dryRun,
          email,
          error: error instanceof Error ? error.message : String(error),
        },
      });

      existingControllers.set(failedController.id, failedController);
      await writeIncompleteBootstrapHandoffs({
        store,
        stateDir,
        artifactDir,
        candidateRootEmails,
        writeHandoffBundle,
      });

      throw error;
    }
  }

  return {
    dryRun,
    controllers,
  };
}
