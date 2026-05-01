import { z } from 'zod';

// Domain config schema used by the Rich TUI and orchestrator.
// IMPORTANT: Defaults must match the product design / implementation plan.

const RunSchema = z.object({
  headless: z.boolean().default(true),
  stealth: z.boolean().default(true),
  maxRunMs: z.number().default(300000),
  stepTimeoutMs: z.number().default(60000),
});

const IdentitySchema = z.object({
  email: z.string().email().optional(),
  password: z.string().optional(),
  otpTimeoutMs: z.number().default(60000),
});

const PlanSchema = z.object({
  seats: z.number().int().min(1).default(5),
  cadence: z.enum(['month', 'year']).default('month'),
});

const BillingSchema = z.object({
  cardNumber: z.string().optional(),
  expMonth: z.string().optional(),
  expYear: z.string().optional(),
  cvc: z.string().optional(),
  billingZip: z.string().optional(),
  billingCountry: z.string().optional(),
});

const SafetySchema = z.object({
  requireConfirmBeforeSubscribe: z.boolean().default(true),
  persistSecrets: z.boolean().default(false),
});

const ArtifactsSchema = z.object({
  outputDir: z.string().default('artifacts'),
});

// We use preprocess(v ?? {}, schema) so that:
// - missing objects default to {}
// - inner defaults (z.boolean().default(...)) are applied
export const AppConfigSchema = z.object({
  run: z.preprocess(v => v ?? {}, RunSchema),
  identity: z.preprocess(v => v ?? {}, IdentitySchema),
  plan: z.preprocess(v => v ?? {}, PlanSchema),
  billing: z.preprocess(v => v ?? {}, BillingSchema),
  safety: z.preprocess(v => v ?? {}, SafetySchema),
  artifacts: z.preprocess(v => v ?? {}, ArtifactsSchema),
});
