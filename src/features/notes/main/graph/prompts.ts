/**
 * 知识图谱 LLM Prompt 模板集中管理（含 few-shot 示例确保输出格式稳定）
 * 输出校验由 Zod + StructuredOutputParser 在 parse 阶段完成
 */

/** 实体消歧合并 Prompt */
export const ENTITY_MERGING_PROMPT = `You are a knowledge graph entity disambiguation assistant. Below is a list of entities extracted from multiple text segments. Analyze them and merge entities that refer to the same real-world thing.

Entity type definitions (type must be exactly one of the following 20 values; inventing new types is forbidden):
- person: a person
- organization: an organization (company, team, institution, gang, clan, group)
- concept: a concept or theory
- event: an event
- location: a location
- technology: a technology or tool
- product: a product or project
- system: a system (management system, IT system, business platform)
- document: a document (contract, license, certificate, report)
- standard: a standard, regulation, or policy (technical standard, industry code, law)
- facility: a facility or equipment (nuclear facility, production equipment, building, infrastructure)
- substance: a substance or material (chemical, radionuclide, raw material, drug)
- process: a process or method
- role: a role or position
- skill: a skill or ability
- measure: a measure, metric, or parameter (KPI, technical indicator, monitoring data)
- artifact: an item or equipment
- creature: a creature or species
- realm: a rank or tier
- other: other

Merging rules:
1. Identical names → merge directly (already handled by the caller; do not merge them again here)
2. Different names that clearly refer to the same entity → pick the most standard or most common name as the main name and keep the rest as aliases
   - "React" and "React.js" → merge into "React", aliases ["React.js"]
   - "Kubernetes" and "K8s" → merge into "Kubernetes", aliases ["K8s"]
   - "VS Code" and "Visual Studio Code" → merge into "Visual Studio Code", aliases ["VS Code"]
3. Names in different languages or scripts that refer to the same thing → merge them; keep the form that appears most often in the source text as the main name and the other forms as aliases
4. If you cannot determine whether two entities are the same → keep them separate
5. Keep the most detailed description for the merged entity
6. Take the maximum confidence for the merged entity
7. The merged type must be one of the types from the entities being merged, and must be one of the 20 values above

Entity list:
{entities}

Return a JSON object in the following format:
{
  "merged": [
    {
      "name": "canonical name",
      "type": "type",
      "description": "combined description",
      "aliases": ["alias1"],
      "confidence": 0.95,
      "source_doc_ids": [1, 2]
    }
  ],
  "removed_names": ["names that were merged away"]
}

Return only the JSON object (output the object directly; do not wrap it in a code block):`

/** Gleaning（遗漏实体补充抽取）Prompt */
export const ENTITY_GLEANING_PROMPT = `You previously extracted entities from the text below. Review it carefully once more and find the entities you may have missed the first time.
Return only entities that were not extracted last time; do not repeat entities that have already been extracted.

Entity type definitions (type must be exactly one of the following 20 values; inventing new types is forbidden):
- person: a person
- organization: an organization (company, team, institution, gang, clan, group)
- concept: a concept or theory
- event: an event
- location: a location
- technology: a technology or tool
- product: a product or project
- system: a system (management system, IT system, business platform)
- document: a document (contract, license, certificate, report)
- standard: a standard, regulation, or policy (technical standard, industry code, law)
- facility: a facility or equipment (nuclear facility, production equipment, building, infrastructure)
- substance: a substance or material (chemical, radionuclide, raw material, drug)
- process: a process or method
- role: a role or position
- skill: a skill or ability
- measure: a measure, metric, or parameter (KPI, technical indicator, monitoring data)
- artifact: an item or equipment
- creature: a creature or species
- realm: a rank or tier
- other: other

Entity names already extracted: {existing_entities}

Text:
{text}

Return only a JSON array, where each entity has the fields name, type, description, and confidence, in the same format as the first extraction:`

