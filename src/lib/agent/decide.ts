import { Decision } from './prompts';

export interface ParseResult {
  success: boolean;
  decisions: Decision[];
  rawText: string;
  error?: string;
}

const VALID_ACTIONS = ['enable', 'disable', 'delete', 'limit_update', 'hold'] as const;
type ValidAction = typeof VALID_ACTIONS[number];

/**
 * Parse LLM response text to Decision objects
 */
export function parseLLMResponse(response: string, expectedCount?: number): ParseResult {
  const rawText = response.trim();
  
  // Try to extract JSON from the response
  let jsonStr = extractJson(rawText);
  
  if (!jsonStr) {
    // Try to parse as multiple decisions
    const decisions = parseMultipleDecisions(rawText);
    if (decisions.length > 0) {
      return {
        success: true,
        decisions,
        rawText,
      };
    }
    
    return {
      success: false,
      decisions: [],
      rawText,
      error: 'Could not extract JSON from LLM response',
    };
  }
  
  try {
    const parsed = JSON.parse(jsonStr);
    
    // Single decision
    if (parsed.action) {
      const decision = parseSingleDecision(parsed);
      if (decision) {
        return {
          success: true,
          decisions: [decision],
          rawText,
        };
      }
    }
    
    // Multiple decisions (array or object with numeric keys)
    if (Array.isArray(parsed)) {
      const decisions = parsed
        .map(p => parseSingleDecision(p))
        .filter((d): d is Decision => d !== null);
      
      if (decisions.length > 0) {
        return {
          success: true,
          decisions,
          rawText,
        };
      }
    }
    
    // Object with numbered keys like "1", "2", etc.
    const numericDecisions = Object.values(parsed)
      .filter(v => typeof v === 'object' && v !== null)
      .map(v => parseSingleDecision(v as Record<string, unknown>))
      .filter((d): d is Decision => d !== null);
    
    if (numericDecisions.length > 0) {
      return {
        success: true,
        decisions: numericDecisions,
        rawText,
      };
    }
    
    return {
      success: false,
      decisions: [],
      rawText,
      error: 'No valid decisions found in JSON',
    };
  } catch (e) {
    return {
      success: false,
      decisions: [],
      rawText,
      error: `JSON parse error: ${e instanceof Error ? e.message : 'Unknown error'}`,
    };
  }
}

/**
 * Extract JSON from text that might have markdown code blocks
 */
