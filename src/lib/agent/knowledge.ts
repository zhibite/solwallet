'use server';

import { query } from '../db';

export interface KnowledgeEntry {
  id: number;
  category: string;
  title: string | null;
  content: string;
  is_recommended: boolean;
  is_mandatory: boolean;
  sort_order: number;
  is_active: boolean;
}

export interface KnowledgeCategory {
  category: string;
  mandatory: string[];
  recommended: string[];
}

/**
 * Load all active knowledge base entries
 */
export async function loadKnowledgeBase(): Promise<KnowledgeEntry[]> {
  const rows = await query<KnowledgeEntry>(
    `SELECT id, category, title, content, is_recommended, is_mandatory, sort_order, is_active
     FROM agent_knowledge
     WHERE is_active = TRUE
     ORDER BY category, sort_order, id`
  );
  
  return rows;
}

/**
 * Load knowledge entries by category
 */
export async function loadKnowledgeByCategory(category: string): Promise<KnowledgeEntry[]> {
  const rows = await query<KnowledgeEntry>(
    `SELECT id, category, title, content, is_recommended, is_mandatory, sort_order, is_active
     FROM agent_knowledge
     WHERE category = $1 AND is_active = TRUE
     ORDER BY sort_order, id`,
    [category]
  );
  
  return rows;
}

/**
 * Build knowledge context string for LLM prompt injection
 */
export async function buildKnowledgeContext(): Promise<string> {
  const entries = await loadKnowledgeBase();

  const mandatory = entries.filter(e => e.is_mandatory);
  const recommended = entries.filter(e => e.is_recommended && !e.is_mandatory);

  const lines: string[] = [];

  if (mandatory.length > 0) {
    lines.push('[强制规则]');
    mandatory.forEach((entry, idx) => {
      const prefix = entry.title ? `**${entry.title}**: ` : '';
      lines.push(`${idx + 1}. ${prefix}${entry.content}`);
    });
  }

  if (recommended.length > 0) {
    lines.push('');
    lines.push('[推荐规则]');
    recommended.forEach((entry, idx) => {
      const prefix = entry.title ? `**${entry.title}**: ` : '';
      lines.push(`${idx + 1}. ${prefix}${entry.content}`);
    });
  }

  return lines.join('\n');
}

/**
 * Add a new knowledge entry
 */
export async function addKnowledge(
  category: string,
  content: string,
  options?: {
    title?: string;
    isRecommended?: boolean;
    isMandatory?: boolean;
    sortOrder?: number;
  }
): Promise<KnowledgeEntry> {
  const { title, isRecommended = false, isMandatory = false, sortOrder = 0 } = options || {};
  
  const rows = await query<KnowledgeEntry>(
    `INSERT INTO agent_knowledge (category, title, content, is_recommended, is_mandatory, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [category, title || null, content, isRecommended, isMandatory, sortOrder]
  );
  
  return rows[0];
}

/**
 * Update a knowledge entry
 */
export async function updateKnowledge(
  id: number,
  updates: Partial<{
    title: string | null;
    content: string;
    isRecommended: boolean;
    isMandatory: boolean;
    sortOrder: number;
    isActive: boolean;
  }>
): Promise<KnowledgeEntry | null> {
  const setClauses: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [];
  let paramIndex = 1;
  
  if (updates.title !== undefined) {
    setClauses.push(`title = $${paramIndex++}`);
    values.push(updates.title);
  }
  if (updates.content !== undefined) {
    setClauses.push(`content = $${paramIndex++}`);
    values.push(updates.content);
  }
  if (updates.isRecommended !== undefined) {
    setClauses.push(`is_recommended = $${paramIndex++}`);
    values.push(updates.isRecommended);
  }
  if (updates.isMandatory !== undefined) {
    setClauses.push(`is_mandatory = $${paramIndex++}`);
    values.push(updates.isMandatory);
  }
  if (updates.sortOrder !== undefined) {
    setClauses.push(`sort_order = $${paramIndex++}`);
    values.push(updates.sortOrder);
  }
  if (updates.isActive !== undefined) {
    setClauses.push(`is_active = $${paramIndex++}`);
    values.push(updates.isActive);
  }
  
  values.push(id);
  
  const rows = await query<KnowledgeEntry>(
    `UPDATE agent_knowledge SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  
  return rows[0] || null;
}

/**
 * Delete a knowledge entry
 */
export async function deleteKnowledge(id: number): Promise<boolean> {
  const result = await query(
    `DELETE FROM agent_knowledge WHERE id = $1`,
    [id]
  );
  
  return (result as unknown[]).length > 0;
}

/**
 * Get all categories
 */
export async function getCategories(): Promise<string[]> {
  const rows = await query<{ category: string }>(
    `SELECT DISTINCT category FROM agent_knowledge WHERE is_active = TRUE ORDER BY category`
  );
  
  return rows.map(r => r.category);
}

/**
 * Get knowledge stats
 */
export async function getKnowledgeStats(): Promise<{
  total: number;
  byCategory: Record<string, number>;
  mandatory: number;
  recommended: number;
}> {
  const entries = await loadKnowledgeBase();
  
  const byCategory: Record<string, number> = {};
  let mandatory = 0;
  let recommended = 0;
  
  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
    if (entry.is_mandatory) mandatory++;
    if (entry.is_recommended) recommended++;
  }
  
  return {
    total: entries.length,
    byCategory,
    mandatory,
    recommended,
  };
}
