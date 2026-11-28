/**
 * Knowledge graph Zod data schemas — define the structured contracts for all LLM output
 * Used together with StructuredOutputParser to enforce JSON output validation
 */
import { z } from 'zod/v3'

/** Entity type enum values (grouped by domain, covering all industries) */
const ENTITY_TYPES = [
  // General
  'person', // person
  'organization', // organization
  'concept', // concept/theory
  'event', // event
  'location', // location
  'other', // other
  // Technology/IT
  'technology', // technology/tool
  'product', // product/project
  'system', // framework/platform/system (management system, IT system, business platform)
  // Regulation/compliance
  'document', // document/license (contract, license, certificate, report, legal instrument)
  'standard', // standard/regulation/policy (technical standard, industry code, law, policy document)
  // Manufacturing/engineering
  'facility', // facility/equipment (nuclear facility, production equipment, building, infrastructure)
  'substance', // substance/material (chemical, radionuclide, raw material, drug)
  'process', // process/step/method (workflow, operating steps, manufacturing process)
  // Human resources
  'role', // role/position/job title
  'skill', // skill/ability
  // Data/analysis
  'measure', // measure/metric/parameter (KPI, technical indicator, monitoring data)
  // Narrative/fiction
  'artifact', // item/equipment
  'creature', // creature/species
  'realm' // rank/tier
] as const

/** Set of allowed entity types (for post-processing filtering, O(1) lookup) */
export const ALLOWED_ENTITY_TYPES: ReadonlySet<string> = new Set(ENTITY_TYPES)

/**
 * A single entity (relaxed: invalid type/confidence values are backstopped item by item in extraction post-processing —
 * fix: strict enum/min-max validation made the whole JSON block fail to parse on a single invalid item, so the whole
 * extraction was silently discarded and the subsequent per-item filtering logic never ran)
 */
export const EntitySchema = z.object({
  name: z.string().describe('canonical full name of the entity'),
  type: z.string().describe('entity type'),
  description: z.string().optional().describe('a concise description (≤ 15 words)'),
  confidence: z
    .number()
    .optional()
    .describe('confidence from 0 to 1, indicating how certain the entity extraction is')
})

/** Array of entities — used by entity extraction & gleaning */
export const EntitiesArraySchema = z.array(EntitySchema)

/** Merged entity (with metadata such as aliases) */
export const MergedEntitySchema = z.object({
  name: z.string().describe('canonical name'),
  type: z.string().describe('entity type'),
  description: z.string().optional().describe('combined description'),
  aliases: z.array(z.string()).optional().describe('list of aliases'),
  confidence: z.number().optional().describe('confidence from 0 to 1'),
  source_doc_ids: z.array(z.number()).optional().describe('list of source document IDs')
})

/** Result of entity disambiguation and merging */
export const EntityMergingResultSchema = z.object({
  merged: z.array(MergedEntitySchema).describe('list of merged entities'),
  removed_names: z.array(z.string()).describe('list of names that were merged away')
})

/** Relation type enum values (grouped by scenario, covering all industries) */
const RELATION_TYPES = [
  // Structure and hierarchy
  'contains', // A contains B
  'part_of', // A is part of B
  'is_a', // A is a kind of B (inheritance/instance)
  'located_in', // A is located in B
  // Dependency and causality
  'depends_on', // A depends on B
  'related_to', // A is related to B (generic association)
  'leads_to', // A leads to/produces B
  // Production and use
  'uses', // A uses/adopts B
  'creates', // A created/developed B
  'produces', // A produces/manufactures/outputs B
  'operates', // A operates/runs B
  // Ownership and control
  'owns', // A owns/holds B
  'acquires', // A acquires/obtains B
  'belongs_to', // A belongs to B (organization, group, faction)
  // Management and supervision
  'governs', // A governs/regulates/administer B
  'monitors', // A monitors/surveils/supervises B
  // Staffing and training
  'employs', // A employs/hires B
  'mentors', // A mentors/teaches/trains B
  // Narrative/fiction specific
  'friend_of', // A and B are friends/allies
  'enemy_of', // A and B are enemies/opponents
  'loves', // A loves/likes B
  'family_of', // A and B are relatives
  'fights', // A and B fight/conflict/oppose each other
  'kills' // A kills/defeats/eliminates B
] as const

/** Set of allowed relation types (for post-processing filtering, O(1) lookup) */
export const ALLOWED_RELATION_TYPES: ReadonlySet<string> = new Set(RELATION_TYPES)

/** A single relation (relaxed: invalid relation_type values are filtered in post-processing instead of failing the whole parse) */
export const RelationSchema = z.object({
  source: z.string().describe('source entity name'),
  target: z.string().describe('target entity name'),
  relation_type: z.string().describe('relation type'),
  description: z.string().optional().describe('a short relation description (≤ 15 words)')
})

/** Array of relations — used by relation extraction */
export const RelationsArraySchema = z.array(RelationSchema)

/** Unified extraction result (entities and relations output together) */
export const UnifiedExtractionSchema = z.object({
  entities: z.array(EntitySchema).describe('list of extracted entities'),
  relations: z.array(RelationSchema).describe('list of extracted relations')
})

// ========== Type inference ==========
export type EntityOutput = z.infer<typeof EntitySchema>
export type EntitiesArrayOutput = z.infer<typeof EntitiesArraySchema>
export type MergedEntityOutput = z.infer<typeof MergedEntitySchema>
export type EntityMergingResultOutput = z.infer<typeof EntityMergingResultSchema>
export type RelationOutput = z.infer<typeof RelationSchema>
export type RelationsArrayOutput = z.infer<typeof RelationsArraySchema>
export type UnifiedExtractionOutput = z.infer<typeof UnifiedExtractionSchema>