function extractJson(text: string): string | null {
  // Try direct parse first
  try {
    JSON.parse(text);
    return text;
  } catch {
    // Continue with extraction
  }
  
  // Try to extract from markdown code blocks
  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    const content = jsonBlockMatch[1].trim();
    try {
      JSON.parse(content);
      return content;
    } catch {
      return null;
    }
  }
  
  // Try to find JSON object/array in text
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  
  let start = -1;
  if (firstBrace !== -1 && firstBracket !== -1) {
    start = Math.min(firstBrace, firstBracket);
  } else if (firstBrace !== -1) {
    start = firstBrace;
  } else if (firstBracket !== -1) {
    start = firstBracket;
  }
  
  if (start === -1) return null;
  
  // Find matching closing brace/bracket
  const char = text[start];
  const closing = char === '{' ? '}' : ']';
  let depth = 0;
  let end = -1;
  
  for (let i = start; i < text.length; i++) {
    if (text[i] === char) depth++;
    else if (text[i] === closing) depth--;
    
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
  
  if (end === -1) return null;
  
  const candidate = text.substring(start, end).trim();
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Parse a single decision object
 */
function parseSingleDecision(obj: Record<string, unknown>): Decision | null {
  if (!obj.action) return null;
  
  const action = normalizeAction(String(obj.action));
  if (!action) {
    console.warn('Invalid action:', obj.action);
    return null;
  }
  
  const confidence = parseConfidence(obj.confidence);
  const reasoning = parseReasoning(obj.reasoning);
  const params = parseParams(obj.params);
  
  return {
    action,
    params,
    reasoning,
    confidence,
  };
}

/**
 * Normalize action string to valid action
 */
function normalizeAction(action: string): Decision['action'] | null {
  const normalized = action.toLowerCase().trim().replace(/["']/g, '');
  
  if (VALID_ACTIONS.includes(normalized as ValidAction)) {
    return normalized as Decision['action'];
  }
  
  // Handle common variations
  const variations: Record<string, Decision['action']> = {
    'enable': 'enable',
    'resume': 'enable',
    'start': 'enable',
    'active': 'enable',
    'disable': 'disable',
    'pause': 'disable',
    'stop': 'disable',
    'inactive': 'disable',
    'delete': 'delete',
    'remove': 'delete',
    'limit_update': 'limit_update',
    'update': 'limit_update',
    'adjust': 'limit_update',
    'modify': 'limit_update',
    'hold': 'hold',
    'keep': 'hold',
    'maintain': 'hold',
    'no_change': 'hold',
    'skip': 'hold',
  };
  
  return variations[normalized] || null;
}

/**
 * Parse confidence value
 */
function parseConfidence(value: unknown): number {
  if (typeof value === 'number') {
    return Math.max(0, Math.min(1, value));
  }
  
  if (typeof value === 'string') {
    const num = parseFloat(value.replace(/[^0-9.-]/g, ''));
    if (!isNaN(num)) {
      return Math.max(0, Math.min(1, num));
    }
  }
  
  return 0.5; // Default confidence
}

/**
 * Parse reasoning string
 */
function parseReasoning(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  
  if (Array.isArray(value)) {
    return value.join(' ').trim();
  }
  
  if (value !== null && value !== undefined) {
    return String(value).trim();
  }
  
  return 'No reasoning provided';
}

/**
 * Parse params object
 */
function parseParams(value: unknown): Decision['params'] | null {
  if (!value) return null;
  
  if (typeof value !== 'object') return null;
  
  const params: Record<string, number | boolean> = {};
  const obj = value as Record<string, unknown>;
  
  const numericFields = [
    'position_sol', 'tip_sol', 'gas_sol', 'slippage',
    'high_gas_sol', 'high_gas_tip_sol', 'high_gas_slippage',
  ];
  
  const booleanFields = ['high_gas_mode'];
  
  for (const field of numericFields) {
    if (obj[field] !== undefined && obj[field] !== null) {
      const num = typeof obj[field] === 'number'
        ? obj[field]
        : parseFloat(String(obj[field]));
      if (!isNaN(num)) {
        params[field] = num;
      }
    }
  }
  
  for (const field of booleanFields) {
    if (obj[field] !== undefined && obj[field] !== null) {
      if (typeof obj[field] === 'boolean') {
        params[field] = obj[field];
      } else if (typeof obj[field] === 'string') {
        params[field] = obj[field].toLowerCase() === 'true';
      } else if (typeof obj[field] === 'number') {
        params[field] = obj[field] !== 0;
      }
    }
  }
  
  return Object.keys(params).length > 0 ? params : null;
}

/**
 * Parse multiple decisions from text format (### 决策 1, ### Decision 1, etc.)
 */
function parseMultipleDecisions(text: string): Decision[] {
  const decisions: Decision[] = [];
  
  // Match decision blocks
  const blockRegex = /###\s*(?:决策|Decision|Result)\s*\d+\s*([\s\S]*?)(?=###\s*(?:决策|Decision|Result)|$)/gi;
  let match;
  
  while ((match = blockRegex.exec(text)) !== null) {
    const block = match[1];
    const decision = parseDecisionBlock(block);
    if (decision) {
      decisions.push(decision);
    }
  }
  
  return decisions;
}

/**
 * Parse a single decision block
 */
function parseDecisionBlock(block: string): Decision | null {
  // Try to extract JSON
  const jsonStr = extractJson(block);
  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr);
      return parseSingleDecision(parsed);
    } catch {
      // Continue with text parsing
    }
  }
  
  // Fallback: try to extract fields from text
  const actionMatch = block.match(/action\s*[:=]\s*["']?(\w+)["']?/i);
  const confidenceMatch = block.match(/confidence\s*[:=]\s*([0-9.]+)/i);
  const reasoningMatch = block.match(/reasoning\s*[:=]\s*["']([^"']+)["']/i) ||
                        block.match(/reasoning\s*[:=]\s*([^\n]+)/i);
  
  if (!actionMatch) return null;
  
  const action = normalizeAction(actionMatch[1]);
  if (!action) return null;
  
  const decision: Decision = {
    action,
    params: null,
    reasoning: reasoningMatch ? reasoningMatch[1].trim() : 'Parsed from text',
    confidence: confidenceMatch ? parseConfidence(confidenceMatch[1]) : 0.5,
  };
  
  // Try to extract params from text
  const paramsBlock = block.match(/params\s*[:=]\s*(\{[^}]+\})/i);
  if (paramsBlock) {
    try {
      const parsedParams = JSON.parse(paramsBlock[1].replace(/'/g, '"'));
      decision.params = parseParams(parsedParams);
    } catch {
      // Ignore
    }
  }
  
  return decision;
}

/**
 * Validate decisions against expected count
 */
export function validateDecisions(
  decisions: Decision[],
  expectedCount: number
): { valid: boolean; message: string } {
  if (decisions.length === 0) {
    return { valid: false, message: 'No valid decisions found' };
  }
  
  if (decisions.length < expectedCount) {
    return {
      valid: true,
      message: `Only ${decisions.length}/${expectedCount} decisions parsed successfully`,
    };
  }
  
  if (decisions.length > expectedCount) {
    return {
      valid: true,
      message: `Warning: ${decisions.length} decisions found, expected ${expectedCount}. Using first ${expectedCount}.`,
    };
  }
  
  return { valid: true, message: 'OK' };
}
