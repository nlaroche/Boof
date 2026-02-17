/**
 * Utility AI scoring system — data-driven decision making.
 *
 * Used for task selection, goal rotation, and any "pick the best option" decision.
 * Each decision is made by evaluating multiple weighted considerations (factors),
 * each returning a normalized 0-1 score. Scores are combined multiplicatively —
 * one zero kills the total (an impossible action scores 0).
 *
 * Every decision produces a ScoreBreakdown for debugging, logging, and UI display.
 */

import { assertScore } from './assert.js';

// ============================================================================
// Types
// ============================================================================

/** A single scoring factor — pure data + evaluation function */
export interface Consideration<T, Ctx = any> {
  /** Human-readable name (for logs, UI, debugging) */
  name: string;
  /** Description of what this factor measures (for agent docs) */
  description: string;
  /** Weight multiplier (default 1.0). Higher = more influence. */
  weight: number;
  /** Evaluate this factor for an item. MUST return 0-1. */
  evaluate: (item: T, ctx: Ctx) => number;
}

/** Score breakdown for a single item — explains WHY it scored what it did */
export interface ScoreBreakdown<T> {
  item: T;
  /** Final combined score */
  total: number;
  /** Per-factor breakdown */
  factors: {
    name: string;
    /** Raw score from evaluate() (0-1) */
    raw: number;
    /** After weight applied */
    weighted: number;
  }[];
}

// ============================================================================
// Core Scoring Functions
// ============================================================================

/**
 * Score a single item against multiple considerations.
 * Returns a full breakdown for debugging/logging.
 *
 * Scoring method: weighted geometric mean (multiplicative).
 * Each factor is raised to its weight, then multiplied together.
 * This means:
 * - A 0 on any factor = 0 total (hard veto)
 * - Higher weights amplify that factor's influence
 * - All factors contribute proportionally
 */
export function scoreItem<T, Ctx>(
  item: T,
  considerations: Consideration<T, Ctx>[],
  ctx: Ctx
): ScoreBreakdown<T> {
  if (considerations.length === 0) {
    return { item, total: 0, factors: [] };
  }

  const factors: ScoreBreakdown<T>['factors'] = [];
  let total = 1;

  for (const c of considerations) {
    const raw = c.evaluate(item, ctx);
    assertScore(raw, c.name);

    // Apply weight: score^weight (so weight=2 means squaring the score)
    const weighted = Math.pow(raw, 1 / c.weight);
    factors.push({ name: c.name, raw, weighted });
    total *= weighted;
  }

  return { item, total, factors };
}

/**
 * Score all items, return sorted by score (highest first).
 * Every item gets a full breakdown.
 */
export function rankItems<T, Ctx>(
  items: T[],
  considerations: Consideration<T, Ctx>[],
  ctx: Ctx
): ScoreBreakdown<T>[] {
  return items
    .map((item) => scoreItem(item, considerations, ctx))
    .sort((a, b) => b.total - a.total);
}

/**
 * Select the highest-scoring item.
 * Returns null if no items.
 */
export function selectBest<T, Ctx>(
  items: T[],
  considerations: Consideration<T, Ctx>[],
  ctx: Ctx
): { item: T; breakdown: ScoreBreakdown<T> } | null {
  if (items.length === 0) return null;
  const ranked = rankItems(items, considerations, ctx);
  return { item: ranked[0].item, breakdown: ranked[0] };
}

/**
 * Select from top N items with weighted randomization.
 * Good for adding variety while still favoring high scores.
 * Returns null if no items.
 */
export function selectWeighted<T, Ctx>(
  items: T[],
  considerations: Consideration<T, Ctx>[],
  ctx: Ctx,
  topN: number = 3
): { item: T; breakdown: ScoreBreakdown<T> } | null {
  if (items.length === 0) return null;

  const ranked = rankItems(items, considerations, ctx);
  const candidates = ranked.slice(0, Math.min(topN, ranked.length));

  // Weighted random selection: probability proportional to score
  const totalScore = candidates.reduce((sum, c) => sum + c.total, 0);
  if (totalScore === 0) {
    // All scores are 0, pick randomly
    const idx = Math.floor(Math.random() * candidates.length);
    return { item: candidates[idx].item, breakdown: candidates[idx] };
  }

  let random = Math.random() * totalScore;
  for (const candidate of candidates) {
    random -= candidate.total;
    if (random <= 0) {
      return { item: candidate.item, breakdown: candidate };
    }
  }

  // Fallback (shouldn't happen)
  const last = candidates[candidates.length - 1];
  return { item: last.item, breakdown: last };
}

// ============================================================================
// Utility Functions for Building Considerations
// ============================================================================

/** Normalize a value to 0-1 given min and max bounds */
export function normalize(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/** Inverse normalize: higher input → lower score (for penalties) */
export function inverseNormalize(value: number, min: number, max: number): number {
  return 1 - normalize(value, min, max);
}

/** Decay curve: score decreases over time. halfLife is in same units as age. */
export function decayCurve(age: number, halfLife: number): number {
  return Math.pow(0.5, age / halfLife);
}

/** Sigmoid curve: smooth 0→1 transition centered at midpoint */
export function sigmoid(value: number, midpoint: number, steepness: number = 1): number {
  return 1 / (1 + Math.exp(-steepness * (value - midpoint)));
}

/** Diminishing returns: 1 / (1 + count). count=0 → 1, count=1 → 0.5, count=2 → 0.33 */
export function diminishingReturns(count: number): number {
  return 1 / (1 + Math.max(0, count));
}
