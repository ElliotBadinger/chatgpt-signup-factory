import { z } from 'zod';

const IsoDateTime = z.string().datetime({ offset: true });
const NonNegativeInt = z.number().int().nonnegative();
const EntityType = z.enum(['controller', 'target', 'inviter', 'workspace']);
const RunEventEntityType = z.enum(['controller', 'target', 'inviter']);
const MetadataRecord = z.record(z.string(), z.unknown());

export const ControllerStatus = z.enum([
  'pending',
  'ready',
  'active',
  'cooldown',
  'exhausted',
  'failed',
]);

export const TargetStatus = z.enum([
  'pending',
  'selected',
  'invited',
  'accepted',
  'skipped',
  'failed',
]);

export const InviterStatus = z.enum([
  'pending',
  'ready',
  'active',
  'cooldown',
  'exhausted',
  'failed',
]);

const RunEventStatusSchemas = {
  controller: ControllerStatus,
  target: TargetStatus,
  inviter: InviterStatus,
};

export const ControllerRecordSchema = z.object({
  id: z.string().min(1),
  status: ControllerStatus,
  email: z.string().email().optional(),
  successfulInviteCount: NonNegativeInt.optional(),
  lastSuccessfulTargetId: z.string().min(1).optional(),
  createdAt: IsoDateTime.optional(),
  updatedAt: IsoDateTime.optional(),
});

export const TargetRecordSchema = z.object({
  id: z.string().min(1),
  status: TargetStatus,
  email: z.string().email().optional(),
  controllerId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  invitedAt: IsoDateTime.optional(),
  createdAt: IsoDateTime.optional(),
  updatedAt: IsoDateTime.optional(),
});

export const InviterRecordSchema = z.object({
  id: z.string().min(1),
  status: InviterStatus,
  controllerId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  successfulInviteCount: NonNegativeInt.optional(),
  createdAt: IsoDateTime.optional(),
  updatedAt: IsoDateTime.optional(),
});

export const WorkspaceObservationSchema = z.object({
  workspaceId: z.string().min(1),
  observedAt: IsoDateTime,
  memberCount: NonNegativeInt.optional(),
  inviteCount: NonNegativeInt.optional(),
  hardCapReached: z.boolean(),
});

export const RunEventSchema = z
  .object({
    at: IsoDateTime,
    stage: z.string().min(1),
    entity_type: RunEventEntityType,
    entity_id: z.string().min(1),
    from_status: z.string().min(1),
    to_status: z.string().min(1),
    evidence: MetadataRecord.optional(),
    metadata: MetadataRecord.optional(),
  })
  .superRefine((event, context) => {
    const statusSchema = RunEventStatusSchemas[event.entity_type];

    if (!statusSchema) {
      return;
    }

    const fromStatusResult = statusSchema.safeParse(event.from_status);
    if (!fromStatusResult.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid from_status for ${event.entity_type}`,
        path: ['from_status'],
      });
    }

    const toStatusResult = statusSchema.safeParse(event.to_status);
    if (!toStatusResult.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid to_status for ${event.entity_type}`,
        path: ['to_status'],
      });
    }
  });

export const ControllerSchema = ControllerRecordSchema;
export const TargetSchema = TargetRecordSchema;
export const InviterSchema = InviterRecordSchema;
