import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import {
  ControllerRecordSchema,
  InviterRecordSchema,
  RunEventSchema,
  TargetRecordSchema,
  WorkspaceObservationSchema,
} from './schemas.js';

export async function loadJsonFile(filePath, fallbackValue) {
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallbackValue;
    }

    throw error;
  }
}

export async function saveJsonFile(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });

  const serializedValue = `${JSON.stringify(value, null, 2)}\n`;
  const tempFilePath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  try {
    await writeFile(tempFilePath, serializedValue, 'utf8');
    await rename(tempFilePath, filePath);
  } catch (error) {
    await rm(tempFilePath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function appendJsonl(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

const CollectionSchema = (itemSchema) => z.array(itemSchema);
const registryWriteQueues = new Map();

async function serializeRegistryMutation(filePath, operation) {
  const previousMutation = registryWriteQueues.get(filePath) ?? Promise.resolve();
  const currentMutation = previousMutation.catch(() => {}).then(operation);

  registryWriteQueues.set(filePath, currentMutation);

  try {
    return await currentMutation;
  } finally {
    if (registryWriteQueues.get(filePath) === currentMutation) {
      registryWriteQueues.delete(filePath);
    }
  }
}

function createCollectionHelpers({ stateDir, filename, schema, key }) {
  const filePath = path.join(stateDir, filename);
  const arraySchema = CollectionSchema(schema);

  async function list() {
    const records = await loadJsonFile(filePath, []);
    return arraySchema.parse(records);
  }

  async function upsert(update) {
    return serializeRegistryMutation(filePath, async () => {
      const records = await list();
      const index = records.findIndex((record) => record[key] === update[key]);
      const merged = index >= 0 ? schema.parse({ ...records[index], ...update }) : schema.parse(update);

      if (index >= 0) {
        records[index] = merged;
      } else {
        records.push(merged);
      }

      await saveJsonFile(filePath, records);
      return merged;
    });
  }

  return { list, upsert };
}

export function createPipelineStore({ stateDir }) {
  const controllers = createCollectionHelpers({
    stateDir,
    filename: 'controller_registry.json',
    schema: ControllerRecordSchema,
    key: 'id',
  });
  const targets = createCollectionHelpers({
    stateDir,
    filename: 'target_registry.json',
    schema: TargetRecordSchema,
    key: 'id',
  });
  const inviters = createCollectionHelpers({
    stateDir,
    filename: 'inviter_registry.json',
    schema: InviterRecordSchema,
    key: 'id',
  });
  const workspaceObservations = createCollectionHelpers({
    stateDir,
    filename: 'workspace_observations.json',
    schema: WorkspaceObservationSchema,
    key: 'workspaceId',
  });

  return {
    listControllers: controllers.list,
    upsertController: controllers.upsert,
    listTargets: targets.list,
    upsertTarget: targets.upsert,
    listInviters: inviters.list,
    upsertInviter: inviters.upsert,
    listWorkspaceObservations: workspaceObservations.list,
    upsertWorkspaceObservation: workspaceObservations.upsert,
    async appendRunEvent(event) {
      const parsedEvent = RunEventSchema.parse(event);
      await appendJsonl(path.join(stateDir, 'run_history.jsonl'), parsedEvent);
      return parsedEvent;
    },
  };
}