/** 统一实体+关系抽取 Prompt（一次调用同时输出实体和关系） */
export const ENTITY_RELATION_EXTRACTION_PROMPT = `You are a knowledge graph construction assistant. Extract all meaningful named entities, key concepts, and the relations between entities from the text below in a single pass.

Entity type definitions (type must be exactly one of the following 20 values; inventing new types is forbidden):
- person: a person (individual, character, fictional character)
- organization: an organization (company, team, institution, gang, clan, group)
- concept: a concept or theory (abstract concept, methodology, design pattern, algorithm, worldview)
- event: an event (meeting, launch, milestone, turning point, battle)
- location: a location (geographic region, town, planet, fictional world, natural area)
- technology: a technology or tool (programming language, framework, library, software, hardware, protocol)
- product: a product or project (concrete product, open-source project, application, work)
- system: a system (management system, IT system, business platform, quality system, feedback system)
- document: a document (contract, license, certificate, report, legal instrument, review opinion)
- standard: a standard, regulation, or policy (technical standard, industry code, law, policy document)
- facility: a facility or equipment (nuclear facility, production equipment, building, infrastructure, installation)
- substance: a substance or material (chemical, radionuclide, raw material, drug, effluent)
- process: a process or method (workflow, operating procedure, manufacturing process, method)
- role: a role or position (job title, post, role definition)
- skill: a skill or ability (professional skill, technical ability, talent, specialty, competence)
- measure: a measure, metric, or parameter (KPI, technical indicator, monitoring parameter, statistics)
- artifact: an item or equipment (weapon, armor, tool, important object, equipment)
- creature: a creature or species (non-human intelligent being, mythical creature, species)
- realm: a rank or tier (grade, tier, military rank, professional title, title of honor, level)
- other: other important entity

Relation type definitions (relation_type must be exactly one of the following 24 values; inventing new types is forbidden):
- contains: A contains B (A is the container, set, or module of B)
- part_of: A is part of B
- is_a: A is a kind of B (inheritance or instance)
- located_in: A is located in B
- depends_on: A depends on B
- related_to: A is related to B (generic association)
- leads_to: A leads to or produces B
- uses: A uses or adopts B
- creates: A created or developed B
- produces: A produces or manufactures B
- operates: A operates or runs B
- owns: A owns or holds B
- acquires: A acquires or obtains B (item, skill, resource, license)
- belongs_to: A belongs to B (organization, group, faction)
- governs: A governs, regulates, or administers B
- monitors: A monitors, surveils, or supervises B
- employs: A employs or hires B
- mentors: A mentors, teaches, trains, or assesses B
- friend_of: A is a friend, ally, or partner of B
- enemy_of: A is an enemy, opponent, or competitor of B
- loves: A loves or is attracted to B
- family_of: A is a relative or blood relation of B
- fights: A fights or conflicts with B
- kills: A kills, defeats, or eliminates B

Entity extraction requirements:
1. Extract only entities that clearly appear in the text; do not guess
2. Do not extract overly broad or generic words
3. When the entity type is uncertain, prefer the closest type; use "other" only when nothing fits
4. Return name (canonical full name), type, description (a concise description, ≤ 15 words), and confidence (0-1) for each entity. Keep names exactly as they appear in the source text and write the description in the same language as the source text
5. Confidence scoring: 0.9-1.0 = the entity name clearly appears and the context is clear; 0.7-0.89 = the entity name appears but the context is limited; 0.5-0.69 = the entity name is ambiguous or must be inferred; 0-0.49 = uncertain

Relation extraction requirements:
1. Return only relations with explicit textual evidence
2. Relation direction: source → target
3. source and target must be names from the entities list (exact match)
4. description briefly describes the relation (≤ 15 words), written in the same language as the source text

Example input:
"React is a front-end framework developed by Facebook. It uses JSX syntax, was open-sourced in 2013, and is currently at version 18.2. React is built around the virtual DOM and componentization."

Example output:
{
  "entities": [
    {"name": "React", "type": "technology", "description": "Front-end UI framework developed by Facebook", "confidence": 0.95},
    {"name": "Facebook", "type": "organization", "description": "Technology company behind Meta", "confidence": 0.95},
    {"name": "JSX", "type": "technology", "description": "Syntax extension for JavaScript", "confidence": 0.9},
    {"name": "Virtual DOM", "type": "concept", "description": "Lightweight DOM representation that speeds up rendering", "confidence": 0.85},
    {"name": "Componentization", "type": "concept", "description": "Splitting a UI into independent, reusable components", "confidence": 0.85}
  ],
  "relations": [
    {"source": "Facebook", "target": "React", "relation_type": "creates", "description": "Facebook created and open-sourced React"},
    {"source": "React", "target": "JSX", "relation_type": "uses", "description": "React uses JSX as its templating syntax"},
    {"source": "React", "target": "Virtual DOM", "relation_type": "uses", "description": "React uses the virtual DOM to optimize rendering"}
  ]
}

Text:
{text}

Return only the JSON object (output the object directly; do not wrap it in a code block):`

/** 增量跨块关系补全 Prompt（按 chunk 顺序推进，每次只比较当前 chunk 实体与已处理的前序实体） */
export const INCREMENTAL_CROSS_CHUNK_PROMPT = `You are a knowledge graph relation completion assistant. Group A entities appear in earlier sections of the document, and group B entities appear in the current section. Find the relations that may exist between group A and group B (A-B pairs and pairs within B are both allowed, but do not repeat relations within A — those have already been extracted).

Document title:
{docTitle}

Earlier-section entities (group A):
{previousEntities}

Current-section entities (group B):
{currentEntities}

Already discovered relations (do not extract them again):
{existingPairs}

Relation type definitions (relation_type must be exactly one of the following 24 values; no value outside this list is allowed):
- contains: A contains B
- part_of: A is part of B
- is_a: A is a kind of B
- located_in: A is located in B
- depends_on: A depends on B
- related_to: A is related to B
- leads_to: A leads to or produces B
- uses: A uses or adopts B
- creates: A created or developed B
- produces: A produces or manufactures B
- operates: A operates or runs B
- owns: A owns or holds B
- acquires: A acquires B
- belongs_to: A belongs to B
- governs: A governs, regulates, or administers B
- monitors: A monitors, surveils, or supervises B
- employs: A employs or hires B
- mentors: A mentors, teaches, or trains B
- friend_of: A is a friend or ally of B
- enemy_of: A is an enemy or opponent of B
- loves: A loves B
- family_of: A is a relative of B
- fights: A fights or conflicts with B
- kills: A kills B

Requirements:
1. Return only relations supported by reasonable inference
2. Do not repeat relations listed under "Already discovered relations"
3. source and target must be names from the given entity lists (exact match)
4. description briefly describes the relation (≤ 15 words), written in the same language as the source text
5. If there are genuinely no new cross-section relations, return an empty array []

Return only the JSON array (output the array directly; do not wrap it in a code block):`
