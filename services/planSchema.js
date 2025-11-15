// services/planSchema.js
'use strict';

const { CANONICAL_BRANCH, REPO_ROOT } = require('../config/constants');

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate the *shape* of a planner response object.
 * This does NOT do diff/path security checks (those stay in utils/diff),
 * it only enforces the JSON structure described in buildPlannerSystemPrompt.
 *
 * Returns: { ok: true } or { ok: false, error: '...' }.
 */
function validatePlanShape(plan) {
  // Top-level object
  if (!isPlainObject(plan)) {
    return { ok: false, error: 'plan_not_object' };
  }

  // schema: must be 1 for now
  if (plan.schema !== 1) {
    return { ok: false, error: 'schema_invalid' };
  }

  // id: non-empty string
  if (!isNonEmptyString(plan.id)) {
    return { ok: false, error: 'id_invalid' };
  }

  // status: keep generic (must be non-empty string)
  if (!isNonEmptyString(plan.status)) {
    return { ok: false, error: 'status_invalid' };
  }

  // goal: non-empty string
  if (!isNonEmptyString(plan.goal)) {
    return { ok: false, error: 'goal_invalid' };
  }

  // constraints
  const c = plan.constraints;
  if (!isPlainObject(c)) {
    return { ok: false, error: 'constraints_missing' };
  }

  if (!isNonEmptyString(c.base_branch)) {
    return { ok: false, error: 'constraints.base_branch_invalid' };
  }
  if (c.base_branch !== CANONICAL_BRANCH) {
    return { ok: false, error: 'constraints.base_branch_mismatch' };
  }

  if (!Array.isArray(c.allowed_ops) || c.allowed_ops.length === 0) {
    return { ok: false, error: 'constraints.allowed_ops_invalid' };
  }
  const allowedOps = new Set(['create', 'modify', 'delete']);
  for (const op of c.allowed_ops) {
    if (typeof op !== 'string' || !allowedOps.has(op)) {
      return { ok: false, error: 'constraints.allowed_ops_unsupported' };
    }
  }

  if (!isNonEmptyString(c.root_dir)) {
    return { ok: false, error: 'constraints.root_dir_invalid' };
  }
  if (c.root_dir !== REPO_ROOT) {
    return { ok: false, error: 'constraints.root_dir_mismatch' };
  }

  // steps[]
  if (!Array.isArray(plan.steps)) {
    return { ok: false, error: 'steps_not_array' };
  }

  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i];
    const prefix = `step_${i}`;

    if (!isPlainObject(s)) {
      return { ok: false, error: `${prefix}_not_object` };
    }

    if (!isNonEmptyString(s.type)) {
      return { ok: false, error: `${prefix}_type_invalid` };
    }

    if (s.type === 'patch') {
      // Minimal shape checks for patch steps; security is handled elsewhere
      if (!isNonEmptyString(s.message)) {
        return { ok: false, error: `${prefix}_message_invalid` };
      }
      if (!isNonEmptyString(s.base_branch)) {
        return { ok: false, error: `${prefix}_base_branch_invalid` };
      }
      if (!isNonEmptyString(s.diff)) {
        return { ok: false, error: `${prefix}_diff_missing` };
      }
      if (!s.diff.trim().startsWith('diff --git ')) {
        return { ok: false, error: `${prefix}_diff_not_unified` };
      }
      if (s.op != null && !allowedOps.has(s.op)) {
        return { ok: false, error: `${prefix}_op_invalid` };
      }
    } else if (s.type === 'commands') {
      // For commands steps, just require a steps field; runner validates details
      if (typeof s.steps === 'undefined') {
        return { ok: false, error: `${prefix}_commands_steps_missing` };
      }
    } else {
      return { ok: false, error: `${prefix}_type_unsupported` };
    }
  }

  // combined_diff / artifacts / telemetry are optional and can be null
  return { ok: true };
}

module.exports = { validatePlanShape };
